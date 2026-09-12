//! Where the data key lives, and everything the user can do to it.
//!
//! [`crate::backup`] is the format and [`crate::keystore`] is the phone's own
//! hardware. This module is the part in between: it decides whether the log is
//! encrypted, keeps the key for the session, converts a plaintext log into an
//! encrypted one and back, seals a copy, and puts a sealed copy back. The
//! `#[tauri::command]`s in `lib.rs` are thin wrappers over what is here, which
//! is deliberate — `lib.rs` is a file five other features are editing at the
//! same time, and a feature this size does not belong in the middle of it.
//!
//! See `docs/decisions.md` D18.
//!
//! Three properties everything below is arranged to preserve.
//!
//! **Encryption is opt-in, and it cannot be switched on without a recovery
//! passphrase.** That single rule is what removes every data-loss path from the
//! design. There is always a passphrase-recoverable copy of the key, so a
//! Keystore key the operating system decides to throw away costs one prompt and
//! never costs history.
//!
//! **The key is never inside the thing it opens.** The passphrase wrap and the
//! Keystore wrap both live in files beside the database, in a directory Android
//! is never told it may upload, and the passphrase wrap is additionally written
//! into the sealed file's own header so that file is self-describing.
//!
//! **Whether the log is encrypted is asked of the FILE, not of a flag.** A
//! settings file saying "encrypted" while `user.db` still begins with "SQLite
//! format 3" is exactly the state a half-finished conversion leaves behind, and
//! trusting the flag there would mean keying a plaintext database and reporting
//! it as corrupt. So [`crate::backup::is_plain_sqlite`] is the authority, in the
//! same spirit as every migration arm in `store.rs` asking the database what
//! shape it is in rather than what version it claims.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::backup::{self, Dek, Wrap};
use crate::keystore::{self, KeystoreState};

/// What every mutating command answers with off Android.
///
/// A sentence in the app's own voice, the way `NOT_BUILT` is, rather than a
/// missing command — a command Tauri has never heard of surfaces in the webview
/// as a framework error the screen cannot render as prose.
pub const NOT_ANDROID: &str =
    "Encrypting the log and backing it up through Google are Android features. This build is \
     running on the desktop, where the log is a file you can copy yourself.";

/// The directory the key material lives in.
///
/// Beside `user.db`, in `app_data_dir()`, and NOT under `getFilesDir()` — which
/// is what `domain="file"` addresses in an Android backup rules file. So there
/// is no path a rules file could name that would reach these, whatever anybody
/// later adds to `<cloud-backup>`. That is structural rather than a matter of
/// remembering to exclude them.
const KEYS_DIR: &str = "keys";
const WRAP_FILE: &str = "wrap.json";
const KEYSTORE_FILE: &str = "keystore-wrap.bin";

/// The recovery wrap of the data key, as it sits on disk.
///
/// Base64 rather than an array of numbers, because this file is read by a human
/// roughly once a decade — when something has gone wrong — and three short
/// strings are legible where 96 comma-separated integers are not.
#[derive(Debug, Serialize, Deserialize)]
struct KeyRecord {
    /// This file's own shape. Bumped if the fields move, so a newer app reading
    /// an older file knows rather than guesses.
    version: u32,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    salt: String,
    nonce: String,
    wrapped: String,
    /// Whether the app re-seals a copy on its own when the log has moved on.
    /// Off until the user asks for it: sealing is what makes a file eligible to
    /// leave, and that is not a thing to start doing quietly.
    auto_reseal: bool,
    /// When the sealed copy on this phone was written, and the fingerprint of
    /// the log it was written from. Both `None` until a copy has been sealed —
    /// setting a passphrase does not seal anything.
    sealed_at: Option<String>,
    sealed_from: Option<String>,
}

fn keys_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(KEYS_DIR)
}

/// Read the wrap, or `None` when this phone has no recovery passphrase.
fn read_record(data_dir: &Path) -> Result<Option<KeyRecord>, String> {
    let p = keys_dir(data_dir).join(WRAP_FILE);
    let text = match std::fs::read_to_string(&p) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read {}: {e}", p.display())),
    };
    let r: KeyRecord = serde_json::from_str(&text)
        .map_err(|e| format!("this phone's recovery key record is unreadable: {e}"))?;
    if r.version > 1 {
        return Err(
            "this phone's recovery key record was written by a newer version of TrackIt".into(),
        );
    }
    Ok(Some(r))
}

