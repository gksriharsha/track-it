package com.kgundu1.trackit

import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import com.kgundu1.trackit.widget.WidgetLanding
import com.kgundu1.trackit.widget.WidgetWatch

/**
 * The app's activity, with three things added to it: how the system Back
 * gesture is answered, who clears the keep-screen-on flag when the app goes
 * away, and how a tap on a home-screen widget finds its way to a screen.
 *
 * Wry's own back handler asks `webView.canGoBack()`, which reads the WebView's
 * NATIVE back-forward list. Every screen change in this app is a hash change —
 * a same-document navigation — and those never enter that list, so the answer
 * is always "no" and Back closes the app from every screen instead of going
 * back one. Turning `handleBackNavigation` off and asking the web app directly
 * is the fix; both of those are extension points Wry provides on purpose.
 *
 * The web app answers on `window.__androidBack()` (see `useHashRoute` in
 * App.tsx): true when it consumed the gesture, false when it has nowhere left
 * to go. Anything other than a literal `true` — a missing function, a thrown
 * error, a page that has not booted — falls through to closing the app, so a
 * broken front end can never leave the user trapped in a window they cannot
 * dismiss.
 *
 * The screen flag is here for a duller reason: this is the only place in the
 * app where an Activity pause is actually observed. `Plugin.onPause` is never
 * called — see the note on `KeepAwakePlugin` — so a plugin that cleared the
 * flag there would be dead code and the flag would outlive the app's turn in
 * the foreground. See [onPause] and [onResume].
 */
class MainActivity : TauriActivity() {
  /** Wry must not install its `canGoBack()` handler; the one below replaces it. */
  override val handleBackNavigation: Boolean = false

  /**
   * Kept because `WryActivity.mWebView` is private and two things here have to
   * reach the live page: [onResume] asks it whether the screen should still be
   * held, and a warm relaunch from a widget tap wakes it. Null only in the
   * window between `onCreate` and the WebView existing, where there is nothing
   * to ask and nothing to poke.
   */
  private var page: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // The doorbell that turns a snapshot Rust has written into a repainted tile.
    // Started here rather than in `onResume` so a snapshot written while the app
    // sits in the background — the settle after a burst of logging, say — still
    // reaches the home screen.
    WidgetWatch.start(this)

    /*
      A cold start's widget tap, parked for the front end to pull once it has
      mounted. Writing a hash from here would be dropped: the document does not
      exist yet.

      Gated on there being no saved state, and the gate is the whole point.
      `android:configChanges` lists neither `density` nor `fontScale`, so
      changing the system font size destroys and rebuilds this Activity — and
      `getIntent()` then still returns the widget's Intent, precisely because
      `onNewIntent` below calls `setIntent`. Without the gate, a font-size change
      would re-offer a tap the user made an hour ago and navigate them away from
      whatever they were doing. The file Rust deletes on reading is the second
      half of the same guarantee; this is the half that does not depend on Rust
      having got there first.
    */
    if (savedInstanceState == null) WidgetLanding.park(this, intent)
  }

  /**
   * The reason this override exists at all.
   *
   * `launchMode` is `singleTask`, so a widget tap on an already-running app
   * arrives here rather than in `onCreate` — and Android does NOT update
   * `getIntent()` for you. Neither the generated `WryActivity.onNewIntent` nor
   * `TauriActivity.onNewIntent` calls `setIntent`, so without this first line
   * every later read of `intent` would still see the one the app was FIRST
   * launched with, and a second tap would replay the previous food.
   *
   * The page is definitely up by the time this runs, so it is woken directly.
   * What is handed over is nothing at all — just the news that there is
   * something to take, which the front end then reads from Rust like it does on
   * a cold start. Keeping the Intent's own strings out of JavaScript means there
   * is one validation path rather than two, and `MainActivity` is exported.
   */
  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    super.onNewIntent(intent)
    if (!WidgetLanding.park(this, intent)) return
    val view = page ?: return
    view.post {
      view.evaluateJavascript(
        "(function(){try{window.__widgetTap&&window.__widgetTap()}catch(e){}})()",
        null,
      )
    }
  }

  /**
   * The app is in front of someone again, so a window exists to hold open, and
   * whether it should be held is a question only the live page can answer.
   *
   * `super.onResume()` first, because it is what resumes the WebView — asking
   * a paused WebView to evaluate JavaScript would never call back.
   */
  override fun onResume() {
    super.onResume()
    ScreenAwake.attach(this)
    page?.let { ScreenAwake.restoreFrom(it) }
  }

  /**
   * The app is leaving the foreground, so the flag goes with it.
   *
   * Android already ignores `FLAG_KEEP_SCREEN_ON` on a backgrounded app, so in
   * the ordinary case this changes nothing about the battery. What it covers is
   * the case where the page never comes back to release it — the WebView was
   * destroyed, its renderer restarted, the process was killed mid-cook — and
   * something has to be the thing that guarantees a flag cannot outlive the
   * page that asked for it. Cleared BEFORE `super.onPause()`, which is what
   * freezes the WebView's JavaScript: after that the page could not be asked
   * anything and the front end's own release could not run.
   */
  override fun onPause() {
    ScreenAwake.set(false)
    ScreenAwake.detach()
    super.onPause()
  }

  /**
   * Called by `WryActivity.setWebView` once the WebView exists, which is why
   * the callback is registered here rather than in `onCreate` — there is
   * nothing to ask before this point.
   */
  override fun onWebViewCreate(webView: WebView) {
    page = webView
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          // evaluateJavascript is asynchronous and its result is JSON, so a
          // consumed gesture comes back as the four characters `true`. The
          // callback runs on the UI thread, so finishing from it is safe.
          webView.evaluateJavascript(
            "(function(){try{return !!(window.__androidBack&&window.__androidBack())}catch(e){return false}})()"
          ) { result ->
            if (result != "true") {
              // Nothing left to go back to: let the default behaviour run,
              // disabling this callback so the dispatcher does not hand the
              // event straight back to it.
              isEnabled = false
              onBackPressedDispatcher.onBackPressed()
              isEnabled = true
            }
          }
        }
      },
    )
  }

  override fun onDestroy() {
    // Before `super`, which is where Tauri tears its plugins down. An inotify
    // watch left running past the Activity that owns it would hold a reference
    // to the application context for the life of the process and keep sending
    // broadcasts nobody asked for.
    WidgetWatch.stop()
    page = null
    super.onDestroy()
  }
}
