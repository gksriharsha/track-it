//! The pairing payload as a QR code.
//!
//! Drawn in Rust, beside the key material, rather than in the webview. The
//! payload is bound into the Noise prologue on both sides as EXACT bytes, so
//! assembling it twice in two languages is one whitespace difference away from
//! a handshake that fails for no visible reason.

use qrcodegen::{QrCode, QrCodeEcc};

/// Modules of clear space around the code.
///
/// Four is what the specification asks for, and a code without it does not
/// scan — the decoder has nothing to find the finder patterns against. It is
/// inside the SVG rather than being CSS padding so that the frame on the screen
/// can be exactly the size the box already reserves.
const QUIET: i32 = 4;

/// The payload as an SVG string, ready to drop into the page.
///
/// Medium error correction: enough to survive a phone camera at an angle in a
/// kitchen, without the extra modules that Quartile would add to a payload
/// already carrying a 32-byte key.
pub fn svg(payload: &str) -> Result<String, String> {
    let code = QrCode::encode_text(payload, QrCodeEcc::Medium)
        .map_err(|e| format!("drawing the pairing code: {e}"))?;
    let size = code.size();
    let span = size + QUIET * 2;

    // One path of one-module squares rather than a rect per module. A 45-module
    // code is two thousand modules; two thousand elements is a document the
    // webview lays out, and one path is a document it draws.
    let mut d = String::new();
    for y in 0..size {
        for x in 0..size {
            if code.get_module(x, y) {
                d.push_str(&format!("M{},{}h1v1h-1z", x + QUIET, y + QUIET));
            }
        }
    }

    Ok(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {span} {span}\" \
         shape-rendering=\"crispEdges\" role=\"img\" aria-label=\"Pairing code\">\
         <rect width=\"{span}\" height=\"{span}\" fill=\"#fff\"/>\
         <path d=\"{d}\" fill=\"#000\"/></svg>"
    ))
}

/// How many modules on a side the code for this payload takes, quiet zone
/// included.
///
/// For the tests and for nothing else, which is why it is compiled only for
/// them: the assertion it serves is that the payload stays under the length at
/// which the code gets too dense for a phone camera to read, and that assertion
/// has to be a test rather than a comment.
#[cfg(test)]
pub fn span(payload: &str) -> Result<i32, String> {
    let code = QrCode::encode_text(payload, QrCodeEcc::Medium)
        .map_err(|e| format!("drawing the pairing code: {e}"))?;
    Ok(code.size() + QUIET * 2)
}