/// Write the wrap the way the sealed file is written: beside, flush, rename.
///
/// The same discipline for the same reason. This file is the only thing that
/// can turn a passphrase back into the key that opens the log, so a half-written
/// one is the log gone — and a plain `write` truncates before it fills.
fn write_record(data_dir: &Path, r: &KeyRecord) -> Result<(), String> {
    let dir = keys_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(r).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{WRAP_FILE}.new"));
    {
        use std::io::Write;
        let mut f =
            std::fs::File::create(&tmp).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        f.write_all(text.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("flush {}: {e}", tmp.display()))?;
    }
    let final_path = dir.join(WRAP_FILE);
    std::fs::rename(&tmp, &final_path)
        .map_err(|e| format!("replace {}: {e}", final_path.display()))?;
    if let Ok(d) = std::fs::File::open(&dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

fn record_to_wrap(r: &KeyRecord) -> Result<Wrap, String> {
    let bad = "this phone's recovery key record is unreadable";
    let salt = crate::b64_decode(&r.salt).map_err(|_| bad.to_string())?;
    let nonce = crate::b64_decode(&r.nonce).map_err(|_| bad.to_string())?;
    let wrapped = crate::b64_decode(&r.wrapped).map_err(|_| bad.to_string())?;
    if salt.len() != 16 || nonce.len() != 24 || wrapped.len() != 48 {
        return Err(bad.into());
    }
    let mut w = Wrap {
        m_cost: r.m_cost,
        t_cost: r.t_cost,
        p_cost: r.p_cost,
        salt: [0u8; 16],
        nonce: [0u8; 24],
        wrapped: [0u8; 48],
    };
    w.salt.copy_from_slice(&salt);
    w.nonce.copy_from_slice(&nonce);
    w.wrapped.copy_from_slice(&wrapped);
    // The same bound the sealed file's header gets, and for the same reason: a
    // corrupt cost here would be handed straight to Argon2, which allocates
    // before it authenticates anything.
    backup::validate_wrap(&w)?;
    Ok(w)
}

fn wrap_to_record(
    w: &Wrap,
    auto_reseal: bool,
    sealed_at: Option<String>,
    sealed_from: Option<String>,
) -> KeyRecord {
    KeyRecord {
        version: 1,
        m_cost: w.m_cost,
        t_cost: w.t_cost,
        p_cost: w.p_cost,
        salt: crate::b64_encode(&w.salt),
        nonce: crate::b64_encode(&w.nonce),
        wrapped: crate::b64_encode(&w.wrapped),
        auto_reseal,
        sealed_at,
        sealed_from,
    }
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/// The data key for as long as the app is running, and nothing else.
///
/// Managed as Tauri state beside `store::Store`. Held in memory rather than
/// fetched from the Keystore per operation because a rekey, a re-seal and an
/// unlock all need the same 32 bytes, and each Keystore round trip is a JNI
/// call that momentarily materialises the key as a Java string.
pub struct Vault(pub Mutex<Session>);

pub struct Session {
    /// `None` on a phone whose log is plaintext, and also on one whose log is
    /// encrypted and could not be unlocked. `locked` distinguishes the two.
    pub dek: Option<Dek>,
    /// The log is encrypted and this session has no key for it.
    pub locked: bool,
    /// Why, in a sentence the screen shows unchanged.
    pub note: Option<String>,
}

/// Open the user database, keyed if it turns out to be encrypted.
///
/// Called from `init_state` and it must not fail on a phone whose Keystore has
/// lost the key. When it cannot unlock the log it hands back an EMPTY in-memory
/// connection with no schema on it and `locked: true`, and that shape is
/// chosen on purpose: every command then fails against a missing table rather
/// than quietly accepting a meal into a database that will vanish when the
/// process does. A throwaway database carrying `SCHEMA` would have been the
/// friendlier-looking choice and the one that silently ate the user's day.
///
/// The front end gates on `locked` and shows nothing but the way back in.
pub fn open_log(app: &tauri::AppHandle, data_dir: &Path) -> Result<(Connection, Session), String> {
    let path = data_dir.join("user.db");

    if backup::is_plain_sqlite(&path)? {
        let conn = crate::store::open(&path)?;
        return Ok((
            conn,
            Session {
                dek: None,
                locked: false,
                note: None,
            },
        ));
    }

    match unlock_with_keystore(app, data_dir, &path) {
        Ok((conn, dek)) => {
            // The conversion's safety net has done its job the moment the
            // encrypted log opens. Leaving it would leave a full PLAINTEXT copy
            // of the log on the phone for ever, next to the encrypted one that
            // exists because plaintext was not wanted.
            let plain = data_dir.join(backup::PLAIN_SUPERSEDED);
            if plain.exists() {
                if let Err(e) = std::fs::remove_file(&plain) {
                    eprintln!("could not remove the superseded plaintext log: {e}");
                }
            }
            Ok((
                conn,
                Session {
                    dek: Some(dek),
                    locked: false,
                    note: None,
                },
            ))
        }
        Err(e) => {
            let conn = Connection::open_in_memory()
                .map_err(|e| format!("preparing a locked session: {e}"))?;
            Ok((
                conn,
                Session {
                    dek: None,
                    locked: true,
                    note: Some(e),
                },
            ))
        }
    }
}

/// The silent daily unlock: the key out of the Keystore, then the log.
#[cfg(target_os = "android")]
fn unlock_with_keystore(
    app: &tauri::AppHandle,
    data_dir: &Path,
    path: &Path,
) -> Result<(Connection, Dek), String> {
    let wrapped_path = keys_dir(data_dir).join(KEYSTORE_FILE);
    let wrapped = std::fs::read(&wrapped_path).map_err(|_| {
        "this phone's keystore is no longer holding the key to the log. Your recovery passphrase \
         still opens it."
            .to_string()
    })?;
    let bytes = keystore::unwrap(app, &wrapped)?;
    let dek = Dek::from_bytes(bytes);
    let conn = crate::store::open_encrypted(&path.to_path_buf(), &dek.sqlcipher_key())?;
    Ok((conn, dek))
}

#[cfg(not(target_os = "android"))]
fn unlock_with_keystore(
    _app: &tauri::AppHandle,
    _data_dir: &Path,
    _path: &Path,
) -> Result<(Connection, Dek), String> {
    // Reachable only by moving an Android phone's database onto a desktop,
    // which nothing in the app does. Said rather than left as a panic.
    Err("this log is encrypted, and only the Android build can open an encrypted log".into())
}

/// Store the Keystore's wrap of the key, so the next launch is silent.
///
/// Called only from the Android-only halves below, hence the attribute: a
/// warning that fires on a correct macOS build is one people learn to scroll
/// past. Same for [`forget_keystore_wrap`].
///
/// Best effort by design. A phone that will not hold the key still gets an
/// encrypted log and a working passphrase; what it loses is the silence, and
/// the Backup screen says so rather than pretending otherwise.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn save_keystore_wrap(app: &tauri::AppHandle, data_dir: &Path, dek: &Dek) -> Option<String> {
    let dir = keys_dir(data_dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return Some(format!("create {}: {e}", dir.display()));
    }
    match keystore::wrap(app, dek.bytes()) {
        Ok(bytes) => match std::fs::write(dir.join(KEYSTORE_FILE), &bytes) {
            Ok(()) => None,
            Err(e) => Some(format!("store the keystore's copy of the key: {e}")),
        },
        Err(e) => Some(e),
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn forget_keystore_wrap(data_dir: &Path) {
    let p = keys_dir(data_dir).join(KEYSTORE_FILE);
    if p.exists() {
        let _ = std::fs::remove_file(p);
    }
}

// ---------------------------------------------------------------------------
// What the screen is told
// ---------------------------------------------------------------------------

/// Everything the Backup screen renders, and nothing it has to work out.
#[derive(Serialize)]
pub struct BackupStatus {
    /// False off Android. The screen then explains the platform rather than
    /// reading any of the fields below.
    pub supported: bool,
    /// Whether `user.db` is SQLCipher-keyed right now, asked of the file.
    pub encrypted: bool,
    /// Encrypted, and this session has no key. Everything is behind the way in.
    pub locked: bool,
    /// Why it is locked. A sentence, shown unchanged.
    pub locked_note: Option<String>,
    pub passphrase_set: bool,
    pub keystore: KeystoreState,
    /// Whether a Keystore copy of the key is actually on disk. Distinct from
    /// `keystore.available`: the hardware can be fine and the file absent.
    pub keystore_holds_key: bool,
    /// null until a copy has been sealed. Never read as an empty string.
    pub sealed_at: Option<String>,
    pub sealed_bytes: Option<u64>,
    pub plain_bytes: Option<u64>,
    /// 26,214,400. What Google's backup service will carry for one app, named.
    pub quota_bytes: u64,
    /// Over it, Android stops carrying this app and tells nobody.
    pub over_quota: bool,
    /// The log has moved on since the sealed copy was written.
    pub stale: bool,
    pub auto_reseal: bool,
    /// A sealed copy is here and the log is empty — which is what a fresh
    /// install looks like after Google has delivered the backup.
    pub restore_available: bool,
    /// How many entries the log holds, so "empty" is a fact and not a guess.
    pub logged_entries: i64,
    /// Where the one file that may leave this phone lives. Named because the
    /// screen says it, and because it is checkable with adb.
    pub sealed_dir: Option<String>,
    /// Where the log this device replaced went, if a restore has run and its
    /// safety net is still there.
    pub superseded_path: Option<String>,
}

impl BackupStatus {
    /// What every platform that is not Android reports.
    pub fn unsupported() -> BackupStatus {
        BackupStatus {
            supported: false,
            encrypted: false,
            locked: false,
            locked_note: None,
            passphrase_set: false,
            keystore: KeystoreState::unsupported(),
            keystore_holds_key: false,
            sealed_at: None,
            sealed_bytes: None,
            plain_bytes: None,
            quota_bytes: backup::QUOTA_BYTES,
            over_quota: false,
            stale: false,
            auto_reseal: false,
            restore_available: false,
            logged_entries: 0,
            sealed_dir: None,
            superseded_path: None,
        }
    }
}

/// What the log currently looks like, in one short string.
///
/// Used to answer "has anything happened since the copy was sealed" without a
/// schema change and without mtime. mtime is the obvious answer and it is
/// wrong: `store::open` sets pragmas, runs `SCHEMA` and checkpoints the WAL at
/// EVERY cold launch, so the file's timestamp advances on a launch where
/// nothing was eaten, and the app would re-seal every single time it started.
///
/// Note what this does and does not catch. Counts catch anything added or
/// removed; `row_version`'s high-water mark catches every change to the shared
/// kitchen; `entry_snapshots.corrected_at` catches a correction to frozen
/// nutrition, which changes a value in place without changing a count. What it
/// would miss is an edit that changes a value in place in a table none of those
/// cover — and the cost of missing one is a sealed copy that is one edit behind
/// until the next thing happens, not a wrong figure anywhere.
fn fingerprint(conn: &Connection) -> Result<String, String> {
    conn.query_row(
        "SELECT (SELECT COUNT(*) FROM log_entries)
           ||'.'|| (SELECT COUNT(*) FROM entry_nutrients)
           ||'.'|| (SELECT COUNT(*) FROM recipes)
           ||'.'|| (SELECT COUNT(*) FROM cooks)
           ||'.'|| (SELECT COUNT(*) FROM cook_draws)
           ||'.'|| (SELECT COUNT(*) FROM custom_foods)
           ||'.'|| (SELECT COUNT(*) FROM supplements)
           ||'.'|| (SELECT COUNT(*) FROM vessels)
           ||'.'|| (SELECT COUNT(*) FROM bottles)
           ||'.'|| (SELECT COALESCE(MAX(changed_at),'-') FROM row_version)
           ||'.'|| (SELECT COALESCE(MAX(created_at),'-') FROM log_entries)
           ||'.'|| (SELECT COALESCE(MAX(corrected_at),'-') FROM entry_snapshots)",
        [],
        |r| r.get(0),
    )
    .map_err(|e| format!("reading what the log currently holds: {e}"))
}

fn entry_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM log_entries WHERE deleted_at IS NULL",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Assemble the whole status. Never fails because a phone is in a bad state —
/// a bad state is what the screen exists to describe.
pub fn status(
    app: &tauri::AppHandle,
    data_dir: &Path,
    user: &crate::store::Store,
    vault: &Vault,
) -> Result<BackupStatus, String> {
    if !cfg!(target_os = "android") {
        return Ok(BackupStatus::unsupported());
    }
    let mut s = BackupStatus::unsupported();
    s.supported = true;
    s.keystore = keystore::state(app);

    let db = data_dir.join("user.db");
    s.encrypted = !backup::is_plain_sqlite(&db)?;

    {
        let session = vault.0.lock().map_err(|e| e.to_string())?;
        s.locked = session.locked;
        s.locked_note = session.note.clone();
    }
    s.keystore_holds_key = keys_dir(data_dir).join(KEYSTORE_FILE).exists();

    let record = read_record(data_dir)?;
    s.passphrase_set = record.is_some();
    if let Some(r) = &record {
        s.auto_reseal = r.auto_reseal;
        s.sealed_at = r.sealed_at.clone();
    }

    if let Ok(dir) = keystore::dir(app) {
        s.sealed_dir = Some(dir.to_string_lossy().to_string());
        let sealed = dir.join(backup::SEALED_NAME);
        if let Ok(meta) = std::fs::metadata(&sealed) {
            s.sealed_bytes = Some(meta.len());
            s.over_quota = meta.len() > backup::QUOTA_BYTES;
            // The header, not the record: it is the FILE saying when it was
            // sealed and how big the log inside it was, which is the thing the
            // screen should print — the record can have been written since.
            //
            // The first 162 bytes rather than the whole file. This runs every
            // time the screen is opened, and reading four megabytes of
            // ciphertext into memory to look at its first line is four
            // megabytes of nothing.
            if let Ok(mut f) = std::fs::File::open(&sealed) {
                use std::io::Read;
                let mut head = vec![0u8; backup::HEADER_LEN];
                if f.read_exact(&mut head).is_ok() {
                    if let Ok(h) = backup::read_header(&head) {
                        s.sealed_at = Some(h.sealed_at);
                        s.plain_bytes = Some(h.plain_bytes);
                    }
                }
            }
        }
    }

    // The log itself, but only when this session can actually read it.
    if !s.locked {
        let conn = user.0.lock().map_err(|e| e.to_string())?;
        s.logged_entries = entry_count(&conn).unwrap_or(0);
        if let (Some(r), Ok(now)) = (&record, fingerprint(&conn)) {
            // Nothing sealed means nothing is out of date; there is nothing.
            // Sealed with no fingerprint recorded is the state a passphrase
            // change leaves behind on purpose, and it reads as stale — because
            // the file on disk still opens with the OLD passphrase, and telling
            // somebody their copy is current when the passphrase they now
            // believe in does not open it would be the worst lie on the screen.
            s.stale = r.sealed_at.is_some() && r.sealed_from.as_deref() != Some(now.as_str());
        }
    }

    // What a fresh install looks like once Google has delivered the file: a
    // sealed copy present and nothing logged. Offered rather than left for the
    // user to find, because the alternative is somebody opening a new phone,
    // seeing an empty log and concluding the backup never worked.
    s.restore_available = s.sealed_bytes.is_some() && s.logged_entries == 0 && !s.locked;

    let superseded = data_dir.join(backup::SUPERSEDED);
    if superseded.exists() {
        s.superseded_path = Some(superseded.to_string_lossy().to_string());
    }
    Ok(s)
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

/// A read-only second connection on the live database.
///
/// The reason a second connection exists at all: `backup::snapshot` copies
/// every page, and doing that through the live connection means holding
/// `Store`'s mutex for the whole copy plus the gzip plus the AEAD pass. Every
/// command in the app takes that mutex, so a seal on a twenty-megabyte log
/// would freeze the interface for exactly as long as the copy took — which is
/// the cold-launch symptom `store::open`'s comment records this app having
/// already been burned by once.
///
/// Read-only by discipline rather than by `query_only`, and that is forced.
/// The pragma was here as belt and braces, and it made the seal impossible:
/// `backup::snapshot` copies an encrypted database with `sqlcipher_export`,
/// which WRITES into an attached in-memory copy, and `query_only` is
/// connection-wide — it does not distinguish the attached schema from `main`,
/// so it refused the export with "attempt to write a readonly database". The
/// two cannot both be had.
///
/// What actually protects the log is that nothing on this connection ever
/// writes to `main`: `snapshot` reads pages out and `fingerprint` reads a
/// count. Keep it that way — this is the one connection in the app that touches
/// the live database without holding `Store`'s mutex.
fn read_only_connection(path: &Path, dek: Option<&Dek>) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    if let Some(d) = dek {
        crate::store::apply_key(&conn, d.sqlcipher_key().as_str())?;
    }
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .map_err(|_| "the log could not be read to copy it".to_string())?;
    Ok(conn)
}

/// Write a fresh sealed copy of the log.
///
/// This is a SEPARATE act from setting a passphrase, and that separation is the
/// consent gate. Setting a passphrase creates a key; sealing creates the one
/// file Android has been told it may upload. Collapsing them into a single
/// button with the consequence explained in a paragraph above the field would
/// be exactly the kind of implied consent this app does not do.
pub fn seal_now(
    app: &tauri::AppHandle,
    data_dir: &Path,
    user: &crate::store::Store,
    vault: &Vault,
) -> Result<BackupStatus, String> {
    if !cfg!(target_os = "android") {
        return Err(NOT_ANDROID.into());
    }
    let record = read_record(data_dir)?.ok_or(
        "this phone has no recovery passphrase, so there is nothing to seal a copy with",
    )?;
    let wrap = record_to_wrap(&record)?;
    seal_with(app, data_dir, user, vault, &wrap, &record)?;
    status(app, data_dir, user, vault)
}

/// The one code path that ever writes the sealed file.
fn seal_with(
    app: &tauri::AppHandle,
    data_dir: &Path,
    user: &crate::store::Store,
    vault: &Vault,
    wrap: &Wrap,
    record: &KeyRecord,
) -> Result<(), String> {
    // The session's key IS the key the header's wrap opens: a passphrase on this
    // phone always wraps the key the log is encrypted under, because the one act
    // that creates a passphrase is the one that encrypts the log. So the file is
    // openable by the passphrase and by nothing else — including this phone,
    // once it has forgotten the key.
    let dek = {
        let session = vault.0.lock().map_err(|e| e.to_string())?;
        if session.locked {
            return Err("the log is locked, so there is nothing to copy yet".into());
        }
        match session.dek.as_ref() {
            Some(d) => Dek::from_bytes(*d.bytes()),
            None => {
                return Err(
                    "the log on this phone is not encrypted, so there is no key to seal a copy with"
                        .into(),
                )
            }
        }
    };

    // The timestamp and the fingerprint come off the live connection, because
    // the app's clock is SQLite's — see `store::now_iso`. That is a short lock,
    // not the whole copy.
    let (sealed_at, print) = {
        let conn = user.0.lock().map_err(|e| e.to_string())?;
        (crate::store::now_iso(&conn)?, fingerprint(&conn)?)
    };

    let db = data_dir.join("user.db");
    let (gz, plain_len) = {
        let ro = read_only_connection(&db, Some(&dek))?;
        // Keyed, so the ATTACH + sqlcipher_export path — the online backup API
        // is refused on an encrypted database. See backup::snapshot.
        backup::snapshot(&ro, true)?
    };

    let blob = backup::seal(&dek, wrap, &gz, plain_len, &sealed_at)?;
    let dir = keystore::dir(app)?;
    backup::write_sealed(&dir, &blob)?;

    write_record(
        data_dir,
        &wrap_to_record(wrap, record.auto_reseal, Some(sealed_at), Some(print)),
    )
}

/// Turn the automatic re-seal on or off.
pub fn set_auto_reseal(
    app: &tauri::AppHandle,
    data_dir: &Path,
    user: &crate::store::Store,
    vault: &Vault,
    on: bool,
) -> Result<BackupStatus, String> {
    if !cfg!(target_os = "android") {
        return Err(NOT_ANDROID.into());
    }
    let mut r = read_record(data_dir)?
        .ok_or("this phone has no recovery passphrase, so there is nothing to seal a copy with")?;
    r.auto_reseal = on;
    write_record(data_dir, &r)?;
    status(app, data_dir, user, vault)
}

/// Delete the sealed copy, which is how consent to upload is withdrawn.
///
/// The file is the only thing Android is told it may carry, so removing it is
/// the whole of the withdrawal — there is no second switch and no server to
/// tell. What Google has already taken is Google's to expire; the screen says
/// that rather than implying this button reaches into the cloud.
pub fn remove_sealed(
    app: &tauri::AppHandle,
    data_dir: &Path,
    user: &crate::store::Store,
    vault: &Vault,
) -> Result<BackupStatus, String> {
    if !cfg!(target_os = "android") {
        return Err(NOT_ANDROID.into());
    }
    let path = keystore::dir(app)?.join(backup::SEALED_NAME);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("remove {}: {e}", path.display()))?;
    }
    if let Some(mut r) = read_record(data_dir)? {
        r.sealed_at = None;
        r.sealed_from = None;
        r.auto_reseal = false;
        write_record(data_dir, &r)?;
    }
    status(app, data_dir, user, vault)
}

/// Re-seal on a background thread when the log has moved on.
///
/// Called from `init_state`, after everything else, and every failure here is
/// an `eprintln!` in the manner of `backfill_snapshots` rather than a refusal
/// to start. A backup that could not be written is not a reason a person cannot
/// open their log.
pub fn reseal_if_stale(app: &tauri::AppHandle, data_dir: &Path) {
    if !cfg!(target_os = "android") {
        return;
    }
    let record = match read_record(data_dir) {
        Ok(Some(r)) if r.auto_reseal && r.sealed_at.is_some() => r,
        Ok(_) => return,
        Err(e) => {
            eprintln!("could not read the recovery key record: {e}");
            return;
        }
    };
    let (user, vault) = (
        app.state::<crate::store::Store>(),
        app.state::<Vault>(),
    );
    let print = {
        match user.0.lock() {
            Ok(conn) => match fingerprint(&conn) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("could not read what the log holds: {e}");
                    return;
                }
            },
            Err(e) => {
                eprintln!("could not read the log: {e}");
                return;
            }
        }
    };
    if record.sealed_from.as_deref() == Some(print.as_str()) {
        return;
    }
    let wrap = match record_to_wrap(&record) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("could not read the recovery wrap: {e}");
            return;
        }
    };
    if let Err(e) = seal_with(app, data_dir, &user, &vault, &wrap, &record) {
        eprintln!("could not re-seal the backup copy: {e}");
    }
}

