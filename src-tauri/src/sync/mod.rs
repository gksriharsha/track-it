//! Household sync: the part that carries the kitchen to the other device.
//!
//! The database half of this was designed and built first — `row_version`, the
//! fourteen change-tracking triggers, `sync_pending`, `sync_control` and the
//! feed and apply paths in `store.rs`. This module is the transport, and it
//! owns three things and no more: who is at the other end, what gets said, and
//! when.
//!
//! Deliberately absent: a background service. No foreground service, no
//! notification, no wake lock, and on Android the sockets die with the process.
//! That is not a shortcut around Doze and App Standby — it is agreement with
//! them. Doze suspends network access for every app regardless of target API,
//! so a listener that fought it would be an app running behind your back for no
//! benefit. The consequence is honest and belongs on screen: a phone can be
//! reached while TrackIt is open on it, and not otherwise.
//!
//! Deliberately absent: any server. Two devices on one network, a code shown on
//! one and read by the other, and nothing in between.

pub mod discover;
pub mod handshake;
pub mod qr;
pub mod session;
pub mod wire;

use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::Serialize;

use crate::store;

/// How the sync worker reaches the database.
///
/// A trait rather than an `Arc<Mutex<Connection>>` passed around, and the
/// reason is the one thing this module is not allowed to do: there is exactly
/// ONE connection to the user database in this app, held in Tauri state, and
/// the sync worker shares it rather than opening a second. Two writers under
/// WAL is where `SQLITE_BUSY_SNAPSHOT` lives — a deferred transaction that
/// reads and then writes after another connection committed, which the busy
/// handler is not even invoked for.
///
/// The locking discipline is the implementor's business and the caller's
/// promise: hold it for a feed read or one apply transaction, never across a
/// socket read.
pub trait Kitchen: Send + Sync + Clone + 'static {
    fn with<T>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String>;
}

/// The database as it is reached from a Tauri command or a worker thread.
///
/// The handle is resolved on every call rather than held, so a worker thread
/// carries an `AppHandle` — which is `Send`, `Sync` and cheap to clone — and
/// never a borrow of state.
#[derive(Clone)]
pub struct AppKitchen(pub tauri::AppHandle);

impl Kitchen for AppKitchen {
    fn with<T>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        use tauri::Manager;
        let state = self
            .0
            .try_state::<store::Store>()
            .ok_or("the kitchen is not open yet")?;
        let mut conn = state.0.lock().map_err(|e| e.to_string())?;
        work(&mut conn)
    }
}

/// An offer to pair, shown as a QR code on the device that is listening.
#[derive(Debug, Clone, Serialize)]
pub struct PairingOffer {
    pub payload: String,
    pub expires_at: String,
    /// The code itself, as SVG markup ready to drop into the page.
    ///
    /// Drawn here, next to the key material, because the payload is hashed into
    /// the Noise prologue as EXACT bytes on both sides — assembling it a second
    /// time in the webview is one space away from a handshake that fails for no
    /// visible reason.
    pub svg: String,
}

/// Where a pairing attempt has got to.
///
/// The same union on both sides, so the screen's existing polling loop serves
/// the device that scanned as well as the device that showed.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum PairingState {
    Waiting,
    Confirming { peer_name: String, digits: String },
    Paired { peer_name: String },
    Expired,
    Failed { detail: String },
}

/// How long an offer stands. Two minutes, which is what the screen promises.
const OFFER: Duration = Duration::from_secs(120);

/// How many addresses the code carries.
///
/// A Mac with Wi-Fi plus a VPN or a Docker bridge has several, and every one
/// added pushes the payload longer and the code denser — past about 145 bytes
/// it goes from 45 modules to 49, which at the camera's probe resolution is
/// under six pixels a module with JPEG artefacts across the boundaries, and
/// then it simply never scans. Two is the compromise: the common
/// Wi-Fi-plus-something case is covered, and the code stays readable.
const MAX_ADDRESSES: usize = 2;

/// The tag every pairing payload starts with, and the version of the format.
const PAYLOAD_TAG: &str = "trackit-household-1";

/// Everything about pairing and syncing that outlives one command.
///
/// In memory and nowhere else. A `SyncOutcome` is how the LAST run went, which
/// is a fact about this session rather than about the kitchen — persisting it
/// would put a green tick from Tuesday over a fridge that has been wrong since
/// Wednesday, which is exactly what `household()`'s own comment assumes it will
/// not do.
pub struct Hub {
    inner: Mutex<HubInner>,
    answered: Condvar,
}

struct HubInner {
    state: PairingState,
    /// Which attempt the state belongs to. A thread that wakes after the user
    /// cancelled must not write over a fresh offer, and comparing an epoch is
    /// how it finds out.
    epoch: u64,
    /// Whether an attempt is still standing. Cleared by a cancel, by expiry and
    /// by a completed pairing.
    live: bool,
    /// The user's answer to the six digits, or `None` while nobody has said.
    verdict: Option<bool>,
    last: Vec<store::SyncOutcome>,
    /// The port this device answers a sync on, or `None` when it answers
    /// nothing — which is the state of a device paired with nobody. Also the
    /// idempotence flag for [`serve`].
    listen_port: Option<u16>,
}

impl Hub {
    pub fn new() -> Hub {
        Hub {
            inner: Mutex::new(HubInner {
                state: PairingState::Waiting,
                epoch: 0,
                live: false,
                verdict: None,
                last: Vec::new(),
                listen_port: None,
            }),
            answered: Condvar::new(),
        }
    }

    pub fn state(&self) -> PairingState {
        match self.inner.lock() {
            Ok(g) => g.state.clone(),
            // A poisoned lock means a worker panicked. Saying so is better than
            // a stage that claims to know where pairing got to.
            Err(_) => PairingState::Failed {
                detail: "pairing stopped unexpectedly — try showing a fresh code".into(),
            },
        }
    }

    pub fn last(&self) -> Vec<store::SyncOutcome> {
        self.inner.lock().map(|g| g.last.clone()).unwrap_or_default()
    }

    fn set_last(&self, outcomes: Vec<store::SyncOutcome>) {
        if let Ok(mut g) = self.inner.lock() {
            g.last = outcomes;
        }
    }

    pub fn listen_port(&self) -> Option<u16> {
        self.inner.lock().ok().and_then(|g| g.listen_port)
    }

    /// Claim the listening port, or say it is already claimed.
    ///
    /// This is what makes [`serve`] idempotent: it is called from launch AND
    /// from the moment a pairing succeeds, because a device paired today has to
    /// be reachable today rather than after the next restart.
    fn claim_listener(&self, port: u16) -> bool {
        match self.inner.lock() {
            Ok(mut g) if g.listen_port.is_none() => {
                g.listen_port = Some(port);
                true
            }
            _ => false,
        }
    }

    /// Start a new attempt and return its epoch.
    fn begin(&self) -> u64 {
        match self.inner.lock() {
            Ok(mut g) => {
                g.epoch += 1;
                g.live = true;
                g.verdict = None;
                g.state = PairingState::Waiting;
                g.epoch
            }
            Err(_) => 0,
        }
    }

    fn set_state(&self, epoch: u64, state: PairingState) {
        if let Ok(mut g) = self.inner.lock() {
            if g.epoch == epoch {
                g.state = state;
            }
        }
    }

    fn is_live(&self, epoch: u64) -> bool {
        self.inner
            .lock()
            .map(|g| g.live && g.epoch == epoch)
            .unwrap_or(false)
    }

    fn finish(&self, epoch: u64) {
        if let Ok(mut g) = self.inner.lock() {
            if g.epoch == epoch {
                g.live = false;
            }
        }
    }

    /// Put a live offer back to waiting after a refused comparison.
    ///
    /// A refused verdict ends that CONNECTION, not the offer. Ending the offer
    /// made anybody who could reach the announced port a denial of pairing:
    /// they complete a handshake nobody authenticated, digits appear, the user
    /// says no, and the genuine phone then finds nothing listening. One
    /// connection at a time, with fresh digits for each, keeps the twenty-bit
    /// code one-shot without handing that away.
    fn back_to_waiting(&self, epoch: u64) {
        if let Ok(mut g) = self.inner.lock() {
            if g.epoch == epoch {
                g.verdict = None;
                g.state = PairingState::Waiting;
            }
        }
    }

    /// The user's answer to the six digits. Wakes the thread parked on it.
    pub fn answer(&self, matches: bool) {
        if let Ok(mut g) = self.inner.lock() {
            g.verdict = Some(matches);
        }
        self.answered.notify_all();
    }

