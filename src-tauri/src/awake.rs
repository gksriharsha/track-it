//! Holding the device's screen open while a pot is being weighed.
//!
//! The case is the kitchen and nothing else: the phone is propped against the
//! scale, hands are wet or floury, and the screen sleeps in the twenty seconds
//! between putting the katori down and reading what it says. Waking a phone
//! with the back of a knuckle is the sort of small indignity nobody reports as
//! a bug and everybody works around.
//!
//! This is Android's `FLAG_KEEP_SCREEN_ON` window flag, NOT the Web Screen
//! Wake Lock API and NOT a `PowerManager.WakeLock`. Each of those was
//! considered and each loses on a different point. A `PowerManager` lock needs
//! the `WAKE_LOCK` permission and keeps burning after the app is gone; the
//! window flag needs no permission at all, which is why `AndroidManifest.xml`
//! is untouched, and Android's own guidance is that the flag goes inert once
//! the app is in the background. `navigator.wakeLock` needs no native code
//! whatsoever, which is genuinely tempting — but it also exists in WKWebView,
//! so the identical JavaScript would quietly stop the user's Mac going to
//! sleep, and the requirement is that everything except Android is a no-op.
//! Doing it here makes that true by `#[cfg]`, which the compiler keeps; doing
//! it in TypeScript would make it true until somebody edited the branch.
//!
//! Note what this module is NOT. It holds no opinion about when the screen
//! should stay open, and it remembers NOTHING. `src/lib/awake.ts` is the only
//! thing that knows how many screens are asking and whether anybody has
//! touched the phone lately, and `KeepAwakePlugin.kt` is the only thing that
//! knows what the window flag currently is. All that lives here is the
//! crossing itself.
//!
//! That emptiness is deliberate and it replaced something. A record of "what
//! the flag was last set to" was written here first, so that a request which
//! would change nothing could skip the blocking hop to Android's main thread.
//! It is a trap. `MainActivity` clears the flag itself when the app leaves the
//! foreground and puts it back by asking the live page on the way in — both
//! without passing through Rust — so a memory kept on this side goes stale
//! against the window it is describing. The failure it buys is the worst one
//! available: the next genuine request looks redundant, gets skipped, and the
//! screen sleeps during a weighing with nothing anywhere saying why. The
//! coalescing that actually matters happens in `awake.ts`, one document at a
//! time, where a stale answer cannot outlive the page that formed it. This
//! paragraph exists to stop the cache being reintroduced.

/// The command name the Kotlin `@Command` method is registered under.
///
/// One place, because a typo here is not a compile error on either side of the
/// bridge — it is a rejected invoke at runtime, on a device.
// Only the Android arm crosses anything, and the macOS build should not warn
// about a name that is waiting for the one platform with a window flag to set.
// The tests below are compiled everywhere, so they run wherever the suite does.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const KEEP_AWAKE: &str = "keepAwake";

/// The whole of the wire shape: which way round the flag is going.
///
/// Built in one function, and tested, because the field name and the field's
/// TYPE are both load-bearing in a way nothing will catch on the way past.
/// Kotlin reads this into `KeepAwakeArgs`, whose `on` defaults to `false`, and
/// `PluginManager`'s mapper is configured with `FAIL_ON_UNKNOWN_PROPERTIES`
/// DISABLED. So a renamed or omitted key does not fail — it silently arrives
/// as "let the screen sleep", which reads as the feature simply not working.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn request(on: bool) -> serde_json::Value {
    serde_json::json!({ "on": on })
}

/// The Android half is a small Tauri mobile-plugin bridge, in the same shape
/// as [`crate::vision`]'s. The window and the flag on it live in the Android
/// source set; this module only says on or off and waits for the answer.
#[cfg(target_os = "android")]
mod android {
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    use super::{request, KEEP_AWAKE};

    const PLUGIN_IDENTIFIER: &str = "com.kgundu1.trackit";

    pub(super) struct AndroidAwake<R: Runtime>(PluginHandle<R>);

    pub(super) fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("awake")
            .setup(|app, api| {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "KeepAwakePlugin")?;
                app.manage(AndroidAwake(handle));
                Ok(())
            })
            .build()
    }

    pub(super) fn set<R: Runtime>(app: &AppHandle<R>, on: bool) -> Result<(), String> {
        // `run_mobile_plugin` blocks this thread on a channel until Android's
        // main thread replies, and the Kotlin side runs ON that main thread.
        // So this may only ever be reached from inside a `#[tauri::command]`,
        // which runs on the async pool. Calling it from anything already on
        // the Android main thread deadlocks the app outright. Same rule
        // `vision` already lives by.
        app.state::<AndroidAwake<R>>()
            .0
            .run_mobile_plugin::<()>(KEEP_AWAKE, request(on))
            .map_err(|e| format!("holding the screen open: {e}"))
    }
}

/// Register the Kotlin side. Android only — the class and everything it
/// touches live in the Android Gradle source set, so no desktop bundle carries
/// any of it.
#[cfg(target_os = "android")]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    android::init()
}

/// Hold the screen open, or let it go.
#[cfg(target_os = "android")]
pub fn set<R: tauri::Runtime>(app: &tauri::AppHandle<R>, on: bool) -> Result<(), String> {
    android::set(app, on)
}

/// Everywhere that is not Android, this succeeds and does nothing.
///
/// Deliberately `Ok(())` and not the "not supported yet" refusal `vision` uses
/// for a device with no reader. A photo that cannot be read is a thing the
/// person asked for and did not get, and they deserve to be told. A screen
/// that dims on its ordinary timeout is what every desktop is supposed to do,
/// so there is nothing to report.
///
/// iOS is inside this arm, and that is a gap rather than a decision that iOS
/// does not need it: the equivalent is one line of Swift
/// (`UIApplication.shared.isIdleTimerDisabled`), but this repository has no
/// Swift plugin to put it in — macOS reaches its native code through objc2
/// instead. An iPhone therefore behaves exactly as it does today.
#[cfg(not(target_os = "android"))]
pub fn set<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, _on: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{request, KEEP_AWAKE};

    #[test]
    fn the_flag_crosses_as_a_boolean_under_the_name_kotlin_reads() {
        // A JSON string "true" would be just as accepted by the invoke and
        // would then be coerced by Jackson, which is precisely why this is
        // pinned: the two sides agree on a boolean or they agree on nothing.
        assert_eq!(request(true).to_string(), r#"{"on":true}"#);
        assert_eq!(request(false).to_string(), r#"{"on":false}"#);
    }

    #[test]
    fn asking_for_the_screen_never_degrades_into_silence() {
        // `KeepAwakeArgs.on` defaults to false, so an absent key is not an
        // error on the Kotlin side — it is a screen that quietly goes on
        // sleeping. The key must therefore be present in BOTH directions, and
        // nothing here may ever grow a `skip_serializing_if`.
        for on in [true, false] {
            let sent = request(on);
            assert_eq!(sent.as_object().map(|o| o.len()), Some(1));
            assert_eq!(sent.get("on").and_then(|v| v.as_bool()), Some(on));
        }
    }

    #[test]
    fn the_command_name_is_the_one_the_kotlin_method_is_called() {
        // Spelled out rather than compared to itself: this is the string
        // `KeepAwakePlugin.keepAwake` is registered under, and the failure
        // when it drifts is a rejected invoke on a device, not a build error.
        assert_eq!(KEEP_AWAKE, "keepAwake");
    }
}