// ---------------------------------------------------------------------------
// Turning encryption on, off, and changing the passphrase
// ---------------------------------------------------------------------------

/// The one place a passphrase pair is checked, so both sides say the same thing.
fn check_pair(passphrase: &str, confirm: &str) -> Result<(), String> {
    backup::check_passphrase(passphrase)?;
    if passphrase != confirm {
        return Err("the two passphrases are not the same".into());
    }
    Ok(())
}

/// Encrypt the log, having first made certain the passphrase can get it back.
///
/// The order below is the whole safety argument, and it is why this cannot be
/// simplified. The recovery wrap is written BEFORE the database is touched, so
/// that at every instant from then on there is a passphrase that recovers the
/// key. The plaintext database is renamed rather than removed, and only removed
/// once the encrypted one has been opened and read. And the window in which
/// `user.db` does not exist is a single rename wide, which is the window
/// `backup::recover_interrupted` closes at the next launch.
#[cfg(target_os = "android")]
pub fn enable(
    app: &tauri::AppHandle,
    data_dir: &Path,
    user: &crate::store::Store,
    vault: &Vault,
    passphrase: &str,
    confirm: &str,
) -> Result<BackupStatus, String> {
    check_pair(passphrase, confirm)?;
    let db = data_dir.join("user.db");
    if !backup::is_plain_sqlite(&db)? {
        return Err("the log on this phone is already encrypted".into());
    }
    // A record on its own is NOT a reason to refuse, and testing for one was a
    // one-way door in the other direction. `disable` removes the keystore wrap
    // and deliberately leaves `wrap.json`, because the encrypted log it
    // replaced is kept and that record is its only key — so after turning
    // encryption off, every attempt to turn it back on was refused for ever,
    // and the change-passphrase card that would have cleared the record is
    // only drawn while the log IS encrypted. The same dead end was reached by
    // a crash anywhere between the write above and the rename below, which on
    // a real log is seconds wide: `recover_interrupted` correctly puts the
    // plaintext log back, and the orphaned record then refused the retry.
    //
    // The line above has already established that this database is plaintext,
    // so whatever a record describes, it does not describe this. What must
    // actually be refused is overwriting that record while the encrypted copy
    // it is the only key to is still on disk — minting a fresh key would leave
    // that file permanently unopenable, which is the failure the plaintext
    // guard below prevents, one direction over.
    let superseded = data_dir.join(backup::SUPERSEDED);
    if superseded.exists() {
        return Err(format!(
            "there is still an encrypted copy of the log at {}, and the recovery passphrase \
             this would replace is its only key",
            superseded.display()
        ));
    }
    let plain_superseded = data_dir.join(backup::PLAIN_SUPERSEDED);
    if plain_superseded.exists() {
        return Err(format!(
            "there is still a plaintext copy of the log at {} from an earlier attempt, and \
             overwriting it would throw away the only safety net that attempt left",
            plain_superseded.display()
        ));
    }

    let dek = Dek::new()?;
    let wrap = backup::wrap_dek(passphrase, &dek)?;
    // First, and before anything about the database changes. From here on the
    // passphrase recovers the key whatever happens next.
    write_record(data_dir, &wrap_to_record(&wrap, false, None, None))?;

    let staged = data_dir.join(backup::CONVERTING);
    let key = dek.sqlcipher_key();

    // Close the live database before copying it. `sqlcipher_export` reads
    // through a fresh connection, and an open WAL with uncheckpointed frames on
    // the source would mean copying a database that is missing its most recent
    // writes.
    //
    // The store's lock is held across the whole copy, and that is the intent
    // rather than an oversight: every command in the app takes this mutex, so
    // holding it is exactly what stops a meal being saved into a database that
    // is being replaced underneath it. A one-time conversion blocking the
    // interface for a few seconds is the correct trade; a lost meal is not.
    let mut guard = user.0.lock().map_err(|e| e.to_string())?;
    {
        let _: Result<i64, _> =
            guard.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0));
    }
    let parked = std::mem::replace(
        &mut *guard,
        Connection::open_in_memory().map_err(|e| e.to_string())?,
    );
    drop(parked);

    let convert = backup::convert(&db, None, &staged, Some(&key))
        .and_then(|()| crate::store::open_encrypted(&staged, &key))
        .map(drop);
    if let Err(e) = convert {
        let _ = std::fs::remove_file(&staged);
        *guard = crate::store::open(&db)?;
        return Err(e);
    }

    // The rename pair. Nothing between them but the rename itself.
    std::fs::rename(&db, &plain_superseded)
        .map_err(|e| format!("set aside {}: {e}", db.display()))?;
    backup::drop_sidecars(&db)?;
    std::fs::rename(&staged, &db).map_err(|e| format!("move {}: {e}", db.display()))?;
    backup::drop_sidecars(&staged)?;

    match crate::store::open_encrypted(&db, &key) {
        Ok(conn) => {
            /*
              The identity is KEPT here, and that is the point of this comment.

              This function encrypts the log this phone already had, in place.
              Same installation, same database, same household — nothing has
              arrived from anywhere else, so there is nothing to disown. A
              `forget_household_identity` call sat here and emptied
              `this_device` every time somebody turned encryption on, which
              left all fourteen change-tracking triggers selecting NULL into
              `row_version.device_id NOT NULL`: from then on saving or editing
              a recipe, cook, custom food, supplement, vessel or bottle failed
              a constraint, and nothing ever re-minted an id. It was added by
              af06b07 ("stop a restore stealing an identity") and the diff
              header shows it landing on `pub fn enable` — the right call put
              in the wrong function. It now lives in `restore`, which is the
              one that adopts another phone's sealed log.
            */
            *guard = conn;
        }
        Err(e) => {
            // The encrypted log will not open. Put the plaintext one back —
            // this is the reason it was renamed rather than removed.
            let _ = std::fs::remove_file(&db);
            std::fs::rename(&plain_superseded, &db)
                .map_err(|e2| format!("{e}, and putting the log back failed too: {e2}"))?;
            *guard = crate::store::open(&db)?;
            return Err(e);
        }
    }
    drop(guard);

    // Only now, with the encrypted log open and read, is the plaintext copy
    // surplus. Not one statement earlier.
    if plain_superseded.exists() {
        std::fs::remove_file(&plain_superseded)
            .map_err(|e| format!("remove {}: {e}", plain_superseded.display()))?;
    }

    // Best effort, and the failure is NOT recorded on the session. `note` is
    // what the screen prints when the log is LOCKED, and a keystore that would
    // not take the key has not locked anything — the passphrase works, the log
    // is open, and what the user needs to be told is that they will be asked
    // again next time. `status`'s `keystore_holds_key` is what says that, and
    // `keystore::state` carries the phone's own reason.
    if let Some(why) = save_keystore_wrap(app, data_dir, &dek) {
        eprintln!("the keystore did not take the key: {why}");
    }
    {
        let mut session = vault.0.lock().map_err(|e| e.to_string())?;
        session.dek = Some(dek);
        session.locked = false;
        session.note = None;
    }
    status(app, data_dir, user, vault)
}