    /// Withdraw the offer. Idempotent: nothing to stop is not an error, which
    /// is what `cancel_pairing` has always returned.
    pub fn cancel(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.live = false;
            g.verdict = None;
            g.epoch += 1;
            g.state = PairingState::Waiting;
        }
        self.answered.notify_all();
    }

    /// Park until the user answers the digits, the attempt is cancelled, or the
    /// offer runs out. `None` means nobody ever said.
    fn await_verdict(&self, epoch: u64, deadline: Instant) -> Option<bool> {
        let mut g = self.inner.lock().ok()?;
        loop {
            if g.epoch != epoch || !g.live {
                return None;
            }
            if let Some(v) = g.verdict.take() {
                return Some(v);
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            if left.is_zero() {
                return None;
            }
            let (next, _) = self
                .answered
                .wait_timeout(g, left.min(Duration::from_millis(500)))
                .ok()?;
            g = next;
        }
    }
}

impl Default for Hub {
    fn default() -> Hub {
        Hub::new()
    }
}

/// Mint this device's Noise keypair if it has none, and hand it back.
///
/// Lazy rather than done by the v15 migration, because minting needs the
/// protocol crate and `store.rs` has no business depending on one. `NULL` in
/// `this_device.static_pk` is a real state, and this is the only thing that ends
/// it. It never rewrites an existing key.
pub fn ensure_identity(conn: &Connection) -> Result<(Vec<u8>, Vec<u8>), String> {
    if let Some(kp) = store::static_keypair(conn)? {
        return Ok(kp);
    }
    let (pk, sk) = handshake::mint()?;
    store::set_static_keypair(conn, &pk, &sk)?;
    Ok((pk, sk))
}

/// A pairing code, read back out of the string a camera saw.
#[derive(Debug, Clone)]
pub struct Code {
    pub addresses: Vec<Ipv4Addr>,
    pub port: u16,
    pub static_pk: Vec<u8>,
    pub expires_at: String,
    /// The string exactly as it was scanned. Hashed into the prologue on both
    /// sides, so it is kept rather than rebuilt from the parts.
    pub raw: String,
}

/// Build the string a QR code carries.
///
/// Flat and pipe-delimited rather than JSON, and that is load-bearing: the
/// prologue binds the EXACT bytes on both sides, and a JSON object
/// re-serialised on the other device could differ by a space. It carries no
/// device name either — dropping it removes the only field that would have
/// needed escaping, and the name shown as "X answered" then comes from the
/// authenticated hello inside the handshake rather than from text printed on a
/// piece of glass.
fn build_code(addresses: &[Ipv4Addr], port: u16, static_pk: &[u8], expires_at: &str) -> String {
    let ips = addresses
        .iter()
        .map(|a| a.to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{PAYLOAD_TAG}|{ips}|{port}|{}|{expires_at}",
        b64url_encode(static_pk)
    )
}

/// Read a scanned string back, refusing anything that is not one of ours.
pub fn parse_code(raw: &str) -> Result<Code, String> {
    let raw = raw.trim();
    let parts: Vec<&str> = raw.split('|').collect();
    if parts.len() != 5 || parts[0] != PAYLOAD_TAG {
        return Err("that is not a TrackIt pairing code".into());
    }
    let mut addresses = Vec::new();
    for a in parts[1].split(',') {
        let ip: Ipv4Addr = a
            .parse()
            .map_err(|_| "that pairing code does not say where to find the other device")?;
        addresses.push(ip);
    }
    if addresses.is_empty() {
        return Err("that pairing code does not say where to find the other device".into());
    }
    let port: u16 = parts[2]
        .parse()
        .map_err(|_| "that pairing code does not say how to reach the other device")?;
    if port == 0 {
        return Err("that pairing code does not say how to reach the other device".into());
    }
    let static_pk = b64url_decode(parts[3])?;
    if static_pk.len() != 32 {
        return Err("that pairing code does not carry a household key this app can use".into());
    }
    Ok(Code {
        addresses,
        port,
        static_pk,
        expires_at: parts[4].to_string(),
        raw: raw.to_string(),
    })
}

/// base64url without padding, written out rather than taken as a dependency.
///
/// Thirty lines, and the alternative was either a fifth-party crate or the
/// standard alphabet, whose `+` and `/` make a payload that cannot be read
/// aloud or pasted into a shell without quoting. Unpadded because the length is
/// always 32 bytes and an `=` in a QR is one more module for nothing.
fn b64url_encode(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() * 4 + 2) / 3);
    for chunk in bytes.chunks(3) {
        let mut acc = 0u32;
        for (i, b) in chunk.iter().enumerate() {
            acc |= u32::from(*b) << (16 - 8 * i);
        }
        let take = chunk.len() + 1;
        for i in 0..take {
            out.push(A[((acc >> (18 - 6 * i)) & 0x3f) as usize] as char);
        }
    }
    out
}

fn b64url_decode(s: &str) -> Result<Vec<u8>, String> {
    const BAD: &str = "that pairing code did not arrive intact";
    let sextet = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    };
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        if chunk.len() == 1 {
            return Err(BAD.into());
        }
        let mut acc = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            acc |= sextet(*c).ok_or(BAD)? << (18 - 6 * i);
        }
        for i in 0..chunk.len() - 1 {
            out.push(((acc >> (16 - 8 * i)) & 0xff) as u8);
        }
    }
    Ok(out)
}

/// Start listening and return the code to show.
///
/// The listener serves one connection AT A TIME, deriving fresh digits for
/// each, and stands until it is cancelled or runs out. See
/// [`Hub::back_to_waiting`] for why it is not one connection ever.
pub fn begin_pairing<K: Kitchen>(db: K, hub: Arc<Hub>) -> Result<PairingOffer, String> {
    // Minting here as well as at launch is harmless — `ensure_identity` never
    // rewrites an existing key — and it closes the case where a database
    // migrated by an older build has never reached `init_state`'s call.
    let (pk, sk) = db.with(|conn| ensure_identity(conn))?;
    // The answering socket goes up BEFORE the handshake, on a device that is
    // about to have somebody to answer, so that the port this device listens on
    // is a real number by the time it goes into `Hello`. Announcing 0 — which is
    // what a device with no listener honestly has to say — meant neither side
    // came out of its first pairing with an address for the other, so the very
    // first sync fell through to a whole-subnet sweep every time, and two
    // instances on ONE machine could pair and then never sync at all: loopback
    // is not swept and only one of them can hold the rendezvous port.
    ensure_answering(&db, &hub);

    let mut addresses = discover::own_addresses()?;
    if addresses.is_empty() {
        return Err("this device is not on a network, so there is nothing to point a camera \
                    at yet"
            .into());
    }
    addresses.truncate(MAX_ADDRESSES);

    let listener = TcpListener::bind("0.0.0.0:0")
        .map_err(|e| format!("opening a socket to pair on: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let expires_at = db.with(|conn| {
        conn.query_row(
            "SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now','+120 seconds')",
            [],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())
    })?;

    let payload = build_code(&addresses, port, &pk, &expires_at);
    let svg = qr::svg(&payload)?;
    let epoch = hub.begin();

    let deadline = Instant::now() + OFFER;
    let show = payload.clone();
    let worker_db = db.clone();
    let worker_hub = Arc::clone(&hub);
    std::thread::spawn(move || {
        show_and_wait(worker_db, worker_hub, listener, sk, show, epoch, deadline);
    });

    Ok(PairingOffer {
        payload,
        expires_at,
        svg,
    })
}

