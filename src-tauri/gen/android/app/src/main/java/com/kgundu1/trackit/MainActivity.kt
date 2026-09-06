package com.kgundu1.trackit

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

/**
 * The app's activity, with one thing replaced: how the system Back gesture is
 * answered.
 *
 * Wry's own handler asks `webView.canGoBack()`, which reads the WebView's
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
 */
class MainActivity : TauriActivity() {
  /** Wry must not install its `canGoBack()` handler; the one below replaces it. */
  override val handleBackNavigation: Boolean = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * Called by `WryActivity.setWebView` once the WebView exists, which is why
   * the callback is registered here rather than in `onCreate` — there is
   * nothing to ask before this point.
   */
  override fun onWebViewCreate(webView: WebView) {
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
}