#[cfg(not(target_os = "android"))]
pub fn enable(
    _app: &tauri::AppHandle,
    _data_dir: &Path,
    _user: &crate::store::Store,
    _vault: &Vault,
    _passphrase: &str,
    _confirm: &str,
) -> Result<BackupStatus, String> {
    Err(NOT_ANDROID.into())
}

/// Turn encryption off again, which needs the passphrase.
///
/// Opt-in is only honestly opt-in if it can be undone. The passphrase is
/// required rather than the Keystore's silent copy, for the same reason a bank
/// asks before it closes an account: the act removes a protection, so it should
/// take the thing only the owner has.
#[cfg(target_os = "android")]
pub fn disable(
    app: &tauri::AppHandle,
    data_dir: &Path,
    user: &crate::store::Store,
    vault: &Vault,
    passphrase: &str,
) -> Result<BackupStatus, String> {
    let db = data_dir.join("user.db");
    if backup::is_plain_sqlite(&db)? {
        return Err("the log on this phone is not encrypted".into());
    }
    let record =
        read_record(data_dir)?.ok_or("this phone has no recovery passphrase to check against")?;
    let dek = backup::unwrap_dek(passphrase, &record_to_wrap(&record)?)?;
    let key = dek.sqlcipher_key();
    let staged = data_dir.join(backup::CONVERTING);

    let mut guard = user.0.lock().map_err(|e| e.to_string())?;
    {
        let _: Result<i64, _> =
            guard.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0));
    }
    let parked = std::mem::replace(
        &mut *guard,
        Connection::open_in_memory().map_err(|e| e.to_string())?,
    );
    drop(parked);

    let convert = backup::convert(&db, Some(&key), &staged, None)
        .and_then(|()| crate::store::open(&staged))
        .map(drop);
    if let Err(e) = convert {
        let _ = std::fs::remove_file(&staged);
        *guard = crate::store::open_encrypted(&db, &key)?;
        return Err(e);
    }

    let swapped = backup::swap_in(data_dir, &staged)?;
    match crate::store::open(&db) {
        Ok(conn) => {
            *guard = conn;
        }
        Err(e) => {
            backup::unswap(data_dir)?;
            *guard = crate::store::open_encrypted(&db, &key)?;
            return Err(e);
        }
    }
    drop(guard);
    // The encrypted log this replaced is kept under `swapped.superseded`. It is
    // NOT removed here: it is still the user's history, still readable only with
    // their passphrase, and the screen names it.
    let _ = &swapped;

    forget_keystore_wrap(data_dir);
    {
        let mut session = vault.0.lock().map_err(|e| e.to_string())?;
        session.dek = None;
        session.locked = false;
        session.note = None;
    }
    status(app, data_dir, user, vault)
}

