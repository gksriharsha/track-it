//! The sealed backup artifact: one file, encrypted with a passphrase the user
//! chooses, that Google's Auto Backup service may carry into their own account.
//!
//! Everything in this module is portable. It knows nothing about Tauri, nothing
//! about JNI and nothing about Android, which is deliberate rather than tidy: a
//! format that can only be exercised with a phone in hand is a format nobody
//! exercises, and the whole point of a backup is that it still opens years
//! later on hardware nobody has yet bought. So the blob format, the seal, the
//! open, the snapshot and the restore staging all run — and are tested — on the
//! developer's Mac. What is genuinely Android-only lives in [`crate::keystore`]
//! and in the Kotlin beside it.
//!
//! See `docs/decisions.md` D18 for why the live database is SQLCipher-encrypted
//! on Android and why this file exists alongside that rather than instead of it.
//!
//! The one property everything here is arranged around: **the sealed file is
//! self-describing.** The passphrase-wrapped data key, the salt and the exact
//! Argon2id cost parameters that wrapped it are written into the file's own
//! header, so no interleaving of a crash on disk can produce a blob nobody can
//! open, and a build that later lowers the cost parameters for slow phones can
//! still open a backup sealed today. It is also what makes a restore onto a
//! phone that has never seen this app possible with nothing but the passphrase.

use std::io::Read;
use std::io::Write;
use std::path::{Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, OsRng, Payload};
use chacha20poly1305::{AeadCore, KeyInit, XChaCha20Poly1305, XNonce};
use rusqlite::Connection;
use zeroize::{Zeroize, Zeroizing};

/// What a TrackIt backup looks like from its first byte, so a file picked out
/// of a restore set can be identified without decrypting anything.
pub const MAGIC: &[u8; 8] = b"TRKITBK1";

/// The layout below, version 1. A file recording a HIGHER number is refused
/// with a sentence rather than parsed on the assumption the fields did not
/// move; that is the difference between "this app is too old for that file"
/// and a wrong answer.
pub const FORMAT_VERSION: u8 = 1;

/// The only key derivation this version knows. Argon2id, [`Version::V0x13`].
pub const KDF_ARGON2ID: u8 = 1;

/// 64 MiB of memory-hard work per attempt, which is what makes a passphrase
/// somebody can remember expensive to guess at scale.
///
/// UNMEASURED ON A PHONE, and the header records what a file was actually
/// sealed with precisely so that this constant can be lowered later without
/// stranding anyone's existing backup.
pub const M_COST_KIB: u32 = 65_536;
pub const T_COST: u32 = 3;

/// One lane, not RFC 9106's four. `argon2` 0.5 has no `parallel` feature, so it
/// hashes sequentially whatever this says; claiming four lanes would describe
/// work that never happens in parallel.
pub const P_COST: u32 = 1;

/// Bytes 0..38 — everything up to and including the salt. This is the
/// associated data for the DEK wrap, and it stops there for a structural
/// reason: the wrap cannot authenticate a header that contains the wrap.
pub const PROLOGUE_LEN: usize = 38;

/// Bytes 0..162 — the whole header, associated data for the payload.
///
/// The whole header, not part of it. The payload is sealed after every header
/// field exists, so there is no circularity here the way there is for the
/// wrap — and a shorter span would leave `sealed_at` unauthenticated, which
/// means a flipped byte would render as a wrong date on the Backup screen with
/// nothing anywhere reporting a problem.
pub const HEADER_LEN: usize = 162;

/// What Google's backup service will carry for one app, named so the screen can
/// print the amount beside the figure rather than a share of it.
///
/// Exceeding it does not produce an error anywhere. Android simply stops
/// backing the app up, and tells nobody — which is why the app checks.
pub const QUOTA_BYTES: u64 = 25 * 1024 * 1024;

/// The accepted window for a cost parameter read out of a file.
///
/// This is not belt and braces. `m_cost` is in KiB and comes out of a header
/// that has not been authenticated yet — it cannot be, because authenticating
/// it is what the derived key is FOR — so a single flipped high bit turns
/// 65,536 (64 MiB) into roughly 2 TiB, and Argon2 allocates that block before
/// anything checks a tag. On a phone that is an out-of-memory kill of the whole
/// process at the exact moment somebody is trying to restore a year of meals.
const M_COST_MIN_KIB: u32 = 8_192;
const M_COST_MAX_KIB: u32 = 262_144;
const T_COST_MAX: u32 = 10;
const P_COST_MAX: u32 = 4;

/// The largest snapshot this build will unpack, and it is a ceiling on the
/// BYTES ACTUALLY READ rather than on the length the header claims.
///
/// `plain_len` is shown to the user and nothing else. Sizing an allocation from
/// it would hand a corrupt file the ability to ask for as much memory as it
/// liked; the gunzip below therefore reads through a `take` and refuses when it
/// runs past this, whatever the header said.
const MAX_PLAIN_BYTES: u64 = 512 * 1024 * 1024;

/// The shortest recovery passphrase this app will accept.
///
/// Twelve rather than eight because there is nothing to reset it with and no
/// server to rate-limit a guess: the only thing standing between a stolen
/// backup file and a year of somebody's meals is the cost of Argon2id times the
/// number of candidates.
const MIN_PASSPHRASE: usize = 12;

// ---------------------------------------------------------------------------
// The data key
// ---------------------------------------------------------------------------

/// The 32 bytes that key SQLCipher on Android and seal the payload here.
///
/// Wrapped twice and never stored bare: once under the recovery passphrase, in
/// the sealed file's own header, and once under an Android Keystore key that
/// requires no user authentication, in a file beside the database. That second
/// copy is convenience only. Losing it costs one passphrase prompt; it can
/// never cost history, which is the property the whole opt-in design exists to
/// guarantee.
///
/// No `Debug`, and that absence is deliberate rather than an oversight: a
/// derived one would print the key into whatever `{:?}` it landed in, and the
/// nearest such place is a test failure message. It is why the tests here reach
/// an error through `.err().unwrap()` rather than `unwrap_err()`, which would
/// need the key to be printable.
pub struct Dek([u8; 32]);

impl Dek {
    /// A fresh key from the operating system's generator.
    ///
    /// Reached only from the Android-only halves of [`crate::vault`] — the
    /// conversion, the restore and the Keystore unlock — and from the tests
    /// here. Said with an attribute rather than left as a warning on every
    /// macOS build, because a warning that fires on a correct build is one
    /// people learn to scroll past. The same attribute appears on several items
    /// below for the same reason and is not explained again.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub fn new() -> Result<Dek, String> {
        let mut k = [0u8; 32];
        getrandom(&mut k)?;
        Ok(Dek(k))
    }

    /// Adopt 32 bytes that came back from somewhere they were already stored.
    pub fn from_bytes(b: [u8; 32]) -> Dek {
        Dek(b)
    }

    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// The key in the form SQLCipher's `PRAGMA key` wants for a RAW key.
    ///
    /// The `x'…'` form matters: given a bare string SQLCipher would run it
    /// through its own PBKDF2 and derive a different key, which is both slower
    /// at every open and no stronger than 32 bytes of `getrandom` already are.
    pub fn sqlcipher_key(&self) -> Zeroizing<String> {
        let mut s = String::with_capacity(2 + 64 + 1);
        s.push_str("x'");
        for b in self.0.iter() {
            s.push_str(&format!("{b:02x}"));
        }
        s.push('\'');
        Zeroizing::new(s)
    }
}