/// The offer's own thread: accept, pair, and put the offer back if refused.
fn show_and_wait<K: Kitchen>(
    db: K,
    hub: Arc<Hub>,
    listener: TcpListener,
    sk: Vec<u8>,
    payload: String,
    epoch: u64,
    deadline: Instant,
) {
    // Non-blocking with a short sleep rather than a blocking accept, so a
    // cancel or an expiry is noticed within a fifth of a second instead of
    // holding the socket until somebody happens to connect.
    if listener.set_nonblocking(true).is_err() {
        hub.set_state(
            epoch,
            PairingState::Failed {
                detail: "this device could not listen for the other one".into(),
            },
        );
        hub.finish(epoch);
        return;
    }
    while hub.is_live(epoch) {
        if Instant::now() >= deadline {
            hub.set_state(epoch, PairingState::Expired);
            hub.finish(epoch);
            return;
        }
        match listener.accept() {
            Ok((stream, from)) => {
                if stream.set_nonblocking(false).is_err() {
                    continue;
                }
                match pair_one(&db, &hub, stream, from, &sk, &payload, epoch, deadline) {
                    Ok(true) => return,
                    // `settle` has already decided whether this offer survives —
                    // a comparison the far user refused ends it and says so, and
                    // one THIS user refused leaves the screen to say it. Either
                    // way, only put the offer back if it is still standing:
                    // overwriting a state `settle` has just finished on would
                    // paint "Scan this on the other device" over a pairing that
                    // is over.
                    Ok(false) => {
                        if hub.is_live(epoch) {
                            hub.back_to_waiting(epoch);
                        }
                    }
                    // Silent, on purpose, and this is the one place in the app
                    // where a failure is not put in front of anybody. Nothing
                    // reached the point of proving who it was, so on a shared
                    // network this is most likely somebody else's device
                    // stumbling into the port — and there is nothing the user
                    // could do about it. Painting it would also have handed that
                    // stranger a denial of pairing: the screen clears the code on
                    // a failure while this thread goes on listening, so the user
                    // would be looking at an error over a live socket. The half
                    // of this that a user CAN act on — a code that would not
                    // scan, a device that would not answer — fails on the
                    // scanning device, which is where they are looking.
                    Err(detail) => {
                        eprintln!("a device tried to pair and could not: {detail}");
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(180));
            }
            Err(e) => {
                hub.set_state(
                    epoch,
                    PairingState::Failed {
                        detail: format!("this device stopped listening: {e}"),
                    },
                );
                hub.finish(epoch);
                return;
            }
        }
    }
}

/// Give the socket the rest of the offer to wait in.
///
/// The far side is parked on ITS user, who may be looking for their reading
/// glasses. A handshake step's fifteen seconds is the wrong bound for that, and
/// the right one is however long this offer has left plus a little slack for
/// the far side to notice its own expiry first and say so.
fn waiting_room(stream: &TcpStream, deadline: Instant) -> Result<(), String> {
    let left = deadline
        .checked_duration_since(Instant::now())
        .unwrap_or(Duration::from_secs(1));
    stream
        .set_read_timeout(Some(left + Duration::from_secs(5)))
        .map_err(|e| e.to_string())
}

/// One pairing attempt on the showing side. `Ok(true)` means paired.
#[allow(clippy::too_many_arguments)]
fn pair_one<K: Kitchen>(
    db: &K,
    hub: &Arc<Hub>,
    mut stream: TcpStream,
    from: SocketAddr,
    sk: &[u8],
    payload: &str,
    epoch: u64,
    deadline: Instant,
) -> Result<bool, String> {
    stream
        .set_read_timeout(Some(handshake::STEP_TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(handshake::STEP_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let port = hub.listen_port().unwrap_or(0);
    let me = db.with(|conn| session::me(conn, port))?;
    let met = handshake::pair_as_shower(&mut stream, sk, payload.as_bytes(), &me)?;
    waiting_room(&stream, deadline)?;
    settle(db, hub, &mut stream, met, from, epoch, deadline)
}

/// Join the household whose code was just scanned. The scanner's half.
///
/// Returns as soon as the attempt is under way; the screen polls
/// [`Hub::state`] exactly as it already does for the device showing the code,
/// so one polling loop serves both halves.
pub fn join_pairing<K: Kitchen>(db: K, hub: Arc<Hub>, payload: String) -> Result<(), String> {
    let code = parse_code(&payload)?;
    let now = db.with(|conn| store::now_iso(conn))?;
    // Both instants are the same fixed-width UTC format, so a string comparison
    // is a time comparison — and it is the format the whole database is in, so
    // nothing here needs a clock crate.
    if code.expires_at <= now {
        return Err("that code has run out — show a fresh one on the other device".into());
    }
    let (_pk, sk) = db.with(|conn| ensure_identity(conn))?;
    // For the reason `begin_pairing` states: the port this device answers on has
    // to be a real number before it goes into the handshake, or the device that
    // showed the code comes away with no way back to this one.
    ensure_answering(&db, &hub);
    let epoch = hub.begin();
    let deadline = Instant::now() + OFFER;
    let worker_db = db.clone();
    let worker_hub = Arc::clone(&hub);
    std::thread::spawn(move || {
        match join_one(&worker_db, &worker_hub, code, &sk, epoch, deadline) {
            // Paired: `settle` has already said so and closed the attempt.
            Ok(true) => {}
            // Somebody said the digits did not match. On this side there is no
            // offer to go back to — this device was dialling, not listening —
            // so the attempt ends here. Whether anything is SAID is `settle`'s
            // decision and not this one's: it has already named the case where
            // the other user refused, and left the case where this user refused
            // to the screen that asked them. Hence the guard — clearing the
            // state here would erase a sentence written a microsecond ago.
            Ok(false) => {
                if worker_hub.is_live(epoch) {
                    worker_hub.back_to_waiting(epoch);
                }
                worker_hub.finish(epoch);
            }
            Err(detail) => {
                worker_hub.set_state(epoch, PairingState::Failed { detail });
                worker_hub.finish(epoch);
            }
        }
    });
    Ok(())
}

fn join_one<K: Kitchen>(
    db: &K,
    hub: &Arc<Hub>,
    code: Code,
    sk: &[u8],
    epoch: u64,
    deadline: Instant,
) -> Result<bool, String> {
    // Every address the code carries, in order. A Mac with Wi-Fi and a VPN
    // prints both, and which of them a phone can actually reach is not
    // something either device can work out in advance.
    let mut last: Option<String> = None;
    for ip in &code.addresses {
        let at = SocketAddr::new(std::net::IpAddr::V4(*ip), code.port);
        match TcpStream::connect_timeout(&at, Duration::from_millis(1500)) {
            Ok(mut stream) => {
                stream
                    .set_read_timeout(Some(handshake::STEP_TIMEOUT))
                    .map_err(|e| e.to_string())?;
                stream
                    .set_write_timeout(Some(handshake::STEP_TIMEOUT))
                    .map_err(|e| e.to_string())?;
                let port = hub.listen_port().unwrap_or(0);
                let me = db.with(|conn| session::me(conn, port))?;
                let met = handshake::pair_as_scanner(
                    &mut stream,
                    sk,
                    code.raw.as_bytes(),
                    &code.static_pk,
                    &me,
                )?;
                waiting_room(&stream, deadline)?;
                return settle(db, hub, &mut stream, met, at, epoch, deadline);
            }
            Err(e) => last = Some(e.to_string()),
        }
    }
    Err(match last {
        Some(_) => "the other device did not answer — check both are on the same Wi-Fi and \
                    that the code is still on its screen"
            .to_string(),
        None => "that pairing code does not say where to find the other device".to_string(),
    })
}

/// The half of pairing that is identical on both sides: show the digits, wait
/// for this user, exchange verdicts, and write the peer down only if both said
/// yes.
///
/// Both sides must answer before either writes a row. If one user says yes and
/// the other says no, the device that said yes would otherwise end up with a
/// household member the other one refused — and no server exists to tell it
/// otherwise afterwards.
///
/// Generic over the stream, and the read timeout is therefore the caller's job —
/// see [`waiting_room`], which both callers use. The reason is the one `wire`
/// gives: this is the step that decides whether a stranger gets into somebody's
/// kitchen, and it has to be exercisable between two databases in one process
/// rather than only by two people in a room comparing digits out loud.
fn settle<S: std::io::Read + std::io::Write, K: Kitchen>(
    db: &K,
    hub: &Arc<Hub>,
    stream: &mut S,
    met: handshake::Met,
    at: SocketAddr,
    epoch: u64,
    deadline: Instant,
) -> Result<bool, String> {
    let mut transport = met.transport;
    hub.set_state(
        epoch,
        PairingState::Confirming {
            peer_name: met.hello.name.clone(),
            digits: met.digits.clone(),
        },
    );

    let Some(mine) = hub.await_verdict(epoch, deadline) else {
        return Err("nobody answered the six digits in time, so nothing was paired".into());
    };
    wire::send(stream, &mut transport, &wire::Msg::Verdict { matches: mine })?;
    let theirs = match wire::recv(stream, &mut transport)? {
        wire::Msg::Verdict { matches } => matches,
        wire::Msg::Error { detail } => return Err(detail),
        _ => return Err("the other device did not answer the six digits".into()),
    };

    // The two refusals are not the same event and must not read as one. When
    // THIS user said no, the screen already knows — it is the one that asked —
    // and it prints its own sentence, so saying anything here would be a second
    // voice over the first. When the OTHER user said no, this user said yes and
    // has been told nothing at all: the offer would have gone quietly back to
    // showing a code, with no account of why nobody joined. So that half is
    // named, and it ends the attempt, because ending it is what the person at
    // the far end just asked for.
    if !theirs {
        if mine {
            hub.set_state(
                epoch,
                PairingState::Failed {
                    detail: "the other device said the digits did not match, so nothing was \
                             paired — show a fresh code and compare them again"
                        .into(),
                },
            );
            hub.finish(epoch);
        }
        return Ok(false);
    }
    // The verdict has already gone over the wire by this point, so the far side
    // learns of the refusal now rather than sitting out its whole offer waiting
    // for an answer. Then the attempt ends HERE, on the strength of what this
    // user said, rather than the screen having to follow "no" with a separate
    // cancel — which raced the worker for the verdict it had not yet picked up,
    // and won often enough that the far device was left hanging.
    if !mine {
        hub.finish(epoch);
        return Ok(false);
    }

    let name = met.hello.name.clone();
    let device_id = met.hello.device_id.clone();
    let pk = met.static_pk.clone();
    let ip = at.ip().to_string();
    let announced = met.hello.listen_port;
    db.with(move |conn| {
        store::pair_peer(
            conn,
            &device_id,
            &name,
            &pk,
            (announced > 0).then_some((ip.as_str(), announced)),
        )
    })?;
    hub.set_state(
        epoch,
        PairingState::Paired {
            peer_name: met.hello.name.clone(),
        },
    );
    hub.finish(epoch);
    // Belt and braces: both halves of pairing put the listener up before the
    // handshake, so this is normally a no-op. It stays because the day somebody
    // adds a third way into `settle` is the day "press sync on the phone"
    // silently stops working until the next restart.
    ensure_answering(db, hub);
    Ok(true)
}

/// Put this device's answering socket up if it is not up already.
///
/// A failure is reported to the log and NOT to the caller. Everything this is
/// wanted for still works without it — this device can dial, and it can be
/// dialled at whatever address a peer already remembers — so refusing to pair
/// because a socket would not bind would be turning a smaller loss into a
/// larger one.
fn ensure_answering<K: Kitchen>(db: &K, hub: &Arc<Hub>) {
    if hub.listen_port().is_some() {
        return;
    }
    if let Err(e) = serve(db.clone(), Arc::clone(hub)) {
        eprintln!("this device cannot be reached by the rest of the household: {e}");
    }
}

/// Sync with every paired device that answers, one at a time.
///
/// Sequential rather than a thread per peer. A household is two or three
/// devices; each unreachable one costs a short connect timeout plus a sweep,
/// and the outcomes then arrive in a stable peer order — one per device, which
/// is what `HouseholdView.last` is for. One lock discipline to reason about
/// instead of N is the other half of the argument.
pub fn sync_now<K: Kitchen>(db: K, hub: Arc<Hub>) -> Result<Vec<store::SyncOutcome>, String> {
    let peers = db.with(|conn| store::peers_to_dial(conn))?;
    if peers.is_empty() {
        return Ok(Vec::new());
    }
    let (_pk, sk) = db.with(|conn| ensure_identity(conn))?;
    let mut out = Vec::with_capacity(peers.len());
    for peer in &peers {
        let at = db.with(|conn| store::now_iso(conn))?;
        let one = match sync_one(&db, &hub, peer, &sk) {
            Ok((applied, sent)) => store::SyncOutcome {
                at,
                peer_name: peer.name.clone(),
                ok: true,
                detail: session::detail(sent, &applied),
            },
            Err(detail) => store::SyncOutcome {
                at,
                peer_name: peer.name.clone(),
                ok: false,
                detail,
            },
        };
        out.push(one);
    }
    hub.set_last(out.clone());
    Ok(out)
}

fn sync_one<K: Kitchen>(
    db: &K,
    hub: &Arc<Hub>,
    peer: &store::PeerDial,
    sk: &[u8],
) -> Result<(store::Applied, usize), String> {
    // The remembered address first, because it is one packet and covers every
    // ordinary case. The sweep is for the case after that: a device whose DHCP
    // lease turned over, which under the old schema was unreachable for good.
    let mut stream = None;
    if let (Some(addr), Some(port)) = (peer.last_addr.as_deref(), peer.last_port) {
        if let Ok(at) = format!("{addr}:{port}").parse::<SocketAddr>() {
            if let Ok(s) = TcpStream::connect_timeout(&at, Duration::from_millis(300)) {
                stream = Some((s, at));
            }
        }
    }
    if stream.is_none() {
        match discover::find(&peer.static_pk, Duration::from_millis(1500))? {
            Some(at) => {
                let s = TcpStream::connect_timeout(&at, Duration::from_millis(600))
                    .map_err(|_| "that device answered a moment ago and then did not")?;
                stream = Some((s, at));
            }
            None => {
                return Err(
                    "No answer on this network. Nothing was changed on either device.".into(),
                )
            }
        }
    }
    let Some((mut stream, at)) = stream else {
        return Err("No answer on this network. Nothing was changed on either device.".into());
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;

    let port = hub.listen_port().unwrap_or(0);
    let me = db.with(|conn| session::me(conn, port))?;
    let met = handshake::resync_as_caller(&mut stream, sk, &peer.static_pk, &me)?;
    let mut transport = met.transport;
    let seen = Some((at.ip().to_string(), met.hello.listen_port));
    session::run(
        &mut stream,
        &mut transport,
        db,
        peer,
        seen,
        session::Role::Caller,
    )
}

/// Answer inbound syncs and rendezvous probes for as long as this process
/// lives. Idempotent: a second call while a listener is up is a no-op.
///
/// Started when there is somebody to answer, or somebody about to be: at launch
/// only if `peers` has a live row, and at the start of either half of pairing.
/// A device that has never paired and is not pairing binds no socket at all.
/// See the module comment for why this is not a daemon and must not become one.
pub fn serve<K: Kitchen>(db: K, hub: Arc<Hub>) -> Result<(), String> {
    let listener = TcpListener::bind("0.0.0.0:0")
        .map_err(|e| format!("opening a socket to answer on: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    if !hub.claim_listener(port) {
        // Somebody got there first, which is the ordinary outcome of pairing on
        // a device that was already answering. Drop this socket and say nothing.
        return Ok(());
    }

    let accept_db = db.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            match conn {
                Ok(stream) => {
                    let one_db = accept_db.clone();
                    // A thread per inbound connection, because a phone that
                    // opens a socket and then walks out of range must not stop
                    // the next device being answered.
                    std::thread::spawn(move || {
                        if let Err(e) = answer_one(&one_db, stream, port) {
                            eprintln!("a device tried to sync and could not: {e}");
                        }
                    });
                }
                Err(e) => {
                    eprintln!("this device stopped answering syncs: {e}");
                    return;
                }
            }
        }
    });

    // The rendezvous responder is what lets a peer whose address changed be
    // found at all. Failing to bind it is not fatal: the device stays reachable
    // at its remembered address, and the screen already says re-pairing may be
    // needed when nothing answers.
    match UdpSocket::bind(("0.0.0.0", discover::RENDEZVOUS)) {
        Ok(sock) => {
            let probe_db = db;
            std::thread::spawn(move || {
                if sock
                    .set_read_timeout(Some(Duration::from_millis(500)))
                    .is_err()
                {
                    return;
                }
                loop {
                    let answered = discover::answer_probes(&sock, port, || {
                        match probe_db.with(|conn| store::peers_to_dial(conn)) {
                            Ok(peers) => peers.into_iter().map(|p| p.static_pk).collect(),
                            // No household to answer for is not an error worth
                            // saying anything about; it is an unanswered probe.
                            Err(_) => Vec::new(),
                        }
                    });
                    if let Err(e) = answered {
                        eprintln!("this device stopped answering probes: {e}");
                        return;
                    }
                }
            });
        }
        Err(e) => eprintln!(
            "this device can be reached at its last known address but cannot be looked \
             for on the network: {e}"
        ),
    }
    Ok(())
}

fn answer_one<K: Kitchen>(db: &K, mut stream: TcpStream, port: u16) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    let at = stream.peer_addr().map_err(|e| e.to_string())?;
    answer_session(db, &mut stream, port, Some(at.ip().to_string()))?;
    Ok(())
}

/// Answer one inbound sync, or refuse a device this household does not know.
///
/// Generic over the stream and separate from [`answer_one`] so the refusal can
/// be exercised without a socket: "a device that was forgotten cannot push rows
/// back in" is a promise printed on the Household screen, and a promise that is
/// only tested by hand is a promise.
///
/// `Ok(None)` means refused. That is not an error — an unpaired device on the
/// same Wi-Fi trying its luck is an ordinary event on a shared network, and
/// there is nothing for anybody to act on.
fn answer_session<S: std::io::Read + std::io::Write, K: Kitchen>(
    db: &K,
    io: &mut S,
    port: u16,
    at: Option<String>,
) -> Result<Option<(store::Applied, usize)>, String> {
    let me = db.with(|conn| session::me(conn, port))?;
    let met = handshake::resync_as_answerer(io, &sk_of(db)?, &me)?;
    let mut transport = met.transport;

    let pk = met.static_pk.clone();
    let peer = db.with(move |conn| store::peer_by_static_pk(conn, &pk))?;
    let Some(peer) = peer else {
        // A device this household does not know, or one it has forgotten. The
        // screen promises that forgetting a device stops this one syncing with
        // it, and this is where that promise is kept on the inbound path.
        let _ = wire::send(
            io,
            &mut transport,
            &wire::Msg::Error {
                detail: "this device is not paired with yours".into(),
            },
        );
        return Ok(None);
    };
    let seen = at.map(|ip| (ip, met.hello.listen_port));
    let out = session::run(io, &mut transport, db, &peer, seen, session::Role::Answerer)?;
    Ok(Some(out))
}

fn sk_of<K: Kitchen>(db: &K) -> Result<Vec<u8>, String> {
    let (_pk, sk) = db.with(|conn| ensure_identity(conn))?;
    Ok(sk)
}

/// A `Read + Write` pair of pipes, for exercising the protocol with no socket.
///
/// In the module rather than in the test module because both ends have to be
/// `Send` to hand one to a thread, and because a session test wants exactly
/// this and nothing more: no listener, no port, no network stack, no device.
#[cfg(test)]
pub struct Pipe {
    pub reader: std::sync::mpsc::Receiver<u8>,
    pub writer: std::sync::mpsc::Sender<u8>,
}

#[cfg(test)]
impl Pipe {
    /// Two ends of one conversation.
    pub fn pair() -> (Pipe, Pipe) {
        let (a_tx, a_rx) = std::sync::mpsc::channel();
        let (b_tx, b_rx) = std::sync::mpsc::channel();
        (
            Pipe {
                reader: a_rx,
                writer: b_tx,
            },
            Pipe {
                reader: b_rx,
                writer: a_tx,
            },
        )
    }
}

#[cfg(test)]
impl std::io::Read for Pipe {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        // Byte at a time, blocking on the first and taking whatever else is
        // already there. `read_exact` is what the framing uses, so a short read
        // is correct and a hang would be the bug.
        let first = self
            .reader
            .recv()
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::UnexpectedEof))?;
        buf[0] = first;
        let mut n = 1;
        while n < buf.len() {
            match self.reader.try_recv() {
                Ok(b) => {
                    buf[n] = b;
                    n += 1;
                }
                Err(_) => break,
            }
        }
        Ok(n)
    }
}