#[cfg(not(target_os = "android"))]
pub fn disable(
    _app: &tauri::AppHandle,
    _data_dir: &Path,
    _user: &crate::store::Store,
    _vault: &Vault,
    _passphrase: &str,
) -> Result<BackupStatus, String> {
    Err(NOT_ANDROID.into())
}

/// Change the recovery passphrase.
///
/// The current one is REQUIRED, and it is checked against the wrap on disk
/// before a byte is written. Without that, anybody holding an unlocked phone
/// could revoke the passphrase protecting every copy of the log that has ever
/// left it.
///
/// The data key itself is NOT rotated, and the consequence has to be said out
/// loud rather than buried: a sealed file somebody has already carried
/// elsewhere still opens with the old passphrase, because the passphrase that
/// wrapped a file's key is recorded inside that file. What changes is the copy
/// on this phone, which is re-sealed under the new one. Rotating the key would
/// mean rekeying the whole database, and a crash in the middle of that with the
/// new wrap not yet on disk is a log nobody can open — a worse failure than a
/// stale copy of a file the user chose to move.
pub fn change_passphrase(
    app: &tauri::AppHandle,
    data_dir: &Path,
    user: &crate::store::Store,
    vault: &Vault,
    current: &str,
    passphrase: &str,
    confirm: &str,
) -> Result<BackupStatus, String> {
    if !cfg!(target_os = "android") {
        return Err(NOT_ANDROID.into());
    }
    check_pair(passphrase, confirm)?;
    let record =
        read_record(data_dir)?.ok_or("this phone has no recovery passphrase to change")?;
    let old = record_to_wrap(&record)?;
    let dek = backup::unwrap_dek(current, &old)?;
    let wrap = backup::wrap_dek(passphrase, &dek)?;
    // One atomic write and nothing else, which is what makes this operation
    // have no partial outcome: from the instant it lands, the new passphrase
    // opens the log and the old one does not.
    //
    // It does NOT re-seal. `sealed_at` is kept, because the file on disk really
    // was sealed then and really does still open with the OLD passphrase — the
    // passphrase that wrapped a file's key is recorded inside that file, and
    // this app cannot reach a copy somebody has already carried away. Clearing
    // `sealed_from` is what makes the screen report the copy as out of date, so
    // sealing a fresh one stays the separate, deliberate act it is everywhere
    // else on that screen.
    write_record(
        data_dir,
        &wrap_to_record(&wrap, record.auto_reseal, record.sealed_at.clone(), None),
    )?;
    status(app, data_dir, user, vault)
}