impl Drop for Dek {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Fill `out` from the OS generator.
///
/// Goes through the AEAD crate's own `OsRng` rather than adding a `rand` line
/// to the manifest: `chacha20poly1305`'s default features already pull it in,
/// so this is the generator the sealing code is using anyway.
fn getrandom(out: &mut [u8]) -> Result<(), String> {
    use chacha20poly1305::aead::rand_core::RngCore;
    let mut rng = OsRng;
    rng.try_fill_bytes(out)
        .map_err(|e| format!("this device would not produce random bytes: {e}"))
}

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

/// What a passphrase has to be run through to get the data key back.
///
///   0..8    magic          8   "TRKITBK1"
///   8       format_version 1
///   9       kdf_id         1   1 = Argon2id, Version::V0x13
///  10..14   m_cost KiB     4   LE u32   } recorded, not assumed, so a build
///  14..18   t_cost         4   LE u32   } that lowers these for slow phones
///  18..22   p_cost         4   LE u32   } can still open a backup made today
///  22..38   salt          16            <- prologue ends; AAD for the wrap
///  38..62   wrap_nonce    24
///  62..110  wrapped_dek   48            32-byte key + 16-byte Poly1305 tag
/// 110..134  payload_nonce 24
/// 134..142  plain_len      8   LE u64   uncompressed snapshot size, for the UI
/// 142..162  sealed_at     20   ASCII    "2026-09-10T12:00:00Z"  <- header ends
/// 162..     ciphertext          XChaCha20-Poly1305(DEK, gzip(snapshot))
#[derive(Clone, Copy)]
pub struct Wrap {
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    pub salt: [u8; 16],
    pub nonce: [u8; 24],
    pub wrapped: [u8; 48],
}

/// Everything readable from a sealed file WITHOUT the passphrase.
///
/// Deliberately not much. It is what the screen can honestly say about a file
/// before anybody has proved they can open it, and it is what a restore uses to
/// decide whether this build understands the format at all.
#[derive(Debug, serde::Serialize)]
pub struct HeaderView {
    pub format_version: u8,
    pub kdf: u8,
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    /// The snapshot's uncompressed size as the sealing build recorded it. A
    /// figure to show, never a size to allocate.
    pub plain_bytes: u64,
    pub sealed_at: String,
}

/// Refuse cost parameters outside the window this build will honour.
///
/// Called from [`read_header`] BEFORE anything derived from them allocates.
/// See [`M_COST_MIN_KIB`] for the failure this closes.
fn validate_costs(m: u32, t: u32, p: u32) -> Result<(), String> {
    if !(M_COST_MIN_KIB..=M_COST_MAX_KIB).contains(&m)
        || !(1..=T_COST_MAX).contains(&t)
        || !(1..=P_COST_MAX).contains(&p)
    {
        return Err(
            "that backup asks for more memory than this phone will give it, so it was not opened"
                .into(),
        );
    }
    Ok(())
}

/// Refuse a wrap whose recorded costs are outside the accepted window.
///
/// The same bound [`read_header`] applies, exposed for the wrap kept in a file
/// beside the database. A corrupt file on disk is exactly as untrusted as a
/// corrupt file that arrived from a backup service, and Argon2 allocates its
/// block before it authenticates anything.
pub fn validate_wrap(w: &Wrap) -> Result<(), String> {
    validate_costs(w.m_cost, w.t_cost, w.p_cost)
}

/// Read the fixed header off the front of a sealed file.
///
/// Every field is bounded here, at the one place a file becomes numbers, rather
/// than at each use — a second check somewhere else would be a second thing to
/// keep in step, and the weaker one would become the way in.
pub fn read_header(blob: &[u8]) -> Result<HeaderView, String> {
    if blob.len() < HEADER_LEN {
        return Err("that file is too short to be a TrackIt backup".into());
    }
    if &blob[0..8] != MAGIC {
        return Err("that file was not written by TrackIt".into());
    }
    let format_version = blob[8];
    if format_version > FORMAT_VERSION {
        return Err(
            "that backup was sealed by a newer version of TrackIt than this one, so this build \
             cannot read it"
                .into(),
        );
    }
    let kdf = blob[9];
    if kdf != KDF_ARGON2ID {
        return Err("that backup was sealed with a key derivation this build does not know".into());
    }
    let m_cost = u32_at(blob, 10);
    let t_cost = u32_at(blob, 14);
    let p_cost = u32_at(blob, 18);
    validate_costs(m_cost, t_cost, p_cost)?;
    let plain_bytes = u64_at(blob, 134);
    if plain_bytes > MAX_PLAIN_BYTES {
        return Err("that backup claims to hold more than this build will unpack".into());
    }
    // ASCII only, and exactly the shape `store::now_iso` writes. A date is
    // rendered on a screen, so a header carrying control characters or invalid
    // UTF-8 would be a corrupt file quietly becoming corrupt copy.
    let sealed_at = std::str::from_utf8(&blob[142..162])
        .map_err(|_| "that backup's date is not readable, so the file was not opened".to_string())?;
    if !sealed_at
        .chars()
        .all(|c| c.is_ascii_digit() || c == '-' || c == ':' || c == 'T' || c == 'Z')
    {
        return Err("that backup's date is not readable, so the file was not opened".into());
    }
    Ok(HeaderView {
        format_version,
        kdf,
        m_cost_kib: m_cost,
        t_cost,
        p_cost,
        plain_bytes,
        sealed_at: sealed_at.to_string(),
    })
}

/// The wrap a sealed file carries, so its own passphrase can open it.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn wrap_from_blob(blob: &[u8]) -> Result<Wrap, String> {
    let h = read_header(blob)?;
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&blob[22..38]);
    let mut nonce = [0u8; 24];
    nonce.copy_from_slice(&blob[38..62]);
    let mut wrapped = [0u8; 48];
    wrapped.copy_from_slice(&blob[62..110]);
    Ok(Wrap {
        m_cost: h.m_cost_kib,
        t_cost: h.t_cost,
        p_cost: h.p_cost,
        salt,
        nonce,
        wrapped,
    })
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn u64_at(b: &[u8], at: usize) -> u64 {
    let mut n = [0u8; 8];
    n.copy_from_slice(&b[at..at + 8]);
    u64::from_le_bytes(n)
}

// ---------------------------------------------------------------------------
// Wrapping the key under a passphrase
// ---------------------------------------------------------------------------

/// What the app will and will not accept as a recovery passphrase.
///
/// The refusals are sentences the screen shows unchanged, because the reason a
/// passphrase was refused is the only useful thing to say about it.
pub fn check_passphrase(p: &str) -> Result<(), String> {
    if p.chars().count() < MIN_PASSPHRASE {
        return Err(format!(
            "a recovery passphrase has to be at least {MIN_PASSPHRASE} characters — it is the \
             only thing that can open the sealed copy, and there is nothing to reset it with"
        ));
    }
    if p.trim().is_empty() {
        return Err("a recovery passphrase of spaces is one nobody can type twice".into());
    }
    Ok(())
}

/// Derive the wrapping key from a passphrase at the recorded costs.
fn derive(passphrase: &str, w: &Wrap) -> Result<Zeroizing<[u8; 32]>, String> {
    validate_costs(w.m_cost, w.t_cost, w.p_cost)?;
    let params = Params::new(w.m_cost, w.t_cost, w.p_cost, Some(32))
        .map_err(|e| format!("argon2 parameters: {e}"))?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), &w.salt, key.as_mut())
        .map_err(|e| format!("deriving a key from that passphrase: {e}"))?;
    Ok(key)
}

/// The 38-byte prologue that authenticates a wrap, built from a wrap.
///
/// Assembled rather than sliced out of the blob, so the wrap that goes INTO a
/// file and the wrap read back OUT of one authenticate against byte-for-byte
/// the same associated data. Two constructions of the same bytes would be two
/// things to keep in step.
fn prologue(w: &Wrap) -> [u8; PROLOGUE_LEN] {
    let mut p = [0u8; PROLOGUE_LEN];
    p[0..8].copy_from_slice(MAGIC);
    p[8] = FORMAT_VERSION;
    p[9] = KDF_ARGON2ID;
    p[10..14].copy_from_slice(&w.m_cost.to_le_bytes());
    p[14..18].copy_from_slice(&w.t_cost.to_le_bytes());
    p[18..22].copy_from_slice(&w.p_cost.to_le_bytes());
    p[22..38].copy_from_slice(&w.salt);
    p
}

