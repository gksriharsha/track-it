package com.kgundu1.trackit

import android.app.Activity
import android.view.WindowManager
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * How `evaluateJavascript`'s answer is read, and which way it fails.
 *
 * `evaluateJavascript` hands back JSON, so a page that says yes says it as the
 * four characters `true` and nothing else counts: a `null` from a WebView that
 * has not booted, an `"undefined"`, a thrown error, even a JavaScript STRING
 * reading "true" — which arrives quoted — all mean let the screen sleep. That
 * is the safe direction, and it is the same rule `MainActivity` already
 * applies to the back gesture, for the same reason: a broken front end must
 * never be able to leave the phone burning its screen on a kitchen counter all
 * night.
 */
internal fun wantsScreenHeld(evaluated: String?): Boolean = evaluated == "true"

/**
 * The one owner of `FLAG_KEEP_SCREEN_ON`.
 *
 * There is exactly one window and exactly one flag on it, so there is exactly
 * one object that touches it. Two callers reaching for the same window flag is
 * how a flag ends up stuck on, and a flag stuck on is a phone that burns its
 * screen all night — a worse bug than the sleeping screen this whole feature
 * exists to fix.
 *
 * The window is looked up at the moment of use rather than captured once.
 * `KeepAwakePlugin` is constructed exactly once, by JNI, with whichever
 * Activity existed then, and Android recreates activities for reasons the
 * manifest's `configChanges` does not cover — a display-size change, or the
 * developer setting "Don't keep activities". A captured Activity would leave
 * `addFlags` writing to a destroyed window and doing nothing at all, silently.
 *
 * Everything here runs on the main thread and nothing here blocks.
 */
object ScreenAwake {
    private val FLAG = WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON

    /**
     * The activity currently in the foreground, or null while none is.
     *
     * Volatile because a plugin command may be dispatched from a thread that
     * is not the main one, and it reads this before hopping across.
     */
    @Volatile
    private var foreground: Activity? = null

    /** Called by `MainActivity.onResume`, which is when a window exists to hold. */
    fun attach(activity: Activity) {
        foreground = activity
    }

    /** Called by `MainActivity.onPause`, after the flag has been cleared. */
    fun detach() {
        foreground = null
    }

    fun current(): Activity? = foreground

    /**
     * Set or clear the flag on whatever window is on screen.
     *
     * A request that arrives with nothing on screen is dropped rather than
     * queued, and that is correct in both directions: Android ignores the flag
     * on a backgrounded app anyway, and [restoreFrom] asks the web app again
     * the moment the app comes back.
     */
    fun set(on: Boolean) {
        val window = foreground?.window ?: return
        if (on) window.addFlags(FLAG) else window.clearFlags(FLAG)
    }

    /**
     * Put the flag back the way the LIVE web app wants it, having cleared it on
     * the way out.
     *
     * The web app is asked rather than remembered, and that is the whole point
     * of doing it this way. A remembered answer goes stale in exactly the case
     * that matters: the WebView replaces its document — which `tauri android
     * dev` does on every front-end edit, and which a renderer restart does in
     * the field — and the screen that asked for the flag is gone while the
     * remembered "yes" is not. A fresh document has no `__keepAwake` at all, so
     * the answer is no and the flag stays off until something on screen asks
     * for it again.
     *
     * See [wantsScreenHeld] for why anything other than a literal `true` is
     * read as no.
     */
    fun restoreFrom(webView: WebView) {
        webView.evaluateJavascript(
            "(function(){try{return window.__keepAwake===true}catch(e){return false}})()"
        ) { result ->
            set(wantsScreenHeld(result))
        }
    }
}

/**
 * The wire shape. Its field is a `var` because Jackson writes it directly —
 * `PluginManager` configures the mapper with `PropertyAccessor.FIELD` set to
 * `Visibility.ANY` — and the class matches `VisionImageArgs` next door rather
 * than inventing a second convention. Public, so that R8's
 * `-keep @app.tauri.annotation.InvokeArg public class *` consumer rule matches
 * it in the minified release build.
 */
@InvokeArg
class KeepAwakeArgs {
    var on: Boolean = false
}

/**
 * Holding the screen open while the phone is propped against the scale.
 *
 * This is the window flag, not a `PowerManager.WakeLock`, and the difference
 * is the reason for the choice. The flag needs no permission at all, so
 * AndroidManifest.xml is untouched; and Android's own guidance is that an app
 * holding it goes back to the ordinary timeout the moment it is in the
 * background. A `PowerManager` lock has neither courtesy.
 *
 * Note what this class is NOT. It holds no state and makes no decisions:
 * whether the screen should be open is settled in `src/lib/awake.ts`, which is
 * the only thing that knows how many screens are asking and whether anybody
 * has touched the phone lately. This end just does as it is told, and hands
 * the doing to [ScreenAwake].
 *
 * Absent and staying absent: an `onPause` override. `Plugin.onPause` looks like
 * the obvious place to clear the flag and it is DEAD code in this app — its
 * only caller is `PluginManager.onPause`, whose only caller is
 * `TauriLifecycleObserver` in the generated `TauriActivity.kt`, and nothing
 * registers that observer: `WryActivity.onCreate` registers
 * `WryLifecycleObserver`, a different object that drives the Rust side only.
 * `VisionPlugin.onDestroy` works and misleads, because `TauriActivity`
 * overrides `onDestroy` itself. `Plugin.load` is no better a home: it is
 * guarded by `!plugin.loaded` and so runs once per WebView, never per
 * document. The net that actually runs lives in `MainActivity`, where the
 * Activity's own `onPause` and `onResume` are real callbacks, and the
 * document-reload case is covered from the page itself as it boots.
 *
 * Deliberately no executor either, unlike `VisionPlugin`. That class hands its
 * work to a background thread because OCR on the main thread is jank; here the
 * main thread is exactly where the work has to happen, since `Window.addFlags`
 * reaches ViewRootImpl and throws `CalledFromWrongThreadException` off it.
 */
@TauriPlugin
class KeepAwakePlugin(activity: Activity) : Plugin(activity) {

    @Command
    fun keepAwake(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(KeepAwakeArgs::class.java)
        } catch (error: Exception) {
            invoke.reject("could not read the screen request", error)
            return
        }

        // Nothing on screen: succeed and do nothing. `MainActivity.onResume`
        // will ask the web app what it wants the moment the app is back in
        // front of someone, so the answer cannot be lost — only deferred.
        val host = ScreenAwake.current() ?: run {
            invoke.resolve()
            return
        }

        // `runOnUiThread` runs inline when it is already on the UI thread,
        // which a plugin command normally is. It is here for the case where it
        // is not, because the failure without it is an exception thrown from
        // deep inside the view system rather than anything a reader would
        // connect to this line.
        host.runOnUiThread {
            try {
                ScreenAwake.set(args.on)
                // `resolve()` with no argument sends a literal `null`, which is
                // what deserialises into Rust's `()`. `resolve(JSObject())`
                // would not.
                invoke.resolve()
            } catch (error: Exception) {
                invoke.reject("could not change how long the screen stays on", error)
            }
        }
    }
}