/// Unlock a session whose Keystore could not hand the key back.
///
/// The way in when the rare thing has happened. It also re-stores the
/// Keystore's copy, so this is asked once rather than at every launch.
#[cfg(target_os = "android")]
pub fn unlock(
    app: &tauri::AppHandle,
    data_dir: &Path,
    user: &crate::store::Store,
    vault: &Vault,
    passphrase: &str,
) -> Result<BackupStatus, String> {
    let db = data_dir.join("user.db");
    if backup::is_plain_sqlite(&db)? {
        return Err("the log on this phone is not encrypted, so there is nothing to unlock".into());
    }
    let record =
        read_record(data_dir)?.ok_or("this phone has no recovery passphrase to check against")?;
    let dek = backup::unwrap_dek(passphrase, &record_to_wrap(&record)?)?;
    let conn = crate::store::open_encrypted(&db, &dek.sqlcipher_key())?;
    {
        let mut guard = user.0.lock().map_err(|e| e.to_string())?;
        let parked = std::mem::replace(&mut *guard, conn);
        drop(parked);
    }
    // Not recorded on the session — see the comment in `enable`.
    if let Some(why) = save_keystore_wrap(app, data_dir, &dek) {
        eprintln!("the keystore did not take the key: {why}");
    }
    {
        let mut session = vault.0.lock().map_err(|e| e.to_string())?;
        session.dek = Some(dek);
        session.locked = false;
        session.note = None;
    }
    status(app, data_dir, user, vault)
}

