//! The Android Keystore half of the encrypted log: silent daily unlock.
//!
//! The user's data key is wrapped twice — once under an Argon2id key derived
//! from their recovery passphrase, which is what a restore onto a phone that
//! has never seen this app uses, and once under a key held inside this device's
//! Keystore, which is what lets the app open the log at launch without asking
//! for anything. This module is only ever the second of those two. Losing the
//! Keystore key therefore costs one passphrase prompt and can never cost
//! history, and that asymmetry is the whole reason encryption is offered at all
//! — see `docs/decisions.md` D18.
//!
//! The bridge is a Tauri mobile plugin in the shape [`crate::vision`] already
//! proved in this tree: the Kotlin lives in the existing Android source set and
//! is registered from Rust by name, so no Gradle file is touched. Reaching
//! `AndroidKeyStore` from Rust directly would mean hand-rolled JNI against
//! `java.security.KeyStore`, `javax.crypto.Cipher` and
//! `KeyGenParameterSpec.Builder` — dozens of unchecked `find_class` and
//! `call_method` chains — against roughly eighty lines the Kotlin compiler
//! checks for us.
//!
//! What crosses the bridge, said plainly rather than left to be discovered: the
//! 32-byte data key travels as base64 inside a JSON value, which means it
//! momentarily exists as a `java.lang.String` on the Java heap, where it is
//! immutable and outside `zeroize`'s reach. That is a real hole in a design
//! that is otherwise careful about key lifetime. It is accepted because the
//! alternative — having Kotlin mint the key so it never crosses — would put the
//! key out of reach of the passphrase wrap, which is the copy that survives a
//! new phone, and a key custody scheme with only one copy is the failure this
//! feature exists to avoid.

/// What the Keystore turned out to be, reported rather than claimed.
///
/// The screen prints this, so it must be what `KeyInfo` actually said about the
/// key that was created — not what the builder asked for. Plenty of shipped
/// phones advertise StrongBox and then refuse the key, and telling somebody
/// their key is in secure hardware when it is in software is worse than saying
/// nothing at all.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct KeystoreState {
    /// Whether a key could be created or found at all.
    pub available: bool,
    /// `"strongbox"`, `"tee"`, `"software"` or `"unknown"`.
    pub hardware: String,
    /// Why it is not available, when it is not. A sentence, shown unchanged.
    pub note: Option<String>,
}

impl KeystoreState {
    /// What every platform that is not Android reports.
    pub fn unsupported() -> KeystoreState {
        KeystoreState {
            available: false,
            hardware: "unknown".into(),
            note: Some(
                "this platform has no Android keystore, so there is nothing here to hold a key"
                    .into(),
            ),
        }
    }
}

#[cfg(target_os = "android")]
mod android {
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    use super::KeystoreState;

    const PLUGIN_IDENTIFIER: &str = "com.kgundu1.trackit";

    pub(super) struct AndroidKeystore<R: Runtime>(PluginHandle<R>);