#[cfg(test)]
impl std::io::Write for Pipe {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        for b in buf {
            self.writer
                .send(*b)
                .map_err(|_| std::io::Error::from(std::io::ErrorKind::BrokenPipe))?;
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// The database, as a test holds it.
    ///
    /// The same contract `AppKitchen` implements, against a connection a test
    /// owns rather than one Tauri manages — which is the whole reason
    /// [`Kitchen`] is a trait: the protocol then runs between two in-memory
    /// databases in one process, with no app, no socket and no device.
    #[derive(Clone)]
    struct TestKitchen(Arc<StdMutex<Connection>>);

    impl Kitchen for TestKitchen {
        fn with<T>(
            &self,
            work: impl FnOnce(&mut Connection) -> Result<T, String>,
        ) -> Result<T, String> {
            let mut conn = self.0.lock().map_err(|e| e.to_string())?;
            work(&mut conn)
        }
    }

    /// An empty user database in the shape this build expects.
    ///
    /// The last three calls are not decoration, for the reason `store.rs`'s own
    /// helper records: `SCHEMA` alone leaves a database with no identity, no
    /// change-tracking triggers and no household key, which is a state the real
    /// app is never in — and a test against it would report a pot that never
    /// empties and a handshake that cannot start.
    fn kitchen() -> TestKitchen {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        c.execute_batch(store::SCHEMA).unwrap();
        store::ensure_device_identity(&c).unwrap();
        store::install_sync_triggers(&c).unwrap();
        ensure_identity(&c).unwrap();
        TestKitchen(Arc::new(StdMutex::new(c)))
    }

