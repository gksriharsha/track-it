//! Nudges: daily reminders to log, at times the user sets.
//!
//! The times and their alarms live in `NudgePlugin.kt`, which has to re-arm
//! them at boot without opening the log. This end checks what the front end
//! sends and passes it across; off Android there is nothing to schedule with.

/// "HH:MM", 24-hour, as an `<input type="time">` gives it.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn is_time(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && matches!(t[..2].parse::<u8>(), Ok(h) if h < 24)
        && matches!(t[3..].parse::<u8>(), Ok(m) if m < 60)
        && b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit())
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn request(times: &[String]) -> Result<serde_json::Value, String> {
    if let Some(bad) = times.iter().find(|t| !is_time(t)) {
        return Err(format!("{bad:?} is not a time of day"));
    }
    Ok(serde_json::json!({ "times": times }))
}

#[cfg(target_os = "android")]
mod android {
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    pub(super) struct AndroidNudge<R: Runtime>(PluginHandle<R>);

    pub(super) fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("nudge")
            .setup(|app, api| {
                let handle = api.register_android_plugin("com.kgundu1.trackit", "NudgePlugin")?;
                app.manage(AndroidNudge(handle));
                Ok(())
            })
            .build()
    }

    pub(super) fn run<R: Runtime>(
        app: &AppHandle<R>,
        command: &str,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        app.state::<AndroidNudge<R>>()
            .0
            .run_mobile_plugin(command, payload)
            .map_err(|e| format!("nudges: {e}"))
    }
}

#[cfg(target_os = "android")]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    android::init()
}

/// `{ times: ["08:30", …], enabled }` — `enabled` is whether Android will show them.
#[cfg(target_os = "android")]
pub fn get<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    android::run(app, "getNudges", serde_json::json!({}))
}

#[cfg(target_os = "android")]
pub fn set<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    times: Vec<String>,
) -> Result<serde_json::Value, String> {
    android::run(app, "setNudges", request(&times)?)
}

#[cfg(not(target_os = "android"))]
pub fn get<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    Err("nudges are on Android only".into())
}

#[cfg(not(target_os = "android"))]
pub fn set<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _times: Vec<String>,
) -> Result<serde_json::Value, String> {
    Err("nudges are on Android only".into())
}

#[cfg(test)]
mod tests {
    use super::{is_time, request};

    #[test]
    fn only_a_24_hour_clock_time_is_a_time() {
        for ok in ["00:00", "08:30", "23:59"] {
            assert!(is_time(ok), "{ok}");
        }
        for bad in ["24:00", "8:30", "08:60", "0830", "08:3a", "+8:30", "", "08:30:00"] {
            assert!(!is_time(bad), "{bad}");
        }
    }

    #[test]
    fn the_times_cross_under_the_name_kotlin_reads() {
        let sent = request(&["08:30".into(), "19:00".into()]).unwrap();
        assert_eq!(sent.to_string(), r#"{"times":["08:30","19:00"]}"#);
        assert!(request(&["25:00".into()]).is_err());
    }
}