    pub(super) fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("backupkeys")
            .setup(|app, api| {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "BackupPlugin")?;
                app.manage(AndroidKeystore(handle));
                Ok(())
            })
            .build()
    }

    /// Every reply from the Kotlin side comes back as a map with literal string
    /// keys, and this is the type that receives it.
    ///
    /// Literal keys, not a Kotlin data class, and the reason is a release-only
    /// failure this tree has already been bitten by once — see the comment on
    /// `VisionPlugin`'s success listener. Release Android builds set
    /// `isMinifyEnabled = true`, and the keep rules that survive are tauri's
    /// own: `@TauriPlugin public class *` and `@InvokeArg public class * { *; }`
    /// and nothing else. A result class's getters are fair game for R8 to
    /// rename, so a data class would deserialise fine in the debug APK and
    /// arrive with renamed fields in the one users install — at which point the
    /// Backup screen would report the keystore as unavailable on exactly the
    /// build that matters.
    #[derive(serde::Deserialize)]
    struct Reply {
        #[serde(default)]
        available: bool,
        #[serde(default)]
        hardware: Option<String>,
        #[serde(default)]
        note: Option<String>,
        /// Base64, bare RFC 4648 with padding — the same convention
        /// `dataBase64` uses for a photograph.
        ///
        /// The rename is load-bearing and is not cosmetic. `BackupPlugin.kt`
        /// resolves `mapOf("dataBase64" to …)`, serde matches field names
        /// byte-for-byte and silently ignores a key it was not expecting, so
        /// without this the field is ALWAYS `None` — on every build, debug
        /// included. What that cost is worth spelling out, because nothing
        /// about it looks like a failure: `wrap` would report "this phone's
        /// keystore returned nothing to store", the caller only logs that, and
        /// so the silent-unlock copy of the key would never reach disk. The
        /// session that enabled encryption would work perfectly; every launch
        /// after it would demand the recovery passphrase and a 64 MiB Argon2id
        /// derivation, and somebody who had forgotten that passphrase — the
        /// exact person the Keystore copy exists for — would never open their
        /// log again. `vision.rs` gave no protection here by precedent, because
        /// it only ever SENDS `dataBase64` as an argument and never receives it.
        #[serde(rename = "dataBase64", default)]
        data_base64: Option<String>,
        #[serde(default)]
        dir: Option<String>,
    }

    fn call<R: Runtime>(
        app: &AppHandle<R>,
        command: &str,
        args: serde_json::Value,
    ) -> Result<Reply, String> {
        app.state::<AndroidKeystore<R>>()
            .0
            .run_mobile_plugin::<Reply>(command, args)
            .map_err(|e| format!("this phone's keystore refused: {e}"))
    }

    pub(super) fn state<R: Runtime>(app: &AppHandle<R>) -> KeystoreState {
        // Never a Result. "The keystore would not answer" is a state the screen
        // has to render, not a failure that should stop somebody reading the
        // rest of the page.
        match call(app, "keystoreState", serde_json::json!({})) {
            Ok(r) => KeystoreState {
                available: r.available,
                hardware: r.hardware.unwrap_or_else(|| "unknown".into()),
                note: r.note,
            },
            Err(e) => KeystoreState {
                available: false,
                hardware: "unknown".into(),
                note: Some(e),
            },
        }
    }

    pub(super) fn wrap<R: Runtime>(app: &AppHandle<R>, dek: &[u8; 32]) -> Result<Vec<u8>, String> {
        let r = call(
            app,
            "wrapKey",
            serde_json::json!({ "dataBase64": crate::b64_encode(dek) }),
        )?;
        let b64 = r
            .data_base64
            .ok_or("this phone's keystore returned nothing to store")?;
        // Not `b64_decode`'s own message: that one names a photograph, because
        // photographs are the only thing that used to come this way.
        crate::b64_decode(&b64)
            .map_err(|_| "this phone's keystore returned something unreadable".to_string())
    }

    pub(super) fn unwrap<R: Runtime>(
        app: &AppHandle<R>,
        wrapped: &[u8],
    ) -> Result<[u8; 32], String> {
        let r = call(
            app,
            "unwrapKey",
            serde_json::json!({ "dataBase64": crate::b64_encode(wrapped) }),
        )?;
        let b64 = r
            .data_base64
            .ok_or("this phone's keystore returned nothing")?;
        let bytes = crate::b64_decode(&b64)
            .map_err(|_| "this phone's keystore returned something unreadable".to_string())?;
        if bytes.len() != 32 {
            return Err("this phone's keystore returned the wrong number of bytes".into());
        }
        let mut k = [0u8; 32];
        k.copy_from_slice(&bytes);
        Ok(k)
    }

    /// The directory Android's backup rules name literally.
    ///
    /// Asked of Kotlin rather than derived from `app_data_dir()`, which on
    /// Android resolves to `activity.dataDir` — one level ABOVE `getFilesDir()`,
    /// which is what `domain="file"` means in a backup rules file. Inferring one
    /// from the other would make the rules file's path a guess about an
    /// undocumented relationship, and a wrong guess there is a backup that
    /// silently carries nothing.
    pub(super) fn dir<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
        let r = call(app, "backupDir", serde_json::json!({}))?;
        let d = r
            .dir
            .ok_or("this phone did not say where its own files live")?;
        Ok(std::path::PathBuf::from(d))
    }
}

#[cfg(target_os = "android")]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    android::init()
}

/// What this device's keystore is, for the screen to print.
#[cfg(target_os = "android")]
pub fn state<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> KeystoreState {
    android::state(app)
}

#[cfg(not(target_os = "android"))]
pub fn state<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> KeystoreState {
    KeystoreState::unsupported()
}