#[cfg(not(target_os = "android"))]
pub fn unlock(
    _app: &tauri::AppHandle,
    _data_dir: &Path,
    _user: &crate::store::Store,
    _vault: &Vault,
    _passphrase: &str,
) -> Result<BackupStatus, String> {
    Err(NOT_ANDROID.into())
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/// What a restore did, in the terms the screen reports it.
#[derive(Serialize)]
pub struct RestoreOutcome {
    /// Entries in the log that just became live. A count, so "it worked" is a
    /// fact rather than a green tick.
    pub entries: i64,
    /// When the copy that was restored had been sealed.
    pub sealed_at: String,
    /// Where the log this replaced went. Renamed, never deleted.
    pub superseded_path: String,
    /// Whether an earlier restore's kept copy had to make room for this one.
    pub replaced_earlier_superseded: bool,
}

/// Replace this phone's log with the sealed copy, given the passphrase.
///
/// The restored database is ENCRYPTED, keyed with the data key the passphrase
/// just recovered from the file's own header. That is the coherent answer: the
/// file came from a phone that had chosen encryption, the passphrase is in hand,
/// and landing a plaintext log from an encrypted backup would quietly downgrade
/// what the user had asked for.
#[cfg(target_os = "android")]
pub fn restore(
    app: &tauri::AppHandle,
    data_dir: &Path,
    user: &crate::store::Store,
    vault: &Vault,
    passphrase: &str,
) -> Result<RestoreOutcome, String> {
    let sealed = keystore::dir(app)?.join(backup::SEALED_NAME);
    let blob =
        std::fs::read(&sealed).map_err(|_| "there is no sealed copy on this phone yet")?;
    let header = backup::read_header(&blob)?;
    let wrap = backup::wrap_from_blob(&blob)?;
    // One call, and it hands back the key as well as the contents — the same
    // key the restored database will be encrypted under, so the passphrase is
    // run through Argon2id once rather than twice.
    let (dek, gz) = backup::open_blob(passphrase, &blob)?;
    let plain = backup::gunzip(&gz)?;

    let staged_plain = data_dir.join(backup::STAGED);
    std::fs::write(&staged_plain, plain.as_slice())
        .map_err(|e| format!("write {}: {e}", staged_plain.display()))?;

    // Verify, then migrate, then CLOSE — in that order, and the close is not
    // optional. `store::open` sets WAL and writes: `SCHEMA` runs and `migrate`
    // may rebuild tables, and those frames land in `user.db.restoring-wal`.
    // Renaming the database out from under that log would leave the migration's
    // work in a file SQLite will never look at again.
    let verified = (|| -> Result<i64, String> {
        let probe = Connection::open(&staged_plain)
            .map_err(|e| format!("open {}: {e}", staged_plain.display()))?;
        let ok: String = probe
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if ok != "ok" {
            return Err("that backup unpacked to a damaged database, so nothing was replaced".into());
        }
        drop(probe);
        let migrated = crate::store::open(&staged_plain)?;
        let n = entry_count(&migrated)?;
        let _: Result<i64, _> = migrated.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0));
        drop(migrated);
        Ok(n)
    })();
    let entries = match verified {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_file(&staged_plain);
            backup::drop_sidecars(&staged_plain)?;
            return Err(e);
        }
    };

    // Encrypt the staged copy before it becomes live, so `user.db` is never a
    // plaintext file even for an instant.
    let key = dek.sqlcipher_key();
    let staged_enc = data_dir.join(backup::CONVERTING);
    let prepared = backup::convert(&staged_plain, None, &staged_enc, Some(&key))
        .and_then(|()| crate::store::open_encrypted(&staged_enc, &key))
        .map(drop);
    let _ = std::fs::remove_file(&staged_plain);
    backup::drop_sidecars(&staged_plain)?;
    if let Err(e) = prepared {
        let _ = std::fs::remove_file(&staged_enc);
        return Err(e);
    }

    let db = data_dir.join("user.db");
    let mut guard = user.0.lock().map_err(|e| e.to_string())?;
    {
        let _: Result<i64, _> =
            guard.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0));
    }
    let parked = std::mem::replace(
        &mut *guard,
        Connection::open_in_memory().map_err(|e| e.to_string())?,
    );
    drop(parked);

    // The file's own wrap becomes this phone's recovery wrap, so the passphrase
    // that opened the backup is the passphrase that opens the log — and it is
    // written BEFORE the swap, for the reason `enable` states above: from here
    // on the passphrase recovers the key whatever happens next.
    //
    // Doing it the other way round was the first draft, and it strands the log
    // in exactly the case this feature exists for. Between a successful
    // `swap_in` and the write, `user.db` is keyed under the DEK out of the
    // backup while nothing on disk says so — on a fresh install, the primary
    // case, `keys/wrap.json` does not exist at all. The next launch finds a
    // file that is not plain SQLite, cannot unlock it from the keystore, and
    // reports the log as locked; the unlock screen then has no record to check
    // a passphrase against, and the sealed file that would have opened it is
    // sitting in the backup directory unreachable, because the restore
    // affordance is only offered to an unlocked session.
    //
    // The mirror risk is real and is why the old record is kept rather than
    // simply overwritten: if the swap fails, the database that stays live is
    // the one the PREVIOUS record describes, and leaving the new record in
    // place would mean a passphrase that recovers a key opening nothing. So
    // whichever database ends up live, the record beside it is the one that
    // opens it.
    let previous = read_record(data_dir)?;
    write_record(
        data_dir,
        &wrap_to_record(&wrap, false, Some(header.sealed_at.clone()), None),
    )?;

    let swapped = match backup::swap_in(data_dir, &staged_enc) {
        Ok(s) => s,
        Err(e) => {
            if let Some(old) = &previous {
                write_record(data_dir, old)?;
            }
            *guard = open_log(app, data_dir)?.0;
            return Err(e);
        }
    };
    match crate::store::open_encrypted(&db, &key) {
        Ok(conn) => {
            *guard = conn;
            // The sealed file was `user.db` whole, so it arrived carrying the
            // household identity of the phone that sealed it. This is a second
            // installation, not that one, and two devices answering to one id
            // drain every pot at double speed without saying so — see
            // `store::forget_household_identity`, which disowns the pairings
            // and mints this installation an id of its own. Never fatal: the
            // log is already live, and a household you have to join again is
            // one visible step, whereas failing here would leave the user
            // holding a restore that reported an error.
            if let Err(e) = crate::store::forget_household_identity(&guard) {
                eprintln!("the restored log kept its old household identity: {e}");
            }
        }
        Err(e) => {
            // Put back what was there. This is the whole reason `swap_in` keeps
            // the previous database rather than removing it — and the record
            // goes back with it, or the log that returns would be described by
            // a wrap that does not open it.
            backup::unswap(data_dir)?;
            if let Some(old) = &previous {
                write_record(data_dir, old)?;
            }
            *guard = open_log(app, data_dir)?.0;
            return Err(e);
        }
    }
    drop(guard);
    // Not recorded on the session — see the comment in `enable`.
    if let Some(why) = save_keystore_wrap(app, data_dir, &dek) {
        eprintln!("the keystore did not take the key: {why}");
    }
    {
        let mut session = vault.0.lock().map_err(|e| e.to_string())?;
        session.dek = Some(dek);
        session.locked = false;
        session.note = None;
    }

    Ok(RestoreOutcome {
        entries,
        sealed_at: header.sealed_at,
        superseded_path: swapped.superseded.to_string_lossy().to_string(),
        replaced_earlier_superseded: swapped.replaced_earlier,
    })
}