    fn identity(k: &TestKitchen) -> (Vec<u8>, Vec<u8>, String, String) {
        k.with(|conn| {
            let (pk, sk) = ensure_identity(conn)?;
            let d = store::this_device(conn)?;
            Ok((pk, sk, d.device_id, d.name))
        })
        .unwrap()
    }

    /// Two databases that hold each other as household members.
    fn household() -> (TestKitchen, TestKitchen) {
        let a = kitchen();
        let b = kitchen();
        let (a_pk, _, a_id, a_name) = identity(&a);
        let (b_pk, _, b_id, b_name) = identity(&b);
        a.with(|conn| store::pair_peer(conn, &b_id, &b_name, &b_pk, None))
            .unwrap();
        b.with(|conn| store::pair_peer(conn, &a_id, &a_name, &a_pk, None))
            .unwrap();
        (a, b)
    }

    /// A recipe, a pot cooked from it, and one helping taken out of the pot.
    fn cook_and_eat(k: &TestKitchen) -> (String, String) {
        k.with(|conn| {
            let rid = store::save_recipe(
                conn,
                "Rajma",
                900.0,
                Some(4.0),
                None,
                &[store::RecipeIngredient {
                    id: String::new(),
                    position: 0,
                    fdc_id: Some(16033),
                    description: "kidney beans".into(),
                    raw_g: 300.0,
                    cooked_g: 900.0,
                    optional: false,
                }],
                &[],
                &store::Tags::default(),
            )?;
            let cid = store::save_cook(
                conn,
                None,
                &store::CookInput {
                    recipe_id: Some(rid.clone()),
                    name: "Rajma".into(),
                    cooked_on: "2026-09-04".into(),
                    scale: 1.0,
                    gross_g: None,
                    vessel_ids: Vec::new(),
                    weighed_yield_g: Some(900.0),
                    notes: None,
                    defaults: store::Tags::default(),
                    ingredients: vec![store::CookIngredient {
                        id: String::new(),
                        position: 0,
                        fdc_id: Some(16033),
                        description: "kidney beans".into(),
                        planned_g: 900.0,
                        raw_g: 300.0,
                        cooked_g: 900.0,
                        substituted_for: None,
                    }],
                },
            )?;
            store::add(
                conn,
                "2026-09-04",
                Some("dinner"),
                store::Source::Cook(&cid),
                "Rajma",
                store::Quantity::Grams(300.0),
                None,
                &store::Tags::default(),
            )?;
            Ok((rid, cid))
        })
        .unwrap()
    }

    /// What one whole session did, from both ends of it.
    #[derive(Debug)]
    struct Talked {
        caller: (store::Applied, usize),
        answerer: (store::Applied, usize),
    }

    /// Run one whole session between two kitchens over a pair of pipes.
    ///
    /// `a` dials, exactly as `sync_now` does; `b` answers and looks the
    /// caller's key up in `peers`, exactly as the inbound listener does. No
    /// socket, no port, no network stack — which is the point.
    fn talk(a: &TestKitchen, b: &TestKitchen) -> Result<Talked, String> {
        let (_, a_sk, _, _) = identity(a);
        let b_side = b.clone();
        let (mut mine, mut theirs) = Pipe::pair();
        let answering = std::thread::spawn(move || answer_session(&b_side, &mut theirs, 0, None));

        let peer = a.with(|conn| {
            store::peers_to_dial(conn)?
                .into_iter()
                .next()
                .ok_or_else(|| "nobody to sync with".to_string())
        })?;
        let me = a.with(|conn| session::me(conn, 0))?;
        let dialled = handshake::resync_as_caller(&mut mine, &a_sk, &peer.static_pk, &me);
        let out = match dialled {
            Ok(met) => {
                let mut transport = met.transport;
                session::run(
                    &mut mine,
                    &mut transport,
                    a,
                    &peer,
                    None,
                    session::Role::Caller,
                )
            }
            Err(e) => Err(e),
        };
        let answered = answering.join().map_err(|_| "the answering side panicked")?;
        // A refusal is the answerer's verdict and is the interesting half when
        // the caller failed: the caller only sees the sentence it was sent.
        match answered? {
            None => Err("this device is not paired with yours".into()),
            Some(answerer) => Ok(Talked {
                caller: out?,
                answerer,
            }),
        }
    }