/// Wrap the data key under this device's Keystore key, returning what to store.
///
/// Each of these pairs is the real thing and a stub, and each stub carries an
/// `allow(dead_code)`: off Android nothing calls one, because everything that
/// would is itself Android-only, and a warning that fires on a correct macOS
/// build is a warning people learn to scroll past. Said once, here.
#[cfg(target_os = "android")]
pub fn wrap<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    dek: &[u8; 32],
) -> Result<Vec<u8>, String> {
    android::wrap(app, dek)
}

#[cfg(not(target_os = "android"))]
#[allow(dead_code)]
pub fn wrap<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _dek: &[u8; 32],
) -> Result<Vec<u8>, String> {
    Err(NOT_ANDROID.into())
}

/// Unwrap the data key this device's Keystore was holding.
#[cfg(target_os = "android")]
pub fn unwrap<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    wrapped: &[u8],
) -> Result<[u8; 32], String> {
    android::unwrap(app, wrapped)
}

#[cfg(not(target_os = "android"))]
#[allow(dead_code)]
pub fn unwrap<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _wrapped: &[u8],
) -> Result<[u8; 32], String> {
    Err(NOT_ANDROID.into())
}

/// The one directory Android's backup rules name, and the only place the sealed
/// file is ever written.
#[cfg(target_os = "android")]
pub fn dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    android::dir(app)
}

#[cfg(not(target_os = "android"))]
pub fn dir<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    Err(NOT_ANDROID.into())
}

/// Said once, so every stub above answers with the same sentence.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub const NOT_ANDROID: &str = "there is no Android keystore on this platform";

#[cfg(test)]
mod tests {
    /// Every key the Kotlin resolves is a key this module's `Reply` accepts.
    ///
    /// This test exists because the bug it catches is invisible on both sides.
    /// `BackupPlugin.kt` builds its replies as map literals — deliberately, so
    /// R8 cannot rename them — and serde matches field names byte-for-byte and
    /// ignores a key it was not expecting. So a Kotlin `"dataBase64"` arriving
    /// at a Rust `data_base64` does not fail, does not warn, and does not
    /// appear in a log: the field is quietly `None` for ever. That is precisely
    /// what shipped in the first draft of this module, and what it would have
    /// cost was the silent-unlock copy of the data key never reaching disk —
    /// a passphrase prompt at every launch, and no way back in at all for
    /// somebody who had forgotten it.
    ///
    /// `Reply` itself lives inside the Android-only module and cannot be
    /// constructed here, so the assertion is textual, in the manner of
    /// `export.rs`'s guard against its two label lists drifting apart. A test
    /// that reads one language's source and holds the other to it is worth more
    /// than a unit test of either half, because the boundary is where the
    /// mistake lives and no compiler sees across it.
    #[test]
    fn the_kotlin_and_the_rust_agree_on_every_reply_key() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let kt = root
            .join("gen/android/app/src/main/java/com/kgundu1/trackit/BackupPlugin.kt");
        let kotlin = std::fs::read_to_string(&kt)
            .unwrap_or_else(|e| panic!("reading {}: {e}", kt.display()));
        let rust = std::fs::read_to_string(root.join("src/keystore.rs")).unwrap();

        // Every `"key" to …` inside a reply map. The plugin has no other use
        // for that shape, so matching it is enough without parsing Kotlin.
        let keys: Vec<&str> = kotlin
            .match_indices("\" to ")
            .filter_map(|(at, _)| {
                let before = &kotlin[..at];
                let start = before.rfind('"')? + 1;
                Some(&before[start..])
            })
            .filter(|k| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric()))
            .collect();
        assert!(
            keys.contains(&"dataBase64") && keys.contains(&"available"),
            "the reply keys could not be read out of BackupPlugin.kt — found {keys:?}"
        );

        for key in keys {
            // Either the field is named exactly this, or a serde rename maps it.
            let renamed = rust.contains(&format!("#[serde(rename = \"{key}\"")) 
                || rust.contains(&format!("rename = \"{key}\""));
            let plain = rust.contains(&format!("\n        {key}:"));
            assert!(
                renamed || plain,
                "BackupPlugin.kt resolves \"{key}\", which nothing in keystore.rs \
                 accepts — serde would ignore it and the field would be None"
            );
        }
    }
}