/// Wrap a data key under a passphrase, at this build's cost parameters.
///
/// A fresh salt and a fresh nonce every time, so two wraps of one passphrase
/// share nothing — the same passphrase used on two phones must not produce two
/// identical headers, or the header itself would say the two files came from
/// the same person.
pub fn wrap_dek(passphrase: &str, dek: &Dek) -> Result<Wrap, String> {
    wrap_dek_at(passphrase, dek, M_COST_KIB, T_COST, P_COST)
}

/// [`wrap_dek`] with the costs named, which the tests use to keep CI out of
/// Argon2 for minutes at a time.
pub fn wrap_dek_at(
    passphrase: &str,
    dek: &Dek,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<Wrap, String> {
    check_passphrase(passphrase)?;
    let mut salt = [0u8; 16];
    getrandom(&mut salt)?;
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let mut w = Wrap {
        m_cost,
        t_cost,
        p_cost,
        salt,
        nonce: nonce.into(),
        wrapped: [0u8; 48],
    };
    let key = derive(passphrase, &w)?;
    let sealed = XChaCha20Poly1305::new(key.as_ref().into())
        .encrypt(
            &nonce,
            Payload {
                msg: dek.bytes(),
                aad: &prologue(&w),
            },
        )
        .map_err(|_| "sealing the data key failed on this device".to_string())?;
    if sealed.len() != 48 {
        return Err("sealing the data key produced the wrong length".into());
    }
    w.wrapped.copy_from_slice(&sealed);
    Ok(w)
}

/// Recover the data key from a wrap and the passphrase that made it.
///
/// A wrong passphrase surfaces here as an AEAD tag failure — one sentence —
/// rather than as 32 bytes of rubbish that would go on to open nothing and
/// report a corrupt database.
pub fn unwrap_dek(passphrase: &str, w: &Wrap) -> Result<Dek, String> {
    let key = derive(passphrase, w)?;
    let out = XChaCha20Poly1305::new(key.as_ref().into())
        .decrypt(
            XNonce::from_slice(&w.nonce),
            Payload {
                msg: &w.wrapped,
                aad: &prologue(w),
            },
        )
        .map_err(|_| "that passphrase does not open this backup".to_string())?;
    let mut k = [0u8; 32];
    if out.len() != 32 {
        return Err("that passphrase does not open this backup".into());
    }
    k.copy_from_slice(&out);
    Ok(Dek::from_bytes(k))
}

// ---------------------------------------------------------------------------
// Sealing and opening
// ---------------------------------------------------------------------------

/// Build the sealed file: header, then the gzipped snapshot under the data key.
pub fn seal(
    dek: &Dek,
    w: &Wrap,
    gzipped: &[u8],
    plain_len: u64,
    sealed_at: &str,
) -> Result<Vec<u8>, String> {
    if sealed_at.len() != 20 || !sealed_at.is_ascii() {
        return Err(format!(
            "a sealing time has to be 20 ASCII characters like 2026-09-10T12:00:00Z, not {sealed_at:?}"
        ));
    }
    let payload_nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);

    let mut header = [0u8; HEADER_LEN];
    header[0..PROLOGUE_LEN].copy_from_slice(&prologue(w));
    header[38..62].copy_from_slice(&w.nonce);
    header[62..110].copy_from_slice(&w.wrapped);
    header[110..134].copy_from_slice(payload_nonce.as_slice());
    header[134..142].copy_from_slice(&plain_len.to_le_bytes());
    header[142..162].copy_from_slice(sealed_at.as_bytes());

    let ct = XChaCha20Poly1305::new(dek.bytes().into())
        .encrypt(
            &payload_nonce,
            Payload {
                msg: gzipped,
                aad: &header,
            },
        )
        .map_err(|_| "sealing the backup failed on this device".to_string())?;

    let mut out = Vec::with_capacity(HEADER_LEN + ct.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Open a sealed file with the passphrase recorded in its own header.
///
/// Hands back the DATA KEY as well as the gzipped snapshot, and that is not
/// convenience: the key that opened the file is the key the restored database
/// gets encrypted under, and deriving it a second time would be another second
/// and a half of Argon2id for a value already sitting in a register. Returning
/// it is also what keeps this the only way a sealed file is ever opened —
/// nothing has to reach past it and repeat the two steps.
///
/// Two AEAD checks, and both matter. The first says the passphrase is right;
/// the second says nothing in the header or the ciphertext has moved since it
/// was sealed — which is what makes the `sealed_at` date on the Backup screen a
/// fact rather than twenty bytes anybody could have written.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn open_blob(passphrase: &str, blob: &[u8]) -> Result<(Dek, Zeroizing<Vec<u8>>), String> {
    let w = wrap_from_blob(blob)?;
    let dek = unwrap_dek(passphrase, &w)?;
    let gz = open_payload(&dek, blob)?;
    Ok((dek, gz))
}

/// The payload half of [`open_blob`], once the data key is in hand.
///
/// Separate so the byte-flip test can prove that the payload's own tag covers
/// the whole header without a passphrase derivation standing in front of every
/// assertion.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn open_payload(dek: &Dek, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    // Re-read the header so a caller cannot hand this a blob it never validated.
    read_header(blob)?;
    let gz = XChaCha20Poly1305::new(dek.bytes().into())
        .decrypt(
            XNonce::from_slice(&blob[110..134]),
            Payload {
                msg: &blob[HEADER_LEN..],
                aad: &blob[0..HEADER_LEN],
            },
        )
        .map_err(|_| {
            "that backup file has been damaged since it was sealed, so it was not opened"
                .to_string()
        })?;
    Ok(Zeroizing::new(gz))
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/// Copy the live database and hand back `(gzip(snapshot), uncompressed length)`.
///
/// Into a memory database and then `serialize`, rather than `VACUUM INTO` a
/// temporary file. The reason is not speed: it is that no plaintext copy of the
/// log is ever written to disk, not even briefly, on a phone whose whole reason
/// for encrypting the database was that a file in the data directory is
/// readable by anything that can reach the data directory.
///
/// Be honest about the cost. A `:memory:` database opens through the DEFAULT
/// VFS, not the memdb one, so
/// `SQLITE_SERIALIZE_NOCOPY` does not apply and `sqlite3_serialize` mallocs a
/// second full-size buffer and copies into it page by page. The peak is
/// therefore roughly TWICE the database plus the compressed buffer, and that is
/// the number to judge this against — a 20 MB log is 40-something MB of native
/// heap for a moment, which is affordable, and `VACUUM INTO` would trade it for
/// a plaintext file on disk, which is not.
///
/// The source connection is SQLCipher-keyed and the destination is not, so what
/// comes back is a PLAINTEXT SQLite database inside a sealed envelope. That is
/// on purpose: a restore then only has to open bytes.
///
/// `encrypted` says which of two copying mechanisms to use, and it is a
/// parameter rather than something detected here because getting it wrong is
/// invisible until it runs on a phone. SQLCipher REFUSES the online-backup API
/// on a keyed database — "backup is not supported with encrypted databases" —
/// so the encrypted path goes through `sqlcipher_export` into an attached
/// in-memory plaintext database instead, which is SQLCipher's own supported way
/// to decrypt a whole database. The plaintext path keeps the backup API,
/// because `sqlcipher_export` does not exist at all in the plain SQLite the Mac
/// compiles, which is exactly why the first version of this function passed
/// every test here and then failed on the first device that ran it.
pub fn snapshot(live: &Connection, encrypted: bool) -> Result<(Zeroizing<Vec<u8>>, u64), String> {
    let plain: Zeroizing<Vec<u8>> = if encrypted {
        // The attached database is created by the ATTACH and lives only in this
        // connection, so the DETACH below is what frees it. `KEY ''` is the
        // documented way to say "not encrypted" to a SQLCipher ATTACH.
        live.execute("ATTACH DATABASE ':memory:' AS trackit_plain KEY ''", [])
            .map_err(|e| format!("preparing a copy of the log: {e}"))?;
        let copied = live
            .query_row("SELECT sqlcipher_export('trackit_plain')", [], |_| Ok(()))
            .map_err(|e| format!("copying the log: {e}"));
        // Read it back BEFORE detaching, and detach whatever happened above, so
        // a failure cannot leave the schema attached to a connection the app
        // goes on using. The bytes are copied here rather than returned, because
        // what `serialize` hands back borrows the connection it came from.
        let read = copied.and_then(|()| {
            live.serialize(c"trackit_plain")
                .map(|d| Zeroizing::new(d.to_vec()))
                .map_err(|e| format!("reading the copy of the log back: {e}"))
        });
        let _ = live.execute("DETACH DATABASE trackit_plain", []);
        read?
    } else {
        let mut mem = Connection::open_in_memory()
            .map_err(|e| format!("preparing a copy of the log: {e}"))?;
        {
            let bk = rusqlite::backup::Backup::new(live, &mut mem)
                .map_err(|e| format!("copying the log: {e}"))?;
            bk.run_to_completion(1_000, std::time::Duration::ZERO, None)
                .map_err(|e| format!("copying the log: {e}"))?;
        }
        let d = mem
            .serialize(rusqlite::MAIN_DB)
            .map_err(|e| format!("reading the copy of the log back: {e}"))?;
        Zeroizing::new(d.to_vec())
    };
    let plain_len = plain.len() as u64;

    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(plain.as_slice())
        .map_err(|e| format!("compressing the copy of the log: {e}"))?;
    let gz = enc
        .finish()
        .map_err(|e| format!("compressing the copy of the log: {e}"))?;
    Ok((Zeroizing::new(gz), plain_len))
}

/// Unpack a gzipped snapshot, refusing to run past [`MAX_PLAIN_BYTES`].
///
/// The ceiling is on bytes actually read, and the header's `plain_len` never
/// sizes the buffer. A corrupt or hostile file that claims two bytes and then
/// decompresses forever is a gzip bomb; reading through `take` turns it into a
/// sentence.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn gunzip(gzipped: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    gunzip_to(gzipped, MAX_PLAIN_BYTES)
}

