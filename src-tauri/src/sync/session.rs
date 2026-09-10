//! One session: both feeds, both watermarks, one connection.
//!
//! Generic over the stream and over the database handle, for the reason stated
//! in `wire`: this is the half of the feature that can be wrong in ways nobody
//! sees, and it has to be exercisable between two in-memory databases inside
//! one `cargo test`.
//!
//! The lock discipline is the load-bearing part. Every outbound frame is built
//! in memory with the database locked and written with it dropped; every
//! inbound frame is applied in its own transaction. So the database is never
//! held across a socket read, a sync in progress cannot freeze the interface
//! for longer than one apply, and a session that dies half way leaves whole
//! aggregates behind with the watermark past exactly those that committed.

use std::io::{Read, Write};

use crate::store;

use super::wire::{self, Envelope, Hello, Msg};
use super::Kitchen;

/// Which side dialled. The caller pulls first; that is the only difference.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Role {
    Caller,
    Answerer,
}

/// How many aggregates one frame may carry, and how many bytes.
///
/// Both, not either. Two hundred vessels are a few kilobytes; two hundred pots
/// with fifty ingredient lines each are not, and the point of a cap is to bound
/// the length of one apply transaction — which is how long the interface can be
/// made to wait — rather than to bound a row count for its own sake.
const FRAME_ROWS: usize = 200;
const FRAME_BYTES: usize = 48 * 1024;

/// Read one frame of rows and apply it, returning what it did and how far it
/// took the watermark.
fn take_frame<K: Kitchen>(
    db: &K,
    peer: &store::PeerDial,
    seen_at: Option<&(String, u16)>,
    upto: i64,
    rows: &[Envelope],
) -> Result<store::Applied, String> {
    // The envelope's own fields, re-encoded from the struct they parsed into.
    // Nothing has been interpreted here — no column dropped, no value coerced,
    // no default filled in — which is what `sync_pending.payload` is asking for
    // when it says a retry must re-decide from what arrived.
    let mut incoming = Vec::with_capacity(rows.len());
    for env in rows {
        let text = serde_json::to_string(env).map_err(|e| e.to_string())?;
        incoming.push(store::Incoming::from_envelope(&text)?);
    }
    let device_id = peer.device_id.clone();
    let seen = seen_at.map(|(a, p)| (a.clone(), *p));
    db.with(move |conn| {
        store::apply_batch(
            conn,
            &device_id,
            &incoming,
            upto,
            seen.as_ref().map(|(a, p)| (a.as_str(), *p)),
        )
    })
}

/// Answer a pull: stream everything the peer has not got, in frames.
///
/// Returns the highest `seq` sent, which is what the peer will acknowledge once
/// it has committed it. `more` is decided from what the database actually
/// returned rather than from a second count, so a row written mid-session
/// cannot fall through the gap between the two.
fn stream_rows<S: Read + Write, K: Kitchen>(
    io: &mut S,
    t: &mut snow::TransportState,
    db: &K,
    since: i64,
) -> Result<(i64, usize), String> {
    let mut cursor = since;
    let mut sent = 0usize;
    loop {
        let (rows, batch_upto, batch_more) =
            db.with(|conn| store::feed_since(conn, cursor, FRAME_ROWS))?;
        if rows.is_empty() {
            wire::send(
                io,
                t,
                &Msg::Rows {
                    upto: batch_upto,
                    more: false,
                    rows: Vec::new(),
                },
            )?;
            return Ok((batch_upto, sent));
        }

        // Split by bytes inside the batch. A frame is closed as soon as adding
        // the next aggregate would take it past the budget, and never before
        // the first one — a single fifty-ingredient pot larger than the budget
        // still has to travel, and `wire::send` splits it across Noise frames.
        let mut frame: Vec<Envelope> = Vec::new();
        let mut bytes = 0usize;
        let last = rows.len() - 1;
        for (i, r) in rows.iter().enumerate() {
            let env = Envelope {
                table: r.table.clone(),
                id: r.id.clone(),
                version: r.version,
                device_id: r.device_id.clone(),
                seq: r.seq,
                changed_at: r.changed_at.clone(),
                body: r.body.clone(),
            };
            let size = serde_json::to_string(&env).map_err(|e| e.to_string())?.len();
            if !frame.is_empty() && bytes + size > FRAME_BYTES {
                let upto = frame[frame.len() - 1].seq;
                sent += frame.len();
                wire::send(io, t, &Msg::Rows { upto, more: true, rows: std::mem::take(&mut frame) })?;
                bytes = 0;
            }
            bytes += size;
            frame.push(env);
            if i == last {
                let upto = frame[frame.len() - 1].seq;
                sent += frame.len();
                wire::send(
                    io,
                    t,
                    &Msg::Rows {
                        upto,
                        more: batch_more,
                        rows: std::mem::take(&mut frame),
                    },
                )?;
                cursor = upto;
            }
        }
        if !batch_more {
            return Ok((cursor, sent));
        }
    }
}

/// Receive rows until the peer says there are no more, applying each frame.
fn take_rows<S: Read + Write, K: Kitchen>(
    io: &mut S,
    t: &mut snow::TransportState,
    db: &K,
    peer: &store::PeerDial,
    seen_at: Option<&(String, u16)>,
) -> Result<(store::Applied, i64), String> {
    let mut total = store::Applied::default();
    let mut reached = peer.applied_through;
    loop {
        match wire::recv(io, t)? {
            Msg::Rows { upto, more, rows } => {
                let one = take_frame(db, peer, seen_at, upto, &rows)?;
                total.add(&one);
                reached = reached.max(upto);
                if !more {
                    return Ok((total, reached));
                }
            }
            Msg::Error { detail } => return Err(detail),
            other => {
                return Err(format!(
                    "expected a frame of changes and got {}",
                    named(&other)
                ))
            }
        }
    }
}

