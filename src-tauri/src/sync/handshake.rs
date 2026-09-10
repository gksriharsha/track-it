//! Who is at the other end of the socket, and the six digits that prove it.
//!
//! One Noise pattern for both jobs: `Noise_XX_25519_ChaChaPoly_BLAKE2s`.
//!
//! `KK` was the obvious choice for a resync — both statics are already known,
//! so two messages would do — and it is unbuildable here. snow gives KK
//! pre-message statics for BOTH sides, so `build_responder` returns
//! `Prerequisite::RemotePublicKey` when the remote key is unset; and a device
//! answering an inbound connection does not yet know who is dialling it. The
//! alternatives were to buffer the first message and rebuild a responder per
//! candidate key until one decrypted — trial decryption against every device in
//! the house, on every connection — or to use XX for the resync too and check
//! the key afterwards. XX it is: three messages instead of two on a LAN is
//! nothing, and it makes `store::peer_by_static_pk`'s documented contract —
//! "who this is, by the key the handshake authenticated" — actually true.
//!
//! Under XX the responder learns the initiator's static DURING the handshake,
//! so every entry point here hands that key back and the caller is expected to
//! match it against `peers.static_pk` and refuse a key the household does not
//! know. Authenticating the connection and authorising it are two steps, and
//! keeping them apart is what lets the pairing path — where the key is
//! deliberately new — share this code with the resync path, where it must not
//! be.

use std::io::{Read, Write};

use snow::params::NoiseParams;
use snow::{Builder, HandshakeState, TransportState};

use super::wire::{self, Hello};

/// Mutual authentication with neither side knowing the other's static key in
/// advance. See the module comment for why this is also the resync pattern.
pub const XX: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";

/// Hashed into every handshake, so a message from this app can never be
/// replayed into anything else that happens to speak Noise.
pub const DOMAIN: &[u8] = b"trackit-household-v1";

/// The prologue for a resync between two devices that already know each other.
///
/// Distinct from a pairing prologue, which carries the QR payload: a pairing
/// message must not verify as a resync message or the key check would be the
/// only thing standing between the two, and one check is not two.
pub const RESYNC: &[u8] = b"trackit-household-v1|resync";

/// How long a handshake message may take to arrive before the session is given
/// up on. Generous for a LAN and short enough that a stalled socket does not
/// hold a thread for the life of the process.
pub const STEP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// The six digits, taken from the handshake hash.
///
/// Off the `HandshakeState` and not the `TransportState`: snow has no
/// `get_handshake_hash` on the latter, so this must happen before
/// `into_transport_mode`. Domain-separated so `h` is never the input to two
/// different things, and big-endian mod 10^6 so a Mac and a phone compute the
/// same six characters from the same handshake.
///
/// About twenty bits, which is plenty for a comparison a person makes once and
/// worth nothing to anybody who gets retries — which is why a live offer serves
/// one connection at a time and derives fresh digits for each.
pub fn sas(h: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::new()
        .chain_update(b"trackit-sas-v1")
        .chain_update(h)
        .finalize();
    format!(
        "{:06}",
        u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % 1_000_000
    )
}

/// What a completed handshake yields, whichever side of it you were on.
pub struct Met {
    pub transport: TransportState,
    /// The six digits. Computed on both paths even where nothing shows them,
    /// because it costs one hash and having it only on the pairing path would
    /// invite a future reader to wonder whether the two differ.
    pub digits: String,
    /// The peer's static public key, as the handshake proved it — never as the
    /// peer announced it.
    pub static_pk: Vec<u8>,
    /// What the peer says it is called and where it answers. A name is for a
    /// screen; it is never an identity.
    pub hello: Hello,
}

fn params() -> Result<NoiseParams, String> {
    XX.parse::<NoiseParams>().map_err(|e| e.to_string())
}

fn build(sk: &[u8], prologue: &[u8], initiator: bool) -> Result<HandshakeState, String> {
    let b = Builder::new(params()?)
        .local_private_key(sk)
        .map_err(|e| e.to_string())?
        .prologue(prologue)
        .map_err(|e| e.to_string())?;
    if initiator {
        b.build_initiator().map_err(|e| e.to_string())
    } else {
        b.build_responder().map_err(|e| e.to_string())
    }
}

/// Finish a handshake and read off everything it proved.
fn met(hs: HandshakeState, hello: Hello) -> Result<Met, String> {
    if !hs.is_handshake_finished() {
        return Err("that device stopped part way through introducing itself".into());
    }
    let digits = sas(hs.get_handshake_hash());
    let static_pk = hs
        .get_remote_static()
        .ok_or("that device did not present a household key")?
        .to_vec();
    let transport = hs.into_transport_mode().map_err(|e| e.to_string())?;
    Ok(Met {
        transport,
        digits,
        static_pk,
        hello,
    })
}

/// A `Hello` out of a handshake payload.
fn hello_from(plain: &[u8]) -> Result<Hello, String> {
    serde_json::from_slice(plain).map_err(|e| format!("reading what that device calls itself: {e}"))
}

/// Mint this device's static keypair.
///
/// Here rather than in `store.rs` because minting needs the protocol crate, and
/// the database layer has no business depending on one.
pub fn mint() -> Result<(Vec<u8>, Vec<u8>), String> {
    let kp = Builder::new(params()?)
        .generate_keypair()
        .map_err(|e| e.to_string())?;
    Ok((kp.public, kp.private))
}