    #[test]
    fn two_devices_in_one_process_converge_on_one_kitchen() {
        let (a, b) = household();
        let (rid, cid) = cook_and_eat(&a);
        b.with(|conn| store::save_vessel(conn, None, "katori", 42.0).map(|_| ()))
            .unwrap();

        let t = talk(&a, &b).unwrap();
        assert_eq!(t.caller.0.taken, 1, "B's katori came back");
        assert_eq!(t.answerer.1, 1, "and it was the only thing B had to send");
        assert_eq!(
            t.answerer.0.taken, 3,
            "the recipe, the pot and the helping went over"
        );
        assert_eq!(
            (t.caller.1, t.answerer.0.kept),
            (4, 1),
            "A sent its own three plus the katori it had just adopted — applying \
             a peer's row moves it to the head of OUR feed, so a third device can \
             learn it from us, and B simply keeps the copy it already had"
        );
        assert_eq!(t.answerer.0.still_held, 0);

        // B has the kitchen, children inside their parents.
        b.with(|conn| {
            let name: String = conn
                .query_row("SELECT name FROM recipes WHERE id = ?1", [&rid], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            assert_eq!(name, "Rajma");
            let pots = store::list_open_cooks(conn)?;
            let pot = pots.iter().find(|p| p.id == cid).expect("the pot travelled");
            assert_eq!(pot.ingredients.len(), 1);
            // The one that proves `cook_draws` earns its own table: the pot is
            // smaller on the other device, and the meal is nowhere in it.
            assert!(pot.remaining_g < 900.0, "the helping came off the pot");
            let entries: i64 = conn
                .query_row("SELECT COUNT(*) FROM log_entries", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            assert_eq!(entries, 0, "the eating is not shared");
            Ok(())
        })
        .unwrap();

        // And A has B's vessel.
        a.with(|conn| {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM vessels WHERE name = 'katori'",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            assert_eq!(n, 1);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn both_watermarks_move_in_one_connection() {
        let (a, b) = household();
        cook_and_eat(&a);
        b.with(|conn| store::save_vessel(conn, None, "katori", 42.0).map(|_| ()))
            .unwrap();
        talk(&a, &b).unwrap();

        // Nobody dialled twice. Each side got through the other's feed, was
        // acknowledged for its own, and stopped reading as never synced.
        for (side, who) in [(&a, "A"), (&b, "B")] {
            let (applied, acked, seen): (i64, i64, Option<String>) = side
                .with(|conn| {
                    conn.query_row(
                        "SELECT applied_through, acked_through, last_synced_at FROM peers",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .map_err(|e| e.to_string())
                })
                .unwrap();
            assert!(applied > 0, "{who} got nowhere through the other's feed");
            assert!(acked > 0, "{who} was never acknowledged for its own");
            assert!(seen.is_some(), "{who} still reads as never having synced");
        }
    }

    #[test]
    fn the_echo_of_an_applied_row_settles_rather_than_looping() {
        // Applying a peer's row moves it to the head of OUR feed, so a third
        // device can learn it from us. The consequence is that each side offers
        // the other's own rows back exactly once, keeps them, and is then done
        // — this is the test that it is once and not for ever.
        let (a, b) = household();
        cook_and_eat(&a);
        b.with(|conn| store::save_vessel(conn, None, "katori", 42.0).map(|_| ()))
            .unwrap();
        talk(&a, &b).unwrap();

        let second = talk(&a, &b).unwrap();
        assert_eq!(second.caller.0.taken, 0, "nothing was newer");
        assert_eq!(second.answerer.0.taken, 0);
        assert!(
            second.caller.0.kept > 0,
            "and every row was decided rather than skipped"
        );

        let third = talk(&a, &b).unwrap();
        assert_eq!(third.caller.1, 0);
        assert_eq!(third.answerer.1, 0);
        assert_eq!(
            session::detail(third.caller.1, &third.caller.0),
            "Nothing to send; nothing came back."
        );
        for (side, who) in [(&a, "A"), (&b, "B")] {
            assert_eq!(
                side.with(|conn| store::queued_for_peers(conn)).unwrap(),
                0,
                "{who} still thinks it owes the other something"
            );
        }
    }

    #[test]
    fn a_sync_that_is_still_holding_a_row_says_so_rather_than_reporting_success() {
        let (a, b) = household();
        let (rid, _cid) = cook_and_eat(&a);
        // The recipe is kept out of the feed, so the pot and the helping arrive
        // with nothing to hang off. Held whole, not applied in part.
        a.with(|conn| {
            conn.execute(
                "DELETE FROM row_version WHERE table_name = 'recipes' AND row_id = ?1",
                [&rid],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();

        let t = talk(&a, &b).unwrap();
        let (applied, sent) = t.answerer;
        assert!(applied.still_held > 0, "the pot is waiting for its recipe");
        let sentence = session::detail(sent, &applied);
        assert!(
            sentence.contains("not finished"),
            "a green line over a fridge that is missing a pot is a lie: {sentence}"
        );
        b.with(|conn| {
            let pots: i64 = conn
                .query_row("SELECT COUNT(*) FROM cooks", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            assert_eq!(pots, 0, "half a pot is worse than no pot");
            let lines: i64 = conn
                .query_row("SELECT COUNT(*) FROM cook_ingredients", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            assert_eq!(lines, 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_device_this_household_does_not_know_is_refused_before_a_single_row() {
        // The property that keeps an unpaired device on the same Wi-Fi from
        // being able to say anything this app will act on.
        let a = kitchen();
        let b = kitchen();
        let (a_pk, _, _, _) = identity(&a);
        let (b_pk, _, b_id, b_name) = identity(&b);
        // A believes it is in the household; B has never heard of it.
        a.with(|conn| store::pair_peer(conn, &b_id, &b_name, &b_pk, None))
            .unwrap();
        cook_and_eat(&a);

        let err = talk(&a, &b).unwrap_err();
        assert!(
            err.contains("not paired"),
            "an unpaired device must be refused with a sentence: {err}"
        );
        b.with(|conn| {
            assert!(store::peer_by_static_pk(conn, &a_pk)?.is_none());
            let recipes: i64 = conn
                .query_row("SELECT COUNT(*) FROM recipes", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            assert_eq!(recipes, 0, "and nothing of theirs landed");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_forgotten_device_cannot_push_rows_back_in() {
        let (a, b) = household();
        cook_and_eat(&a);
        let (_, _, a_id, _) = identity(&a);
        b.with(|conn| store::unpair(conn, &a_id)).unwrap();
        let err = talk(&a, &b).unwrap_err();
        assert!(
            err.contains("not paired"),
            "the screen promises that forgetting stops the sync: {err}"
        );
    }

    // -----------------------------------------------------------------------
    // The handshake
    // -----------------------------------------------------------------------

    /// One pairing handshake over a pair of pipes, both sides at once.
    ///
    /// `scanner_qr` is what the phone actually read, which is deliberately
    /// allowed to differ from what the Mac printed, and `claims` is the key the
    /// scanned code says it belongs to.
    fn pair_over_pipes(
        shower_qr: &str,
        scanner_qr: &str,
        claims: Option<Vec<u8>>,
    ) -> (Result<String, String>, Result<String, String>) {
        let (shower_pk, shower_sk) = handshake::mint().unwrap();
        let (_scanner_pk, scanner_sk) = handshake::mint().unwrap();
        let expects = claims.unwrap_or(shower_pk);

        let (mut a, b) = Pipe::pair();
        let qr = shower_qr.to_string();
        let showing = std::thread::spawn(move || {
            let me = wire::Hello {
                device_id: "mac-1".into(),
                name: "Kitchen Mac".into(),
                listen_port: 0,
            };
            handshake::pair_as_shower(&mut a, &shower_sk, qr.as_bytes(), &me).map(|m| m.digits)
        });
        let me = wire::Hello {
            device_id: "phone-1".into(),
            name: "Pixel".into(),
            listen_port: 51733,
        };
        // Scoped so the scanner's end of the pipe is DROPPED before the other
        // thread is joined. A handshake that fails half way leaves the far side
        // blocked on a message that will never come, and only closing the pipe
        // tells it so — a real socket gets the same news from a TCP reset.
        let scanned = {
            let mut b = b;
            handshake::pair_as_scanner(&mut b, &scanner_sk, scanner_qr.as_bytes(), &expects, &me)
                .map(|m| m.digits)
        };
        let shown = showing
            .join()
            .unwrap_or_else(|_| Err("the showing side panicked".into()));
        (shown, scanned)
    }

    const A_CODE: &str = "trackit-household-1|192.168.0.7|51733|AAAA|2026-09-10T12:00:00Z";

    #[test]
    fn both_sides_derive_the_same_six_digits() {
        let (shown, scanned) = pair_over_pipes(A_CODE, A_CODE, None);
        let shown = shown.unwrap();
        let scanned = scanned.unwrap();
        assert_eq!(shown, scanned, "a Mac and a phone must compute the same string");
        assert_eq!(shown.len(), 6);
        assert!(shown.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn a_scanner_that_read_a_different_code_fails_before_the_digits() {
        let other = "trackit-household-1|192.168.0.9|51733|AAAA|2026-09-10T12:00:00Z";
        let (_shown, scanned) = pair_over_pipes(A_CODE, other, None);
        assert!(
            scanned.is_err(),
            "the code is bound into the prologue, so this fails at the handshake \
             rather than at the comparison"
        );
    }

    #[test]
    fn a_scanner_whose_code_names_a_different_key_refuses_before_showing_digits() {
        let (_shown, scanned) = pair_over_pipes(A_CODE, A_CODE, Some(vec![9u8; 32]));
        assert_eq!(
            scanned.unwrap_err(),
            "that code belongs to a different device"
        );
    }

    /// What one whole pairing did, from both ends of it.
    struct Settled {
        /// Whether each side wrote the other into `peers`.
        wrote: (bool, bool),
        /// The stage each screen was left on.
        stage: (PairingState, PairingState),
    }

    /// Both halves of one pairing — digits, verdicts and the row or no row —
    /// over a pair of pipes, with `answers` standing in for the two users.
    ///
    /// The whole point of running it in one process is the second assertion
    /// below: that a household gains a member only when BOTH people said the
    /// digits matched. In a room with two devices that is a thing you can only
    /// check by tapping "No" on one of them and looking at the other.
    fn settle_over_pipes(answers: (bool, bool)) -> Settled {
        let (shower, scanner) = (kitchen(), kitchen());
        let (shower_pk, shower_sk, _, _) = identity(&shower);
        let (scanner_pk, scanner_sk, _, _) = identity(&scanner);
        let shower_hub = Arc::new(Hub::new());
        let scanner_hub = Arc::new(Hub::new());
        let deadline = Instant::now() + Duration::from_secs(20);

        let (mut a, mut b) = Pipe::pair();
        let dialled_pk = shower_pk.clone();
        let showing = {
            let db = shower.clone();
            let hub = Arc::clone(&shower_hub);
            std::thread::spawn(move || {
                let epoch = hub.begin();
                let me = db.with(|conn| session::me(conn, 51733))?;
                let met =
                    handshake::pair_as_shower(&mut a, &shower_sk, A_CODE.as_bytes(), &me)?;
                let at = "192.168.0.9:40000".parse().unwrap();
                settle(&db, &hub, &mut a, met, at, epoch, deadline)
            })
        };
        let scanning = {
            let db = scanner.clone();
            let hub = Arc::clone(&scanner_hub);
            std::thread::spawn(move || {
                let epoch = hub.begin();
                let me = db.with(|conn| session::me(conn, 40000))?;
                let met = handshake::pair_as_scanner(
                    &mut b,
                    &scanner_sk,
                    A_CODE.as_bytes(),
                    &dialled_pk,
                    &me,
                )?;
                let at = "192.168.0.7:51733".parse().unwrap();
                settle(&db, &hub, &mut b, met, at, epoch, deadline)
            })
        };
        // Wait for both screens to be showing digits before answering either.
        // `await_verdict` reads the flag before it sleeps, so answering early
        // would not be lost — but it would also not be the thing this is meant
        // to be exercising.
        for _ in 0..600 {
            if matches!(shower_hub.state(), PairingState::Confirming { .. })
                && matches!(scanner_hub.state(), PairingState::Confirming { .. })
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        shower_hub.answer(answers.0);
        scanner_hub.answer(answers.1);
        let _ = showing.join().unwrap();
        let _ = scanning.join().unwrap();
        let wrote = |k: &TestKitchen, pk: &[u8]| {
            k.with(|conn| store::peer_by_static_pk(conn, pk).map(|p| p.is_some()))
                .unwrap()
        };
        Settled {
            wrote: (wrote(&shower, &scanner_pk), wrote(&scanner, &shower_pk)),
            stage: (shower_hub.state(), scanner_hub.state()),
        }
    }

    #[test]
    fn both_users_saying_yes_is_what_puts_a_device_in_the_household() {
        let s = settle_over_pipes((true, true));
        assert_eq!(s.wrote, (true, true), "each device wrote the other down");
        assert!(matches!(s.stage.0, PairingState::Paired { .. }));
        assert!(matches!(s.stage.1, PairingState::Paired { .. }));
    }

    #[test]
    fn one_user_refusing_the_digits_lets_nobody_into_either_kitchen() {
        // The device whose user said yes is the one at risk: without the
        // exchange it would write down a member the other household refused,
        // and there is no server anywhere that could tell it otherwise
        // afterwards.
        let s = settle_over_pipes((true, false));
        assert_eq!(s.wrote, (false, false), "a refusal binds both sides");
        // And the user who said yes is told why nobody joined, rather than
        // being dropped back on a code with no account of what happened.
        match s.stage.0 {
            PairingState::Failed { ref detail } => {
                assert!(detail.contains("did not match"), "{detail}");
            }
            other => panic!("the side that said yes was told nothing: {other:?}"),
        }

        let flipped = settle_over_pipes((false, true));
        assert_eq!(flipped.wrote, (false, false), "and it binds them either way");
    }

    #[test]
    fn two_sessions_from_the_same_code_produce_different_digits() {
        // The shoulder-surfer the Household screen's own copy names: somebody
        // who photographed the code from across the room passes the prologue
        // and the key check and still gets different digits, because the
        // handshake hash commits to both ephemerals.
        let (first, _) = pair_over_pipes(A_CODE, A_CODE, None);
        let (second, _) = pair_over_pipes(A_CODE, A_CODE, None);
        assert_ne!(first.unwrap(), second.unwrap());
    }

    #[test]
    fn a_resync_against_the_wrong_key_is_refused() {
        let (_pk, answer_sk) = handshake::mint().unwrap();
        let (_pk2, call_sk) = handshake::mint().unwrap();
        let (mut a, b) = Pipe::pair();
        let answering = std::thread::spawn(move || {
            let me = wire::Hello {
                device_id: "mac-1".into(),
                name: "Mac".into(),
                listen_port: 0,
            };
            handshake::resync_as_answerer(&mut a, &answer_sk, &me).map(|m| m.digits)
        });
        let me = wire::Hello {
            device_id: "phone-1".into(),
            name: "Pixel".into(),
            listen_port: 0,
        };
        // Scoped for the reason `pair_over_pipes` is: the answering side is
        // waiting on a message this caller will never send.
        let err = {
            let mut b = b;
            match handshake::resync_as_caller(&mut b, &call_sk, &[3u8; 32], &me) {
                Ok(_) => panic!("a key the household does not know completed a resync"),
                Err(e) => e,
            }
        };
        assert!(
            err.contains("not the device this household is paired with"),
            "reaching an address proves nothing: {err}"
        );
        let _ = answering.join();
    }

    /// Two transport states over one pipe pair, for the framing tests.
    fn transports() -> (snow::TransportState, snow::TransportState, Pipe, Pipe) {
        let (answer_pk, answer_sk) = handshake::mint().unwrap();
        let (_pk, call_sk) = handshake::mint().unwrap();
        let (mut a, mut b) = Pipe::pair();
        let answering = std::thread::spawn(move || {
            let me = wire::Hello {
                device_id: "mac-1".into(),
                name: "Mac".into(),
                listen_port: 0,
            };
            let met = handshake::resync_as_answerer(&mut a, &answer_sk, &me);
            (met, a)
        });
        let me = wire::Hello {
            device_id: "phone-1".into(),
            name: "Pixel".into(),
            listen_port: 0,
        };
        let caller = handshake::resync_as_caller(&mut b, &call_sk, &answer_pk, &me).unwrap();
        let (answered, a) = answering.join().unwrap();
        (caller.transport, answered.unwrap().transport, b, a)
    }

    #[test]
    fn a_value_larger_than_one_noise_message_round_trips_in_chunks() {
        let (mut caller_t, mut answer_t, mut caller_io, mut answer_io) = transports();
        // Comfortably over the 65,519 bytes of plaintext one Noise message
        // carries, which is what the continuation byte exists for.
        let big = "x".repeat(200_000);
        let msg = wire::Msg::Error {
            detail: big.clone(),
        };
        let reading =
            std::thread::spawn(move || wire::recv(&mut answer_io, &mut answer_t));
        wire::send(&mut caller_io, &mut caller_t, &msg).unwrap();
        match reading.join().unwrap().unwrap() {
            wire::Msg::Error { detail } => assert_eq!(detail, big),
            other => panic!("came back as something else: {other:?}"),
        }
    }

    #[test]
    fn an_unknown_message_tag_is_answered_rather_than_fatal() {
        // A household where the Mac is a release ahead of the phone is the
        // normal case, so a tag this build has never heard of has to parse.
        let parsed: wire::Msg =
            serde_json::from_str(r#"{"t":"something_new","extra":7}"#).unwrap();
        assert!(matches!(parsed, wire::Msg::Unknown));
    }

    #[test]
    fn a_frame_larger_than_one_noise_message_is_refused_by_the_framing() {
        let mut sink: Vec<u8> = Vec::new();
        let err = wire::put(&mut sink, &vec![0u8; 70_000]).unwrap_err();
        assert!(err.contains("larger than one Noise message"), "{err}");
    }

    // -----------------------------------------------------------------------
    // The code on the glass
    // -----------------------------------------------------------------------

    #[test]
    fn a_pairing_code_round_trips_through_the_string_it_is_printed_as() {
        let raw = build_code(
            &["192.168.0.7".parse().unwrap(), "10.0.0.4".parse().unwrap()],
            51733,
            &[7u8; 32],
            "2026-09-10T12:02:00Z",
        );
        let code = parse_code(&raw).unwrap();
        assert_eq!(code.addresses.len(), 2);
        assert_eq!(code.port, 51733);
        assert_eq!(code.static_pk, vec![7u8; 32]);
        assert_eq!(code.expires_at, "2026-09-10T12:02:00Z");
        assert_eq!(
            code.raw, raw,
            "the exact bytes are hashed into the prologue, so they are kept \
             rather than rebuilt from the parts"
        );
    }

    #[test]
    fn something_that_is_not_a_pairing_code_is_refused_with_a_sentence() {
        for junk in [
            "https://example.com/x",
            "trackit-household-1|192.168.0.7|51733",
            "trackit-household-2|192.168.0.7|51733|AAAA|2026-09-10T12:00:00Z",
            "trackit-household-1|not-an-ip|51733|AAAA|2026-09-10T12:00:00Z",
            "trackit-household-1|192.168.0.7|0|AAAA|2026-09-10T12:00:00Z",
        ] {
            let err = parse_code(junk).unwrap_err();
            assert!(
                err.starts_with(|c: char| c.is_lowercase()),
                "a refusal the user caused reads as a lowercase sentence: {err}"
            );
            assert!(!err.ends_with('.'), "and carries no trailing point: {err}");
        }
    }

    #[test]
    fn a_code_that_carries_a_short_key_is_refused() {
        let raw = build_code(
            &["192.168.0.7".parse().unwrap()],
            51733,
            &[7u8; 16],
            "2026-09-10T12:02:00Z",
        );
        assert!(
            parse_code(&raw).is_err(),
            "a short key is a handshake that silently never completes"
        );
    }

    #[test]
    fn the_pairing_code_stays_small_enough_to_scan() {
        // Past about 145 bytes the code goes from 45 modules to 49, which at
        // the camera's probe resolution is under six pixels a module with JPEG
        // artefacts across the boundaries — and then it simply never scans.
        // Two addresses is the cap; this is what keeps it honest.
        let raw = build_code(
            &[
                "192.168.100.201".parse().unwrap(),
                "10.211.55.101".parse().unwrap(),
            ],
            65535,
            &[7u8; 32],
            "2026-09-10T12:02:00Z",
        );
        assert!(raw.len() <= 145, "{} bytes: {raw}", raw.len());
        let span = qr::span(&raw).unwrap();
        assert!(span <= 53, "{span} modules including the quiet zone");
    }

    #[test]
    fn the_code_is_drawn_with_a_quiet_zone_and_real_contrast() {
        let raw = build_code(
            &["192.168.0.7".parse().unwrap()],
            51733,
            &[7u8; 32],
            "2026-09-10T12:02:00Z",
        );
        let svg = qr::svg(&raw).unwrap();
        let span = qr::span(&raw).unwrap();
        assert!(
            svg.contains(&format!("viewBox=\"0 0 {span} {span}\"")),
            "a code without a quiet zone does not scan"
        );
        assert!(svg.contains("fill=\"#fff\""), "white ground in both schemes");
        assert!(svg.contains("fill=\"#000\""), "and dark modules");
        assert!(
            !svg.contains("<rect x="),
            "one path rather than two thousand elements the webview has to lay out"
        );
    }

    // -----------------------------------------------------------------------
    // Finding a device again
    // -----------------------------------------------------------------------

    #[test]
    fn a_probe_is_recognised_only_by_the_holder_of_the_key_it_names() {
        let sock = UdpSocket::bind("127.0.0.1:0").unwrap();
        let listening = sock.local_addr().unwrap();
        let answering = std::thread::spawn(move || {
            sock.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            // Twice: once holding the key the probe names, once not.
            discover::answer_probes(&sock, 51733, || vec![vec![7u8; 32]]).unwrap();
            discover::answer_probes(&sock, 51733, || vec![vec![9u8; 32]]).unwrap();
        });

        let found = discover::sweep(&[listening], &[7u8; 32], Duration::from_millis(900)).unwrap();
        assert_eq!(
            found.map(|a| a.port()),
            Some(51733),
            "and it announces the port it answers on rather than agreeing one in advance"
        );
        let missed =
            discover::sweep(&[listening], &[8u8; 32], Duration::from_millis(400)).unwrap();
        assert!(
            missed.is_none(),
            "an unpaired listener learns nothing from being swept, and says nothing"
        );
        answering.join().unwrap();
    }

    #[test]
    fn the_code_carries_the_addresses_another_device_could_actually_dial() {
        // A phone with mobile data up, a Wi-Fi lease, and an interface that
        // never got one. Only two of these fit in the code, and the order is
        // what decides which two — so a carrier address must not be able to
        // push the Wi-Fi address out, and a self-assigned 169.254 must not be
        // offered to anybody at all.
        let ranked = discover::rank_addresses(vec![
            "169.254.31.8".parse().unwrap(),
            "100.82.14.3".parse().unwrap(),
            "192.168.0.7".parse().unwrap(),
            "10.211.55.2".parse().unwrap(),
        ]);
        assert_eq!(
            ranked,
            vec![
                "192.168.0.7".parse::<Ipv4Addr>().unwrap(),
                "10.211.55.2".parse().unwrap(),
                "100.82.14.3".parse().unwrap(),
            ],
            "a link-local is no way back to a device, and a carrier address \
             must not crowd out the Wi-Fi one the code has room for"
        );
        let mut kept = ranked;
        kept.truncate(MAX_ADDRESSES);
        assert!(kept.iter().all(|ip| ip.octets()[0] == 192 || ip.octets()[0] == 10));
    }

    #[test]
    fn a_sweep_covers_a_subnet_without_naming_the_network_or_itself() {
        assert_eq!(discover::prefix_len("255.255.255.0".parse().unwrap()), 24);
        assert_eq!(discover::prefix_len("255.255.0.0".parse().unwrap()), 16);
        let hosts = discover::hosts_of(
            "192.168.0.7".parse().unwrap(),
            "255.255.255.0".parse().unwrap(),
        );
        assert_eq!(hosts.len(), 253, "254 hosts, less this device itself");
        assert!(!hosts.contains(&"192.168.0.7".parse().unwrap()));
        assert!(!hosts.contains(&"192.168.0.0".parse().unwrap()));
        assert!(!hosts.contains(&"192.168.0.255".parse().unwrap()));
    }

    // -----------------------------------------------------------------------
    // What the screen is told
    // -----------------------------------------------------------------------

    #[test]
    fn the_sentence_never_reads_as_a_bare_tick() {
        let none = store::Applied::default();
        assert_eq!(
            session::detail(0, &none),
            "Nothing to send; nothing came back."
        );
        let mut some = store::Applied {
            taken: 12,
            released: 2,
            ..Default::default()
        };
        let s = session::detail(3, &some);
        assert!(s.contains("3 changes went over"), "{s}");
        assert!(s.contains("14 came back"), "{s}");
        assert!(!s.contains('%'), "a count of things, never a percentage: {s}");
        some.still_held = 1;
        let held = session::detail(3, &some);
        assert!(held.contains("not finished"), "{held}");
        assert!(
            !held.contains("goal") && !held.contains("target"),
            "no budget grammar anywhere near this: {held}"
        );
    }

    #[test]
    fn a_hub_with_nothing_running_reports_waiting_and_cancels_without_error() {
        let hub = Hub::new();
        assert!(matches!(hub.state(), PairingState::Waiting));
        hub.cancel();
        assert!(matches!(hub.state(), PairingState::Waiting));
        assert!(hub.last().is_empty());
        assert_eq!(hub.listen_port(), None);
    }

    #[test]
    fn only_one_listener_is_ever_claimed() {
        // `serve` runs at launch AND the moment a pairing succeeds, so being
        // called twice is the ordinary case rather than a mistake.
        let hub = Hub::new();
        assert!(hub.claim_listener(51733));
        assert!(!hub.claim_listener(51734));
        assert_eq!(hub.listen_port(), Some(51733));
    }

    #[test]
    fn a_refused_comparison_returns_the_offer_to_waiting() {
        let hub = Hub::new();
        let epoch = hub.begin();
        hub.set_state(
            epoch,
            PairingState::Confirming {
                peer_name: "Pixel".into(),
                digits: "418207".into(),
            },
        );
        hub.back_to_waiting(epoch);
        assert!(
            matches!(hub.state(), PairingState::Waiting),
            "ending the offer instead would let anybody who reached the port \
             stop the pairing the user is actually trying to do"
        );
        assert!(hub.is_live(epoch), "and the offer is still standing");
    }

    #[test]
    fn a_stale_thread_cannot_write_over_a_fresh_offer() {
        let hub = Hub::new();
        let old = hub.begin();
        let fresh = hub.begin();
        hub.set_state(
            old,
            PairingState::Failed {
                detail: "from the offer before this one".into(),
            },
        );
        assert!(matches!(hub.state(), PairingState::Waiting));
        assert!(!hub.is_live(old));
        assert!(hub.is_live(fresh));
    }

    #[test]
    fn nobody_answering_the_digits_is_not_taken_as_a_yes() {
        let hub = Hub::new();
        let epoch = hub.begin();
        let waited = hub.await_verdict(epoch, Instant::now() + Duration::from_millis(50));
        assert_eq!(waited, None, "silence is not consent to let a device in");
    }
}