/// [`gunzip`] with the ceiling named.
///
/// The ceiling is a parameter for one reason and it is a good one: proving that
/// a bomb is refused means building a file that unpacks past the ceiling, and at
/// 512 MiB that is half a gigabyte of CI memory and eighteen seconds to
/// construct a buffer the assertion never looks at. The property — reads through
/// a `take`, refuses when it runs past, never sizes an allocation from a header
/// figure — is the same property at any ceiling, so the test uses a small one
/// and a separate assertion pins what [`gunzip`] itself passes in.
fn gunzip_to(gzipped: &[u8], ceiling: u64) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut out = Zeroizing::new(Vec::new());
    let mut dec = flate2::read::GzDecoder::new(gzipped).take(ceiling + 1);
    dec.read_to_end(out.as_mut())
        .map_err(|e| format!("unpacking that backup: {e}"))?;
    if out.len() as u64 > ceiling {
        return Err("that backup unpacks to more than this build will accept".into());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Writing the file
// ---------------------------------------------------------------------------

/// The sealed file's name inside the one directory Android is told it may
/// carry. Fixed, because the backup rules name it literally.
pub const SEALED_NAME: &str = "trackit-backup.tkb";

/// The single way the sealed file is ever written.
///
/// Write beside it, flush, fsync the file, rename, fsync the DIRECTORY. Android's
/// backup agent reads this path on the system's own schedule with no
/// coordination with the app whatsoever, so a plain `write` leaves a window in
/// which the transferred artifact is a truncated ciphertext whose tag will not
/// verify — and that is discovered a year later, on a new phone, which is
/// exactly the silent failure this whole feature exists to prevent. Every seal
/// goes through here for that reason: one path, held to the discipline, rather
/// than three that have to remember it.
pub fn write_sealed(dir: &Path, blob: &[u8]) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let final_path = dir.join(SEALED_NAME);
    let tmp = dir.join(format!("{SEALED_NAME}.new"));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        f.write_all(blob)
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("flush {}: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, &final_path)
        .map_err(|e| format!("replace {}: {e}", final_path.display()))?;
    // The rename itself is only durable once the directory entry is. Ignored on
    // a platform that will not open a directory, because the rename has already
    // happened and refusing the whole seal over an unflushed dentry would be
    // worse than the risk.
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(final_path)
}

// ---------------------------------------------------------------------------
// Restore and the crash windows around it
// ---------------------------------------------------------------------------

/// The database being replaced, renamed rather than removed.
///
/// One deterministic name, and that is the whole point. A timestamped name
/// would pile up full copies of the log on a phone for ever; a name that is
/// reused without checking would let a second restore destroy the safety net
/// the first one left. So the name is fixed and a restore REFUSES while one is
/// still there, which turns "your previous log was silently overwritten" into a
/// sentence naming a file the user can decide about.
pub const SUPERSEDED: &str = "user.db.superseded";

/// Where a staged database lives until it is known to open.
pub const STAGED: &str = "user.db.restoring";

/// Where the plaintext database lives during the one-time conversion to
/// SQLCipher, and after it until the encrypted one has opened.
pub const CONVERTING: &str = "user.db.converting";

/// The plaintext database a completed conversion superseded.
pub const PLAIN_SUPERSEDED: &str = "user.db.plaintext-superseded";

/// Whether a file begins with SQLite's own magic.
///
/// This is how the app decides whether the log is encrypted, and it is
/// deliberately not a flag in a settings file. It asks the FILE what shape it
/// is in, the way every migration arm in `store.rs` asks the database rather
/// than trusting a version number a half-finished upgrade may have written. A
/// SQLCipher database's first page is ciphertext, so it cannot begin with
/// "SQLite format 3"; a plaintext one always does.
pub fn is_plain_sqlite(path: &Path) -> Result<bool, String> {
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        // Absent is not encrypted. A database that does not exist yet will be
        // created plaintext, and the caller decides what to do about that.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let mut head = [0u8; 16];
    match f.read_exact(&mut head) {
        Ok(()) => Ok(&head == b"SQLite format 3\0"),
        // A file shorter than one header is an empty database SQLite has not
        // written a page to yet, which is plaintext by construction.
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(true),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// What a recovery pass at launch found and did, in a sentence for the log.
pub enum Recovered {
    Nothing,
    PutBackPlaintext,
    PutBackSuperseded,
    DiscardedStaged,
}

/// Put the log back if the process died between the two renames.
///
/// Called from `init_state` BEFORE the database is opened, and it exists for
/// one window: a restore and the one-time conversion both rename `user.db` out
/// of the way and then rename a replacement in, and between those two calls
/// there is no `user.db` at all. `store::open` would cheerfully create an empty
/// one there, and a year of meals would be gone with no error anywhere — which
/// is the single worst thing this feature could do, so it is the thing checked
/// first.
///
/// The rule when both candidates exist is always the same: put back the file
/// that is known to hold everything, and throw away the one that was never
/// live. Nothing is lost by preferring the old database; a great deal is lost
/// by guessing the other way.
pub fn recover_interrupted(data_dir: &Path) -> Result<Recovered, String> {
    let live = data_dir.join("user.db");
    let staged = data_dir.join(STAGED);
    let converting = data_dir.join(CONVERTING);
    let superseded = data_dir.join(SUPERSEDED);
    let plain = data_dir.join(PLAIN_SUPERSEDED);

    if live.exists() {
        // The live database is there, so nothing was interrupted mid-rename. A
        // half-written staging file may still be lying about; it was never
        // live, so it is safe — and important — to remove.
        let mut discarded = false;
        for p in [&staged, &converting] {
            if p.exists() {
                std::fs::remove_file(p).map_err(|e| format!("remove {}: {e}", p.display()))?;
                discarded = true;
            }
        }
        return Ok(if discarded {
            Recovered::DiscardedStaged
        } else {
            Recovered::Nothing
        });
    }

    // No live database. Prefer the plaintext one a conversion set aside, then
    // the one a restore set aside; both hold the whole log.
    if plain.exists() {
        std::fs::rename(&plain, &live).map_err(|e| format!("restore {}: {e}", live.display()))?;
        for p in [&staged, &converting] {
            if p.exists() {
                let _ = std::fs::remove_file(p);
            }
        }
        return Ok(Recovered::PutBackPlaintext);
    }
    if superseded.exists() {
        std::fs::rename(&superseded, &live)
            .map_err(|e| format!("restore {}: {e}", live.display()))?;
        for p in [&staged, &converting] {
            if p.exists() {
                let _ = std::fs::remove_file(p);
            }
        }
        return Ok(Recovered::PutBackSuperseded);
    }
    // Nothing to put back. This is a fresh install, which is the ordinary case
    // and not a fault.
    Ok(Recovered::Nothing)
}

/// Remove the write-ahead log and shared-memory files belonging to `db`.
///
/// They belong to the database that was just moved, not to the one moving in,
/// and SQLite reads a `-wal` sitting beside a database it never wrote. Leaving
/// them is not a tidiness problem: it is frames from one database being
/// replayed against another.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn drop_sidecars(db: &Path) -> Result<(), String> {
    for suffix in ["-wal", "-shm"] {
        let mut name = db.as_os_str().to_os_string();
        name.push(suffix);
        let p = PathBuf::from(name);
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| format!("remove {}: {e}", p.display()))?;
        }
    }
    Ok(())
}