/// The device SHOWING the code: TCP listener and Noise responder.
///
/// The payload it printed carries its own address and key, so the scanner needs
/// no discovery at all — which is why the first release ships no mDNS. `qr` is
/// the EXACT bytes of that payload, hashed into the prologue on both sides, so
/// a phone that read a different code fails outright rather than reaching the
/// digits.
pub fn pair_as_shower<S: Read + Write>(
    io: &mut S,
    my_sk: &[u8],
    qr: &[u8],
    me: &Hello,
) -> Result<Met, String> {
    let mut prologue = DOMAIN.to_vec();
    prologue.extend_from_slice(qr);
    let mut hs = build(my_sk, &prologue, false)?;
    let mut frame = vec![0u8; 65535];
    let mut plain = vec![0u8; 65535];

    let n = wire::get(io, &mut frame)?;
    hs.read_message(&frame[..n], &mut plain)
        .map_err(|e| e.to_string())?;

    let mine = serde_json::to_vec(me).map_err(|e| e.to_string())?;
    let n = hs.write_message(&mine, &mut frame).map_err(|e| e.to_string())?;
    wire::put(io, &frame[..n])?;

    let n = wire::get(io, &mut frame)?;
    let l = hs
        .read_message(&frame[..n], &mut plain)
        .map_err(|e| e.to_string())?;
    let theirs = hello_from(&plain[..l])?;
    met(hs, theirs)
}

/// The device that SCANNED the code: Noise initiator.
///
/// Two bindings to the code rather than one. The prologue is `DOMAIN` plus the
/// exact QR bytes on both sides, so reading the wrong code fails at the
/// handshake; and the responder's static key is hard-asserted equal to the key
/// printed in the code BEFORE any digits are shown. The six digits are a
/// second, human line of defence — never the only one.
pub fn pair_as_scanner<S: Read + Write>(
    io: &mut S,
    my_sk: &[u8],
    qr: &[u8],
    qr_static_pk: &[u8],
    me: &Hello,
) -> Result<Met, String> {
    let mut prologue = DOMAIN.to_vec();
    prologue.extend_from_slice(qr);
    let mut hs = build(my_sk, &prologue, true)?;
    let mut frame = vec![0u8; 65535];
    let mut plain = vec![0u8; 65535];

    let n = hs.write_message(&[], &mut frame).map_err(|e| e.to_string())?;
    wire::put(io, &frame[..n])?;

    let n = wire::get(io, &mut frame)?;
    let l = hs
        .read_message(&frame[..n], &mut plain)
        .map_err(|e| e.to_string())?;
    let theirs = hello_from(&plain[..l])?;
    if hs.get_remote_static() != Some(qr_static_pk) {
        return Err("that code belongs to a different device".into());
    }

    let mine = serde_json::to_vec(me).map_err(|e| e.to_string())?;
    let n = hs.write_message(&mine, &mut frame).map_err(|e| e.to_string())?;
    wire::put(io, &frame[..n])?;
    met(hs, theirs)
}

/// Resync, the dialling side.
///
/// `their_pk` is what the household believes this device's key to be, and a
/// mismatch is refused before a single row is asked for. Nothing is shown to
/// anybody: the digits exist, and the whole point of a resync is that nobody
/// has to look at them again.
pub fn resync_as_caller<S: Read + Write>(
    io: &mut S,
    my_sk: &[u8],
    their_pk: &[u8],
    me: &Hello,
) -> Result<Met, String> {
    let mut hs = build(my_sk, RESYNC, true)?;
    let mut frame = vec![0u8; 65535];
    let mut plain = vec![0u8; 65535];

    let n = hs.write_message(&[], &mut frame).map_err(|e| e.to_string())?;
    wire::put(io, &frame[..n])?;

    let n = wire::get(io, &mut frame)?;
    let l = hs
        .read_message(&frame[..n], &mut plain)
        .map_err(|e| e.to_string())?;
    let theirs = hello_from(&plain[..l])?;
    if hs.get_remote_static() != Some(their_pk) {
        return Err("something answered at that address, but not the device this household \
                    is paired with"
            .into());
    }

    let mine = serde_json::to_vec(me).map_err(|e| e.to_string())?;
    let n = hs.write_message(&mine, &mut frame).map_err(|e| e.to_string())?;
    wire::put(io, &frame[..n])?;
    met(hs, theirs)
}

/// Resync, the answering side.
///
/// Hands back the initiator's static key without judging it, because judging it
/// needs the database and this module has none. The caller looks it up in
/// `peers` and hangs up on a key the household does not know — which is the
/// property that keeps an unpaired device on the same Wi-Fi from being able to
/// say anything this app will act on.
pub fn resync_as_answerer<S: Read + Write>(
    io: &mut S,
    my_sk: &[u8],
    me: &Hello,
) -> Result<Met, String> {
    let mut hs = build(my_sk, RESYNC, false)?;
    let mut frame = vec![0u8; 65535];
    let mut plain = vec![0u8; 65535];

    let n = wire::get(io, &mut frame)?;
    hs.read_message(&frame[..n], &mut plain)
        .map_err(|e| e.to_string())?;

    let mine = serde_json::to_vec(me).map_err(|e| e.to_string())?;
    let n = hs.write_message(&mine, &mut frame).map_err(|e| e.to_string())?;
    wire::put(io, &frame[..n])?;

    let n = wire::get(io, &mut frame)?;
    let l = hs
        .read_message(&frame[..n], &mut plain)
        .map_err(|e| e.to_string())?;
    let theirs = hello_from(&plain[..l])?;
    met(hs, theirs)
}