/// What a message is, for a sentence that has to name one.
fn named(m: &Msg) -> &'static str {
    match m {
        Msg::Verdict { .. } => "an answer to the six digits",
        Msg::Pull { .. } => "a request for changes",
        Msg::Rows { .. } => "a frame of changes",
        Msg::Ack { .. } => "an acknowledgement",
        Msg::Error { .. } => "a refusal",
        Msg::Bye => "a goodbye",
        Msg::Unknown => "something this version does not understand",
    }
}

/// Run one whole session.
///
/// The order, and both sides walk it in step:
///
/// the caller asks for changes; the answerer streams them; the answerer then
/// asks for changes of its own; the caller streams them; the answerer says how
/// far it got, and the caller says how far IT got. Both watermarks move in one
/// connection, so nobody has to dial twice.
pub fn run<S: Read + Write, K: Kitchen>(
    io: &mut S,
    t: &mut snow::TransportState,
    db: &K,
    peer: &store::PeerDial,
    seen_at: Option<(String, u16)>,
    role: Role,
) -> Result<(store::Applied, usize), String> {
    let seen = seen_at.as_ref();
    let (applied, sent) = match role {
        Role::Caller => {
            wire::send(io, t, &Msg::Pull { since: peer.applied_through })?;
            let (applied, reached) = take_rows(io, t, db, peer, seen)?;
            let since = match wire::recv(io, t)? {
                Msg::Pull { since } => since,
                Msg::Error { detail } => return Err(detail),
                other => {
                    return Err(format!(
                        "expected a request for changes and got {}",
                        named(&other)
                    ))
                }
            };
            let (_upto, sent) = stream_rows(io, t, db, since)?;
            match wire::recv(io, t)? {
                Msg::Ack { applied_through } => {
                    let id = peer.device_id.clone();
                    db.with(move |conn| store::note_ack(conn, &id, applied_through))?;
                }
                Msg::Error { detail } => return Err(detail),
                other => {
                    return Err(format!("expected an acknowledgement and got {}", named(&other)))
                }
            }
            wire::send(io, t, &Msg::Ack { applied_through: reached })?;
            (applied, sent)
        }
        Role::Answerer => {
            let since = match wire::recv(io, t)? {
                Msg::Pull { since } => since,
                Msg::Error { detail } => return Err(detail),
                other => {
                    return Err(format!(
                        "expected a request for changes and got {}",
                        named(&other)
                    ))
                }
            };
            let (_upto, sent) = stream_rows(io, t, db, since)?;
            wire::send(io, t, &Msg::Pull { since: peer.applied_through })?;
            let (applied, reached) = take_rows(io, t, db, peer, seen)?;
            wire::send(io, t, &Msg::Ack { applied_through: reached })?;
            match wire::recv(io, t)? {
                Msg::Ack { applied_through } => {
                    let id = peer.device_id.clone();
                    db.with(move |conn| store::note_ack(conn, &id, applied_through))?;
                }
                Msg::Error { detail } => return Err(detail),
                other => {
                    return Err(format!("expected an acknowledgement and got {}", named(&other)))
                }
            }
            (applied, sent)
        }
    };

    // The last thing either side does. A session that reached here completed,
    // and `last_synced_at` is what stops the Household screen showing a grey
    // pip and "paired, not synced yet" over a device it has just talked to.
    let id = peer.device_id.clone();
    db.with(move |conn| store::note_synced(conn, &id))?;
    // Best effort, and deliberately not checked. Everything that mattered has
    // already committed on both sides; a goodbye that does not arrive because
    // the other device walked out of range must not turn a completed sync into
    // a reported failure.
    let _ = wire::send(io, t, &Msg::Bye);
    Ok((applied, sent))
}

/// Turn the counts into the sentence the Household screen prints.
///
/// Never a bare tick. A sync that brought fourteen changes and is still holding
/// one helping says so, because a green line over a fridge that is missing a
/// pot is the same failure as a nutrient bar drawn at zero because nobody
/// measured it. Nothing here is a percentage, a proportion or a score: they are
/// counts of things, each with the noun it counts beside it.
pub fn detail(sent: usize, a: &store::Applied) -> String {
    let came = a.taken + a.released;
    let mut parts: Vec<String> = Vec::new();
    if sent > 0 {
        parts.push(format!(
            "{sent} change{} went over",
            if sent == 1 { "" } else { "s" }
        ));
    }
    if came > 0 {
        parts.push(format!(
            "{came} came back",
        ));
    }
    if parts.is_empty() {
        parts.push("Nothing to send; nothing came back".into());
    }
    let mut out = parts.join("; ");
    out.push('.');
    if a.still_held > 0 {
        out.push(' ');
        out.push_str(&if a.still_held == 1 {
            "One of them is still waiting for the pot or recipe it belongs to, so this is not \
             finished."
                .to_string()
        } else {
            format!(
                "{} of them are still waiting for the pots or recipes they belong to, so this \
                 is not finished.",
                a.still_held
            )
        });
    }
    out
}

/// What this device says about itself inside a handshake.
pub fn me(conn: &rusqlite::Connection, listen_port: u16) -> Result<Hello, String> {
    let d = store::this_device(conn)?;
    Ok(Hello {
        device_id: d.device_id,
        name: d.name,
        listen_port,
    })
}