/// What a completed swap did with the database it replaced.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct Swapped {
    /// Where the log that was live before this now lives. Renamed, never
    /// removed, and named here so the screen can tell the user about it.
    pub superseded: PathBuf,
    /// Whether an EARLIER restore's superseded copy had to be removed to make
    /// room for this one.
    ///
    /// Reported rather than done quietly. Exactly one superseded copy is kept,
    /// because the alternative is a phone accumulating full copies of the log
    /// under timestamped names for ever — but a safety net disappearing is
    /// something the person who set it up is entitled to be told about.
    pub replaced_earlier: bool,
}

/// Move a verified staged database into place, keeping the one it replaces.
///
/// The ordering here is the whole of the danger, and it is arranged so that the
/// only window in which `user.db` does not exist is the one
/// [`recover_interrupted`] knows how to close. The staged database must ALREADY
/// have been opened and verified by the caller — a swap that stages an
/// unopenable file and discovers it afterwards has nothing left to fail back to.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn swap_in(data_dir: &Path, staged: &Path) -> Result<Swapped, String> {
    let live = data_dir.join("user.db");
    let superseded = data_dir.join(SUPERSEDED);

    let replaced_earlier = superseded.exists();
    if replaced_earlier {
        std::fs::remove_file(&superseded)
            .map_err(|e| format!("remove {}: {e}", superseded.display()))?;
    }
    if live.exists() {
        std::fs::rename(&live, &superseded)
            .map_err(|e| format!("set aside {}: {e}", live.display()))?;
    }
    // The write-ahead log and shared memory belonged to the database that just
    // moved. Left behind, SQLite would replay one database's frames against
    // another's pages, which is corruption rather than untidiness.
    drop_sidecars(&live)?;
    std::fs::rename(staged, &live).map_err(|e| format!("move {}: {e}", live.display()))?;
    drop_sidecars(staged)?;
    Ok(Swapped {
        superseded,
        replaced_earlier,
    })
}

/// Put back the database a swap set aside, because what came in would not open.
///
/// The failure path [`swap_in`] exists to make survivable. Without it a reopen
/// that fails after the rename leaves the app holding nothing and the log
/// sitting under a name no launch looks for.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn unswap(data_dir: &Path) -> Result<(), String> {
    let live = data_dir.join("user.db");
    let superseded = data_dir.join(SUPERSEDED);
    if !superseded.exists() {
        return Err("there is no earlier log to put back".into());
    }
    if live.exists() {
        std::fs::remove_file(&live).map_err(|e| format!("remove {}: {e}", live.display()))?;
    }
    drop_sidecars(&live)?;
    std::fs::rename(&superseded, &live).map_err(|e| format!("restore {}: {e}", live.display()))?;
    Ok(())
}

