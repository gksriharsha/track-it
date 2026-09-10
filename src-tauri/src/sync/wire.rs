//! What two devices in one household say to each other, and how it is framed.
//!
//! Everything here is generic over `impl Read + Write` rather than written
//! against `TcpStream`, and that is not politeness towards a future transport.
//! It is what lets the entire protocol — handshake, both feeds, both
//! watermarks, the merge — run inside `cargo test` between two in-memory
//! databases in one process, with no phone, no Wi-Fi and no second machine. A
//! protocol that can only be exercised with two devices in a kitchen is a
//! protocol nobody exercises.
//!
//! Deliberately absent: any notion of a request id, a stream multiplexer or a
//! retry. One connection carries one session, in a fixed order, and a session
//! that dies half way is a session that is run again — the watermark is what
//! makes that cheap and safe.

use std::io::{Read, Write};

use serde::{Deserialize, Serialize};

/// The most plaintext one Noise message can carry.
///
/// snow's own constants: `MAXMSGLEN` is 65,535 and `TAGLEN` is 16. Read out of
/// the crate rather than remembered, because a frame one byte over the limit is
/// an encrypt that fails at the far end of a working handshake.
pub const MAX_PLAIN: usize = 65519;

/// The most one application message may total, across however many Noise
/// frames it takes.
///
/// A ceiling rather than a guess. Without it a peer — or something pretending
/// to be one before the handshake has finished proving otherwise — could
/// announce continuation for ever and grow this buffer until the process died.
/// A frame of rows is capped at roughly 48 KB by the sender, so four megabytes
/// is two orders of magnitude of headroom and still nowhere near a phone's
/// patience.
const MAX_MESSAGE: usize = 4 * 1024 * 1024;

/// Write one Noise message, length-prefixed.
///
/// `u16` big-endian, which is exactly enough for the largest message the
/// protocol can produce and one byte fewer than the shortest varint that would
/// also do. `flush` is not optional: a `BufWriter` or a paired `TcpStream` with
/// Nagle on will otherwise hold the frame while the far side blocks reading it.
pub fn put<S: Write>(s: &mut S, frame: &[u8]) -> Result<(), String> {
    if frame.len() > u16::MAX as usize {
        return Err(format!("a {} byte frame is larger than one Noise message", frame.len()));
    }
    s.write_all(&(frame.len() as u16).to_be_bytes())
        .map_err(|e| e.to_string())?;
    s.write_all(frame).map_err(|e| e.to_string())?;
    s.flush().map_err(|e| e.to_string())
}

/// Read one length-prefixed Noise message into `buf`, returning its length.
///
/// `read_exact` twice rather than one read of whatever arrived: a TCP segment
/// boundary falls wherever the network puts it, and a partial frame handed to
/// `read_message` is a decrypt failure that looks exactly like an attack.
pub fn get<S: Read>(s: &mut S, buf: &mut [u8]) -> Result<usize, String> {
    let mut n = [0u8; 2];
    s.read_exact(&mut n).map_err(|e| e.to_string())?;
    let n = usize::from(u16::from_be_bytes(n));
    if n > buf.len() {
        return Err(format!("a {n} byte frame does not fit the read buffer"));
    }
    s.read_exact(&mut buf[..n]).map_err(|e| e.to_string())?;
    Ok(n)
}

/// One aggregate on the wire: a parent row and every child inside it.
///
/// The same shape `store::FeedRow` serialises to and `store::Incoming` reads
/// back, so what goes into `sync_pending` is the peer's own bytes rather than
/// something re-encoded here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub table: String,
    pub id: String,
    pub version: i64,
    pub device_id: String,
    pub seq: i64,
    pub changed_at: String,
    pub body: serde_json::Value,
}

/// Everything either side may say, after the handshake.
///
/// Tagged on `t` and flat. The `Unknown` arm matters: a household where the Mac
/// is a release ahead of the phone is the normal case, and a tag this build has
/// never heard of is then something to answer politely rather than a parse
/// failure that kills a session which was otherwise going to work.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Msg {
    /// Whether this side's user said the six digits matched. Sent by both, and
    /// the peer is written down only when both said yes — otherwise a household
    /// could gain a member the other device refused.
    Verdict { matches: bool },
    Pull {
        since: i64,
    },
    Rows {
        upto: i64,
        more: bool,
        rows: Vec<Envelope>,
    },
    Ack {
        applied_through: i64,
    },
    Error {
        detail: String,
    },
    Bye,
    #[serde(other)]
    Unknown,
}

/// What each side says about itself inside the handshake payloads.
///
/// `listen_port` is the port this device ANSWERS on, not the port a connection
/// happened to come from. Without it the remembered address would hold an
/// ephemeral source port, and the fast path on the next sync would miss every
/// single time — a connect timeout plus a whole subnet sweep, for ever, on the
/// side that only ever answered.
///
/// 0 means "not listening", which is the honest answer for a device that has
/// not paired with anybody yet and so binds nothing at all.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub device_id: String,
    pub name: String,
    #[serde(default)]
    pub listen_port: u16,
}

/// Send one application message, in as many Noise frames as it takes.
///
/// A continuation byte in front of every chunk: 1 means another frame follows,
/// 0 means this was the last. That single byte is what lets one message exceed
/// one Noise frame at all — the first sync of a kitchen with a fifty-ingredient
/// recipe in it does — without a second length field that could disagree with
/// the first.
pub fn send<S: Write>(s: &mut S, t: &mut snow::TransportState, m: &Msg) -> Result<(), String> {
    let text = serde_json::to_vec(m).map_err(|e| e.to_string())?;
    let mut frame = vec![0u8; 65535];
    let room = MAX_PLAIN - 1;
    let chunks = text.chunks(room).collect::<Vec<_>>();
    // An empty message would produce no chunks at all and so say nothing; a
    // serialised `Msg` is never empty, but a zero-length loop is a silence the
    // far side would wait out rather than an error either of us could see.
    if chunks.is_empty() {
        return Err("there is no such thing as an empty message here".into());
    }
    for (i, chunk) in chunks.iter().enumerate() {
        let last = i + 1 == chunks.len();
        let mut plain = Vec::with_capacity(chunk.len() + 1);
        plain.push(u8::from(!last));
        plain.extend_from_slice(chunk);
        let n = t
            .write_message(&plain, &mut frame)
            .map_err(|e| e.to_string())?;
        put(s, &frame[..n])?;
    }
    Ok(())
}

/// Read one application message, reassembling as many frames as it took.
pub fn recv<S: Read>(s: &mut S, t: &mut snow::TransportState) -> Result<Msg, String> {
    let mut frame = vec![0u8; 65535];
    let mut plain = vec![0u8; 65535];
    let mut text: Vec<u8> = Vec::new();
    loop {
        let n = get(s, &mut frame)?;
        let l = t
            .read_message(&frame[..n], &mut plain)
            .map_err(|e| e.to_string())?;
        if l == 0 {
            return Err("a frame arrived with no continuation byte in it".into());
        }
        text.extend_from_slice(&plain[1..l]);
        if text.len() > MAX_MESSAGE {
            return Err("that message is larger than this app will assemble".into());
        }
        if plain[0] == 0 {
            break;
        }
    }
    serde_json::from_slice(&text).map_err(|e| format!("reading what the other device said: {e}"))
}