#[cfg(not(target_os = "android"))]
pub fn restore(
    _app: &tauri::AppHandle,
    _data_dir: &Path,
    _user: &crate::store::Store,
    _vault: &Vault,
    _passphrase: &str,
) -> Result<RestoreOutcome, String> {
    Err(NOT_ANDROID.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "trackit-vault-test-{}",
            crate::backup::Dek::new()
                .unwrap()
                .bytes()
                .iter()
                .take(8)
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const PASS: &str = "a passphrase nobody guesses";

    fn cheap_wrap(dek: &Dek) -> Wrap {
        backup::wrap_dek_at(PASS, dek, 8_192, 1, 1).unwrap()
    }

    #[test]
    fn a_phone_with_no_passphrase_has_no_record() {
        let dir = tempdir();
        assert!(read_record(&dir).unwrap().is_none());
    }

    /// The record has to survive a round trip byte for byte, because it is the
    /// only thing on the phone that can turn a passphrase back into the key.
    #[test]
    fn the_recovery_wrap_round_trips_through_the_file_it_is_stored_in() {
        let dir = tempdir();
        let dek = Dek::new().unwrap();
        let w = cheap_wrap(&dek);
        write_record(&dir, &wrap_to_record(&w, true, Some("2026-09-10T12:00:00Z".into()), Some("1.2".into()))).unwrap();

        let back = read_record(&dir).unwrap().unwrap();
        assert!(back.auto_reseal);
        assert_eq!(back.sealed_at.as_deref(), Some("2026-09-10T12:00:00Z"));
        assert_eq!(back.sealed_from.as_deref(), Some("1.2"));
        let w2 = record_to_wrap(&back).unwrap();
        assert_eq!(w2.salt, w.salt);
        assert_eq!(w2.nonce, w.nonce);
        assert_eq!(w2.wrapped, w.wrapped);
        assert_eq!(
            unwrap_dek_bytes(&w2),
            unwrap_dek_bytes(&w),
            "the stored wrap gave back a different key"
        );
        assert_eq!(unwrap_dek_bytes(&w2), *dek.bytes());
    }

    fn unwrap_dek_bytes(w: &Wrap) -> [u8; 32] {
        *backup::unwrap_dek(PASS, w).unwrap().bytes()
    }

    /// A cost parameter in the key record is exactly as untrusted as one in the
    /// sealed file's header — a corrupt file on disk is a corrupt file — so it
    /// must be refused before it reaches Argon2.
    #[test]
    fn an_absurd_cost_in_the_key_record_is_refused() {
        let dir = tempdir();
        let dek = Dek::new().unwrap();
        let mut r = wrap_to_record(&cheap_wrap(&dek), false, None, None);
        r.m_cost = 2_147_549_184;
        write_record(&dir, &r).unwrap();
        let back = read_record(&dir).unwrap().unwrap();
        assert!(record_to_wrap(&back).is_err());
    }

    #[test]
    fn a_truncated_key_record_is_a_sentence_rather_than_a_panic() {
        let dir = tempdir();
        std::fs::create_dir_all(keys_dir(&dir)).unwrap();
        std::fs::write(keys_dir(&dir).join(WRAP_FILE), "{ not json").unwrap();
        assert!(read_record(&dir)
            .unwrap_err()
            .starts_with("this phone's recovery key record is unreadable"));
    }

    #[test]
    fn a_key_record_from_a_newer_build_is_refused_rather_than_read() {
        let dir = tempdir();
        let dek = Dek::new().unwrap();
        let mut r = wrap_to_record(&cheap_wrap(&dek), false, None, None);
        r.version = 2;
        write_record(&dir, &r).unwrap();
        assert!(read_record(&dir)
            .unwrap_err()
            .contains("newer version of TrackIt"));
    }

    #[test]
    fn the_two_passphrases_have_to_match_and_be_long_enough() {
        assert_eq!(
            check_pair(PASS, "something else").unwrap_err(),
            "the two passphrases are not the same"
        );
        assert!(check_pair("short", "short")
            .unwrap_err()
            .starts_with("a recovery passphrase has to be at least"));
        assert!(check_pair(PASS, PASS).is_ok());
    }

    /// The record is written beside and renamed, so a crash mid-write cannot
    /// leave a half a wrap where the whole one was.
    #[test]
    fn writing_the_key_record_leaves_nothing_half_written_behind() {
        let dir = tempdir();
        let dek = Dek::new().unwrap();
        write_record(&dir, &wrap_to_record(&cheap_wrap(&dek), false, None, None)).unwrap();
        write_record(&dir, &wrap_to_record(&cheap_wrap(&dek), true, None, None)).unwrap();
        assert!(!keys_dir(&dir).join(format!("{WRAP_FILE}.new")).exists());
        assert!(read_record(&dir).unwrap().unwrap().auto_reseal);
    }

    /// mtime was the obvious staleness test and it was wrong. The fingerprint
    /// has to be unchanged by a launch and changed by a meal.
    #[test]
    fn the_fingerprint_moves_when_something_is_logged_and_not_when_nothing_is() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::store::SCHEMA).unwrap();
        crate::store::ensure_device_identity(&conn).unwrap();
        let before = fingerprint(&conn).unwrap();
        assert_eq!(before, fingerprint(&conn).unwrap());

        crate::store::add(
            &conn,
            "2026-09-10",
            Some("lunch"),
            crate::store::Source::Food(167763),
            "chinta pandu",
            crate::store::Quantity::Grams(120.0),
            None,
            &crate::store::Tags::default(),
        )
        .unwrap();
        assert_ne!(before, fingerprint(&conn).unwrap());
    }

    /// A change to the shared kitchen has to move it too, or a phone that only
    /// cooked would never re-seal.
    #[test]
    fn the_fingerprint_moves_when_a_vessel_is_added() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::store::SCHEMA).unwrap();
        crate::store::ensure_device_identity(&conn).unwrap();
        let before = fingerprint(&conn).unwrap();
        crate::store::save_vessel(&conn, None, "katori", 48.0).unwrap();
        assert_ne!(before, fingerprint(&conn).unwrap());
    }

    #[test]
    fn a_desktop_build_answers_every_backup_question_with_a_sentence() {
        // The stubs, exercised where they actually compile. `status` is the one
        // exception on purpose: it answers with `supported: false` so the screen
        // can explain the platform instead of showing an alert.
        assert!(!BackupStatus::unsupported().supported);
        assert_eq!(BackupStatus::unsupported().quota_bytes, backup::QUOTA_BYTES);
        assert!(!KeystoreState::unsupported().available);
    }
}