/// Copy one database into a new file, encrypting or decrypting on the way.
///
/// `ATTACH` plus `sqlcipher_export`, which is SQLCipher's own supported way of
/// moving a whole database between keys — schema, indexes and triggers
/// included.
///
/// Android only, because `sqlcipher_export` is a SQLCipher function and the
/// macOS build is plain SQLite. `from_key` and `to_key` are the `x'…'` raw-key
/// form, or `None` for plaintext at that end — so this one function is both the
/// one-time conversion of an existing plaintext log and its reverse.
#[cfg(target_os = "android")]
pub fn convert(
    from: &Path,
    from_key: Option<&str>,
    to: &Path,
    to_key: Option<&str>,
) -> Result<(), String> {
    if to.exists() {
        std::fs::remove_file(to).map_err(|e| format!("remove {}: {e}", to.display()))?;
    }
    let conn = Connection::open(from).map_err(|e| format!("open {}: {e}", from.display()))?;
    if let Some(k) = from_key {
        crate::store::apply_key(&conn, k)?;
    }
    // Forces the codec before the ATTACH, so a wrong key is one sentence rather
    // than a half-written destination file.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .map_err(|_| "that key does not unlock this log".to_string())?;

    // The destination path goes in as a bound parameter; the key cannot,
    // because `ATTACH … KEY` takes an expression SQLCipher reads at parse time.
    // It is this build's own hex, never anything a user typed.
    //
    // The key goes through `key_literal`, and the quotes it adds are the whole
    // point: `KEY x'…'` bare is accepted by the parser as a blob literal and
    // then read by SQLCipher as a PASSPHRASE, so the file is written under a
    // key nothing can reproduce. See `store::key_literal`.
    let sql = match to_key {
        Some(k) => format!(
            "ATTACH DATABASE ?1 AS trackit_export KEY {}",
            crate::store::key_literal(k)
        ),
        None => "ATTACH DATABASE ?1 AS trackit_export KEY ''".to_string(),
    };
    conn.execute(&sql, [to.to_string_lossy().as_ref()])
        .map_err(|e| format!("preparing {}: {e}", to.display()))?;
    // Detach whatever the export did, so a failure does not leave the source
    // connection holding a half-written file open.
    let export = conn.query_row("SELECT sqlcipher_export('trackit_export')", [], |_| Ok(()));
    let detach = conn.execute("DETACH DATABASE trackit_export", []);
    export.map_err(|e| format!("copying the log into {}: {e}", to.display()))?;
    detach.map_err(|e| format!("closing {}: {e}", to.display()))?;

    // `user_version` is what tells `store::migrate` there is nothing to do, and
    // `sqlcipher_export` does not carry it. Read it off the source and stamp it
    // on the copy by hand; without this every arm of `migrate` would run again
    // against an already-current database the moment the copy became live.
    let v: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    drop(conn);
    let dest = Connection::open(to).map_err(|e| format!("open {}: {e}", to.display()))?;
    if let Some(k) = to_key {
        crate::store::apply_key(&dest, k)?;
    }
    dest.pragma_update(None, "user_version", v)
        .map_err(|e| format!("stamping {}: {e}", to.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cheapest cost parameters this build will accept.
    ///
    /// Every test seals at the floor rather than at [`M_COST_KIB`]. Argon2id at
    /// 64 MiB times the byte-flip test's 162 iterations is minutes of CI spent
    /// proving something the floor proves just as well.
    const M: u32 = M_COST_MIN_KIB;

    const PASS: &str = "a passphrase nobody guesses";

    fn sealed(plain: &[u8]) -> (Vec<u8>, Dek) {
        let dek = Dek::new().unwrap();
        let w = wrap_dek_at(PASS, &dek, M, 1, 1).unwrap();
        let mut enc =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(plain).unwrap();
        let gz = enc.finish().unwrap();
        let blob = seal(&dek, &w, &gz, plain.len() as u64, "2026-09-10T12:00:00Z").unwrap();
        (blob, dek)
    }

    #[test]
    fn a_sealed_copy_opens_with_the_passphrase_that_sealed_it() {
        let (blob, _) = sealed(b"a plausible database");
        let (_, gz) = open_blob(PASS, &blob).unwrap();
        assert_eq!(gunzip(&gz).unwrap().as_slice(), b"a plausible database");
    }

    #[test]
    fn a_wrong_passphrase_is_refused_rather_than_returning_rubbish() {
        let (blob, _) = sealed(b"a plausible database");
        let e = open_blob("a passphrase nobody guessed", &blob).err().unwrap();
        assert_eq!(e, "that passphrase does not open this backup");
    }

    /// The test the header-as-associated-data choice exists for.
    ///
    /// Every byte of the 162-byte header, one at a time, and split at 38 to say
    /// WHICH authentication is supposed to catch which byte: bytes 0..38 are the
    /// wrap's associated data, and bytes 0..162 are the payload's. It catches an
    /// implementation that authenticates only the ciphertext — under which the
    /// `sealed_at` bytes at 142..162 would flip freely and the Backup screen
    /// would render a date somebody else chose.
    ///
    /// The second half goes through [`open_payload`] with the key already in
    /// hand rather than through [`open_blob`], which is not a shortcut but the
    /// point: it proves the payload's own tag covers those bytes, without a
    /// passphrase derivation standing in front of the assertion. It also keeps
    /// this test to a couple of seconds instead of a couple of minutes, which is
    /// what decides whether it survives in CI.
    #[test]
    fn a_flipped_bit_anywhere_in_the_header_is_refused() {
        let dek = Dek::new().unwrap();
        let w = wrap_dek_at(PASS, &dek, M, 1, 1).unwrap();
        let blob = seal(&dek, &w, b"gzipped-enough", 14, "2026-09-10T12:00:00Z").unwrap();

        for i in 0..PROLOGUE_LEN {
            let mut bad = blob.clone();
            bad[i] ^= 0x01;
            assert!(
                open_blob(PASS, &bad).is_err(),
                "byte {i} of the prologue flipped and the wrap still opened"
            );
        }
        for i in PROLOGUE_LEN..HEADER_LEN {
            let mut bad = blob.clone();
            bad[i] ^= 0x01;
            assert!(
                open_payload(&dek, &bad).is_err(),
                "byte {i} of the header flipped and the payload still opened"
            );
        }
        // And the two halves really are one file end to end.
        assert!(open_blob(PASS, &blob).is_ok());
    }

    /// The span a shorter associated-data window would have left unauthenticated,
    /// called out by name because the whole header is authenticated for exactly
    /// this reason: this app prints these twenty bytes on a screen.
    #[test]
    fn a_flipped_bit_in_the_sealing_date_is_refused() {
        let dek = Dek::new().unwrap();
        let w = wrap_dek_at(PASS, &dek, M, 1, 1).unwrap();
        let blob = seal(&dek, &w, b"x", 1, "2026-09-10T12:00:00Z").unwrap();
        for i in 142..162 {
            let mut bad = blob.clone();
            bad[i] ^= 0x01;
            assert!(
                open_payload(&dek, &bad).is_err(),
                "the sealing date at {i} was not authenticated"
            );
        }
    }

    #[test]
    fn a_flipped_bit_in_the_ciphertext_is_refused() {
        let (blob, _) = sealed(b"a plausible database");
        let mut bad = blob.clone();
        let last = bad.len() - 1;
        bad[last] ^= 0x01;
        let e = open_blob(PASS, &bad).err().unwrap();
        assert_eq!(
            e,
            "that backup file has been damaged since it was sealed, so it was not opened"
        );
    }

    #[test]
    fn the_header_records_the_costs_it_was_sealed_with() {
        let dek = Dek::new().unwrap();
        let w = wrap_dek_at(PASS, &dek, M, 2, 3).unwrap();
        let blob = seal(&dek, &w, b"", 0, "2026-09-10T12:00:00Z").unwrap();
        let h = read_header(&blob).unwrap();
        assert_eq!((h.m_cost_kib, h.t_cost, h.p_cost), (M, 2, 3));
        // And a build whose own defaults have since changed still opens it,
        // because opening derives at the RECORDED costs.
        assert!(open_blob(PASS, &blob).is_ok());
    }

    #[test]
    fn a_file_that_is_not_ours_is_refused_by_its_magic() {
        let mut blob = vec![0u8; HEADER_LEN + 16];
        blob[0..8].copy_from_slice(b"NOTOURS1");
        assert_eq!(
            read_header(&blob).unwrap_err(),
            "that file was not written by TrackIt"
        );
    }

    #[test]
    fn a_newer_format_version_is_refused_with_a_sentence_rather_than_parsed() {
        let (mut blob, _) = sealed(b"x");
        blob[8] = FORMAT_VERSION + 1;
        assert!(read_header(&blob)
            .unwrap_err()
            .contains("newer version of TrackIt"));
    }

    /// The memory-exhaustion kill, under test.
    ///
    /// A single flipped high bit in `m_cost` turns 8 MiB into terabytes, and
    /// Argon2 would allocate that block before any tag was checked. The refusal
    /// has to come out of `read_header`, before anything derives anything.
    #[test]
    fn an_absurd_argon2_cost_in_the_header_is_refused_before_anything_allocates() {
        let (mut blob, _) = sealed(b"x");
        blob[10..14].copy_from_slice(&2_147_549_184u32.to_le_bytes());
        let e = read_header(&blob).unwrap_err();
        assert_eq!(
            e,
            "that backup asks for more memory than this phone will give it, so it was not opened"
        );
        // And nothing further in the chain will derive from it either.
        assert!(open_blob(PASS, &blob).is_err());
    }

    #[test]
    fn a_cost_below_the_floor_is_refused_too() {
        let (mut blob, _) = sealed(b"x");
        blob[10..14].copy_from_slice(&1u32.to_le_bytes());
        assert!(read_header(&blob).is_err());
        blob[10..14].copy_from_slice(&M.to_le_bytes());
        blob[18..22].copy_from_slice(&99u32.to_le_bytes());
        assert!(read_header(&blob).is_err());
    }

    #[test]
    fn a_claimed_length_beyond_the_ceiling_is_refused() {
        let (mut blob, _) = sealed(b"x");
        blob[134..142].copy_from_slice(&(u64::MAX).to_le_bytes());
        assert!(read_header(&blob)
            .unwrap_err()
            .contains("more than this build will unpack"));
    }

    /// A gzip bomb cannot be answered by trusting the header's length.
    ///
    /// Four megabytes of zeroes compresses to a handful of kilobytes, which is
    /// what a bomb actually looks like: a small file with an enormous inside.
    /// Tested against a small ceiling for the reason `gunzip_to`'s own comment
    /// gives, and the real ceiling is pinned separately below.
    #[test]
    fn a_snapshot_that_unpacks_past_the_ceiling_is_refused() {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let block = vec![0u8; 1024 * 1024];
        for _ in 0..4 {
            enc.write_all(&block).unwrap();
        }
        let gz = enc.finish().unwrap();
        assert!(gz.len() < 64 * 1024, "the bomb is not small, so it is not a bomb");
        assert_eq!(
            gunzip_to(&gz, 1024 * 1024).unwrap_err(),
            "that backup unpacks to more than this build will accept"
        );
        // Exactly at the ceiling is fine; one byte over is not. The boundary is
        // the whole of the arithmetic, and an off-by-one here would refuse a
        // legitimate backup of exactly the largest permitted size.
        assert_eq!(gunzip_to(&gz, 4 * 1024 * 1024).unwrap().len(), 4 * 1024 * 1024);
        assert!(gunzip_to(&gz, 4 * 1024 * 1024 - 1).is_err());
    }

    /// What [`gunzip`] actually enforces, so the cheap test above is about the
    /// shipped number rather than about an arbitrary one.
    #[test]
    fn the_shipped_ceiling_is_the_one_the_header_bound_agrees_with() {
        assert_eq!(MAX_PLAIN_BYTES, 512 * 1024 * 1024);
        let mut blob = vec![0u8; HEADER_LEN];
        blob[0..8].copy_from_slice(MAGIC);
        blob[8] = FORMAT_VERSION;
        blob[9] = KDF_ARGON2ID;
        blob[10..14].copy_from_slice(&M.to_le_bytes());
        blob[14..18].copy_from_slice(&1u32.to_le_bytes());
        blob[18..22].copy_from_slice(&1u32.to_le_bytes());
        blob[142..162].copy_from_slice(b"2026-09-10T12:00:00Z");
        // One byte over the ceiling is refused by the header check, so nothing
        // downstream ever sees a claimed length it would have to bound again.
        blob[134..142].copy_from_slice(&(MAX_PLAIN_BYTES + 1).to_le_bytes());
        assert!(read_header(&blob).is_err());
        blob[134..142].copy_from_slice(&MAX_PLAIN_BYTES.to_le_bytes());
        assert_eq!(read_header(&blob).unwrap().plain_bytes, MAX_PLAIN_BYTES);
    }

    #[test]
    fn two_wraps_of_one_passphrase_share_nothing() {
        let dek = Dek::new().unwrap();
        let a = wrap_dek_at(PASS, &dek, M, 1, 1).unwrap();
        let b = wrap_dek_at(PASS, &dek, M, 1, 1).unwrap();
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.wrapped, b.wrapped);
        // Both still hand back the same key.
        assert_eq!(
            unwrap_dek(PASS, &a).unwrap().bytes(),
            unwrap_dek(PASS, &b).unwrap().bytes()
        );
    }

    #[test]
    fn a_short_passphrase_is_refused_with_the_reason() {
        let e = check_passphrase("short").unwrap_err();
        assert!(e.starts_with("a recovery passphrase has to be at least 12 characters"));
        assert!(!e.ends_with('.'));
    }

    #[test]
    fn the_sqlcipher_key_is_the_raw_thirty_two_bytes_not_a_passphrase() {
        let dek = Dek::from_bytes([0xab; 32]);
        let k = dek.sqlcipher_key();
        assert!(k.starts_with("x'") && k.ends_with('\''));
        assert_eq!(k.len(), 2 + 64 + 1);
        assert!(k.contains("abababab"));
    }

    #[test]
    fn a_sealing_time_that_is_not_twenty_ascii_characters_is_refused() {
        let dek = Dek::new().unwrap();
        let w = wrap_dek_at(PASS, &dek, M, 1, 1).unwrap();
        assert!(seal(&dek, &w, b"", 0, "2026-09-10").is_err());
    }

    /// Compression is the reason the 25 MB quota is reachable at all, so it is
    /// worth asserting rather than assuming.
    #[test]
    fn a_snapshot_compresses_enough_to_matter() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::store::SCHEMA).unwrap();
        let (gz, plain_len) = snapshot(&conn, false).unwrap();
        assert!(plain_len > 0);
        assert!(
            (gz.len() as u64) * 2 < plain_len,
            "gzip({plain_len}) came back as {} bytes, which is not worth the code",
            gz.len()
        );
    }

    #[test]
    fn a_snapshot_round_trips_through_a_sealed_file() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::store::SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO vessels (id, name, grams, created_at, updated_at)
             VALUES ('v1','katori',48.0,'2026-09-10T00:00:00Z','2026-09-10T00:00:00Z')",
            [],
        )
        .unwrap();
        let (gz, plain_len) = snapshot(&conn, false).unwrap();
        let dek = Dek::new().unwrap();
        let w = wrap_dek_at(PASS, &dek, M, 1, 1).unwrap();
        let blob = seal(&dek, &w, &gz, plain_len, "2026-09-10T12:00:00Z").unwrap();

        let back = gunzip(&open_blob(PASS, &blob).unwrap().1).unwrap();
        let dir = tempdir();
        let p = dir.join("round.db");
        std::fs::write(&p, back.as_slice()).unwrap();
        let re = Connection::open(&p).unwrap();
        let name: String = re
            .query_row("SELECT name FROM vessels WHERE id = 'v1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "katori");
        assert!(is_plain_sqlite(&p).unwrap());
    }

    /// A restore that recomputed the nutrition it carried would be the same bug
    /// as an edit reaching backwards into history, so the frozen rows are what
    /// this asserts — byte for byte, not merely present.
    #[test]
    fn a_snapshot_keeps_the_nutrition_an_entry_was_frozen_with() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::store::SCHEMA).unwrap();
        crate::store::ensure_device_identity(&conn).unwrap();
        let id = crate::store::add(
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
        conn.execute(
            "INSERT INTO entry_snapshots (entry_id, frozen_at, basis)
             VALUES (?1,'2026-09-10T12:00:00Z','logged')",
            [&id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entry_components (entry_id, ordinal, description, fdc_id, grams, has_data)
             VALUES (?1, 0, 'chinta pandu', 167763, 120.0, 1)",
            [&id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entry_nutrients (entry_id, ordinal, nutrient_id, value_kind, amount)
             VALUES (?1, 0, 1003, 'measured', 4.25)",
            [&id],
        )
        .unwrap();

        let (gz, plain_len) = snapshot(&conn, false).unwrap();
        let dek = Dek::new().unwrap();
        let w = wrap_dek_at(PASS, &dek, M, 1, 1).unwrap();
        let blob = seal(&dek, &w, &gz, plain_len, "2026-09-10T12:00:00Z").unwrap();
        let back = gunzip(&open_blob(PASS, &blob).unwrap().1).unwrap();

        let dir = tempdir();
        let p = dir.join("frozen.db");
        std::fs::write(&p, back.as_slice()).unwrap();
        let re = Connection::open(&p).unwrap();
        let (amount, kind, grams): (f64, String, f64) = re
            .query_row(
                "SELECT n.amount, n.value_kind, c.grams
                   FROM entry_nutrients n JOIN entry_components c
                     ON c.entry_id = n.entry_id AND c.ordinal = n.ordinal
                  WHERE n.entry_id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(amount, 4.25);
        assert_eq!(kind, "measured");
        assert_eq!(grams, 120.0);
        // And the entry itself, with the provenance it was written with.
        let (on, meal): (String, String) = re
            .query_row("SELECT logged_on, meal FROM log_entries WHERE id = ?1", [&id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((on.as_str(), meal.as_str()), ("2026-09-10", "lunch"));
    }

    #[test]
    fn a_sealed_file_is_written_by_rename_so_a_reader_never_sees_half_of_one() {
        let dir = tempdir();
        write_sealed(&dir, b"first").unwrap();
        let p = dir.join(SEALED_NAME);
        assert_eq!(std::fs::read(&p).unwrap(), b"first");
        write_sealed(&dir, b"second and longer").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"second and longer");
        // Nothing is left behind for the backup agent to pick up by mistake.
        assert!(!dir.join(format!("{SEALED_NAME}.new")).exists());
    }

    #[test]
    fn an_interrupted_restore_puts_the_old_database_back() {
        let dir = tempdir();
        std::fs::write(dir.join(SUPERSEDED), b"SQLite format 3\0the old log").unwrap();
        std::fs::write(dir.join(STAGED), b"SQLite format 3\0the new one").unwrap();
        assert!(matches!(
            recover_interrupted(&dir).unwrap(),
            Recovered::PutBackSuperseded
        ));
        assert_eq!(
            std::fs::read(dir.join("user.db")).unwrap(),
            b"SQLite format 3\0the old log"
        );
        assert!(!dir.join(STAGED).exists());
    }

    #[test]
    fn an_interrupted_conversion_puts_the_plaintext_database_back() {
        let dir = tempdir();
        std::fs::write(dir.join(PLAIN_SUPERSEDED), b"SQLite format 3\0the whole log").unwrap();
        std::fs::write(dir.join(CONVERTING), b"not sqlite at all").unwrap();
        assert!(matches!(
            recover_interrupted(&dir).unwrap(),
            Recovered::PutBackPlaintext
        ));
        assert_eq!(
            std::fs::read(dir.join("user.db")).unwrap(),
            b"SQLite format 3\0the whole log"
        );
        assert!(!dir.join(CONVERTING).exists());
    }

    #[test]
    fn a_live_database_is_never_replaced_by_a_recovery_pass() {
        let dir = tempdir();
        std::fs::write(dir.join("user.db"), b"SQLite format 3\0live").unwrap();
        std::fs::write(dir.join(STAGED), b"half a database").unwrap();
        assert!(matches!(
            recover_interrupted(&dir).unwrap(),
            Recovered::DiscardedStaged
        ));
        assert_eq!(std::fs::read(dir.join("user.db")).unwrap(), b"SQLite format 3\0live");
        assert!(!dir.join(STAGED).exists());
    }

    #[test]
    fn a_fresh_install_has_nothing_to_recover_and_says_so() {
        let dir = tempdir();
        assert!(matches!(recover_interrupted(&dir).unwrap(), Recovered::Nothing));
        assert!(!dir.join("user.db").exists());
    }

    #[test]
    fn an_encrypted_database_does_not_look_like_a_plaintext_one() {
        let dir = tempdir();
        let plain = dir.join("plain.db");
        Connection::open(&plain)
            .unwrap()
            .execute_batch("CREATE TABLE t (a)")
            .unwrap();
        assert!(is_plain_sqlite(&plain).unwrap());

        // Not a real SQLCipher file — this build's macOS SQLite cannot make one
        // — but the discriminator under test is the leading magic, and a first
        // page of ciphertext is indistinguishable from any other 16 bytes that
        // are not it.
        let enc = dir.join("enc.db");
        std::fs::write(&enc, [0x9au8; 4096]).unwrap();
        assert!(!is_plain_sqlite(&enc).unwrap());

        assert!(is_plain_sqlite(&dir.join("absent.db")).unwrap());
    }

    #[test]
    fn dropping_sidecars_removes_the_log_belonging_to_the_file_that_moved() {
        let dir = tempdir();
        let db = dir.join("user.db");
        std::fs::write(&db, b"x").unwrap();
        std::fs::write(dir.join("user.db-wal"), b"frames").unwrap();
        std::fs::write(dir.join("user.db-shm"), b"index").unwrap();
        drop_sidecars(&db).unwrap();
        assert!(!dir.join("user.db-wal").exists());
        assert!(!dir.join("user.db-shm").exists());
        assert!(db.exists());
        // Idempotent, because the recovery path may run twice.
        drop_sidecars(&db).unwrap();
    }

    #[test]
    fn a_swap_keeps_the_database_it_replaced() {
        let dir = tempdir();
        std::fs::write(dir.join("user.db"), b"SQLite format 3\0the old log").unwrap();
        std::fs::write(dir.join("user.db-wal"), b"frames from the old one").unwrap();
        let staged = dir.join(STAGED);
        std::fs::write(&staged, b"SQLite format 3\0the restored log").unwrap();

        let out = swap_in(&dir, &staged).unwrap();
        assert!(!out.replaced_earlier);
        assert_eq!(
            std::fs::read(dir.join("user.db")).unwrap(),
            b"SQLite format 3\0the restored log"
        );
        assert_eq!(
            std::fs::read(&out.superseded).unwrap(),
            b"SQLite format 3\0the old log"
        );
        // The old log's write-ahead frames must not be sitting beside the new
        // database, where SQLite would replay them against it.
        assert!(!dir.join("user.db-wal").exists());
        assert!(!staged.exists());
    }

    /// Exactly one superseded copy is kept, and a second restore says so rather
    /// than leaving the phone to fill up with full copies of the log.
    #[test]
    fn a_second_swap_reports_that_it_replaced_the_earlier_safety_net() {
        let dir = tempdir();
        std::fs::write(dir.join(SUPERSEDED), b"an older log still").unwrap();
        std::fs::write(dir.join("user.db"), b"the current log").unwrap();
        let staged = dir.join(STAGED);
        std::fs::write(&staged, b"the restored log").unwrap();
        let out = swap_in(&dir, &staged).unwrap();
        assert!(out.replaced_earlier);
        assert_eq!(std::fs::read(&out.superseded).unwrap(), b"the current log");
    }

    #[test]
    fn a_swap_that_will_not_open_can_be_put_back() {
        let dir = tempdir();
        std::fs::write(dir.join("user.db"), b"SQLite format 3\0the old log").unwrap();
        let staged = dir.join(STAGED);
        std::fs::write(&staged, b"not a database").unwrap();
        swap_in(&dir, &staged).unwrap();
        unswap(&dir).unwrap();
        assert_eq!(
            std::fs::read(dir.join("user.db")).unwrap(),
            b"SQLite format 3\0the old log"
        );
        assert!(!dir.join(SUPERSEDED).exists());
        // Nothing to put back is a refusal in the app's own voice, not a panic.
        assert_eq!(
            unswap(&dir).unwrap_err(),
            "there is no earlier log to put back"
        );
    }

    /// The house rule about refusals, under test rather than on trust.
    ///
    /// A refusal the USER caused reads as a lowercase sentence with no trailing
    /// full stop, in the voice of "water is drunk across the day, so it is not
    /// logged against a meal". Every string on this screen's path is shown to
    /// somebody unchanged, so the register is part of the interface — and the
    /// one way to keep it is to check it rather than to remember it.
    #[test]
    fn every_refusal_a_person_can_cause_reads_as_one_lowercase_sentence() {
        let (blob, _) = sealed(b"x");
        let mut short = blob.clone();
        short[10..14].copy_from_slice(&1u32.to_le_bytes());
        let mut alien = blob.clone();
        alien[0] = b'X';

        let refusals = [
            check_passphrase("short").unwrap_err(),
            open_blob("the wrong one entirely", &blob).err().unwrap(),
            read_header(&alien).unwrap_err(),
            read_header(&short).unwrap_err(),
            read_header(b"tiny").unwrap_err(),
        ];
        for r in refusals {
            let first = r.chars().next().unwrap();
            assert!(
                !first.is_uppercase(),
                "“{r}” starts with a capital, so it reads as a system message"
            );
            assert!(!r.ends_with('.'), "“{r}” ends with a full stop");
            assert!(!r.is_empty());
        }
    }

    /// A private directory per test, named from the test's own thread.
    ///
    /// `std::env::temp_dir()` plus a random suffix rather than a crate: this
    /// tree has no dev-dependencies and one temporary directory is not the
    /// place to start.
    fn tempdir() -> PathBuf {
        let mut n = [0u8; 8];
        getrandom(&mut n).unwrap();
        let mut name = String::from("trackit-backup-test-");
        for b in n {
            name.push_str(&format!("{b:02x}"));
        }
        let d = std::env::temp_dir().join(name);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
