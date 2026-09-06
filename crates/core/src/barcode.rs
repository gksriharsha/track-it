//! Deciding whether a decoded barcode may be believed.
//!
//! A barcode scanner does not read digits the way a person does — it reads bar
//! widths, and a crease, a glare or a curved bottle can turn one digit into
//! another while the decode still "succeeds". The GS1 numeric codes are built
//! for exactly that: their last digit is a modulo-10 checksum over the others,
//! so a single substituted digit almost always fails to compute.
//!
//! Checking it is the whole of this module. A code whose check digit does not
//! compute is a misread, and storing a misread barcode is the same class of
//! error as storing a misread nutrient figure — it looks like data, it is
//! wrong, and nothing downstream can tell. So a failed check is reported as a
//! failure rather than quietly kept, and even a code that passes is a
//! suggestion the user confirms.
//!
//! Symbologies outside that family — Code 128, QR, Data Matrix — carry no digit
//! this app can verify. They are passed through as read, with a note saying
//! plainly that nothing was checked, rather than being dressed up as verified.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Checked {
    /// The digits as decoded, whitespace removed. Empty when nothing came back.
    pub payload: String,
    /// The symbology in the spelling a person reads: "EAN-13", "Code 128".
    pub symbology: String,
    /// Whether this code may be offered as something worth storing.
    ///
    /// True for a GS1 code whose check digit computes, and ALSO for a symbology
    /// that carries no check digit — nothing contradicts those digits because
    /// nothing could test them. Read alone it does not say which happened, so
    /// anything wording an assurance to the user reads `verified`.
    pub trusted: bool,
    /// Whether a check digit was actually computed and matched.
    ///
    /// This is the only field that says arithmetic ran. A Code 128 or a QR is
    /// `trusted` and NOT `verified`: it was passed through as read. Splitting
    /// the two is what keeps a screen from telling the user a checksum added up
    /// on a code that has none.
    pub verified: bool,
    /// Why, in a sentence, whenever there is anything to say — a failed check,
    /// or a symbology that has nothing to check.
    pub note: Option<String>,
}

/// The GS1 numeric codes, with the digit count each must have.
///
/// UPC-E is here at its 8-digit length: it is a UPC-A with runs of zeroes
/// squeezed out, and its check digit is the one from the UPC-A it expands to,
/// so it cannot be summed where it stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gs1 {
    Ean13,
    Ean8,
    UpcA,
    UpcE,
}

impl Gs1 {
    fn digits(self) -> usize {
        match self {
            Gs1::Ean13 => 13,
            Gs1::Ean8 => 8,
            Gs1::UpcA => 12,
            Gs1::UpcE => 8,
        }
    }
}

/// Check a decoded payload against its symbology.
///
/// `symbology` is taken in whatever spelling the recogniser used — Apple Vision
/// returns "VNBarcodeSymbologyEAN13" — so the binding never has to translate.
pub fn check(payload: &str, symbology: &str) -> Checked {
    // Interior whitespace too: a decoder that is unsure of a quiet zone can
    // emit a gap, and a space is never part of a numeric code.
    let payload: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
    let name = display_name(symbology);

    if payload.is_empty() {
        return Checked {
            payload,
            symbology: name,
            trusted: false,
            verified: false,
            note: Some(
                "No barcode was read from this frame. Fill the frame with the code, hold the \
                 camera steady, and keep the bars flat rather than curved around the pack."
                    .into(),
            ),
        };
    }

    let Some(family) = gs1_family(symbology) else {
        return Checked {
            payload,
            symbology: name.clone(),
            trusted: true,
            verified: false,
            note: Some(format!(
                "This is a {name} code. Only EAN-13, EAN-8, UPC-A and UPC-E carry a check \
                 digit this app can verify, so these digits are passed through exactly as \
                 they were read — compare them with the pack before you rely on them."
            )),
        };
    };

    if !payload.chars().all(|c| c.is_ascii_digit()) {
        return Checked {
            symbology: name.clone(),
            trusted: false,
            verified: false,
            note: Some(format!(
                "A {name} code is all digits, and this decode came back as \"{payload}\". That \
                 is a misread rather than a code — retake the photo."
            )),
            payload,
        };
    }

    let want = family.digits();
    if payload.len() != want {
        let got = payload.len();
        return Checked {
            symbology: name.clone(),
            trusted: false,
            verified: false,
            note: Some(format!(
                "A {name} code has {want} digits and this one has {got}, so the check digit \
                 cannot be computed. Retake the photo with the whole code in the frame."
            )),
            payload,
        };
    }

    let digits: Vec<u32> = payload.chars().map(|c| c as u32 - '0' as u32).collect();
    let full = match family {
        // Expanded first: the checksum belongs to the twelve digits UPC-E
        // stands for, not to the eight it prints.
        Gs1::UpcE => match expand_upc_e(&digits) {
            Some(v) => v,
            None => {
                return Checked {
                    symbology: name,
                    trusted: false,
                    verified: false,
                    note: Some(
                        "A UPC-E code begins with 0 or 1. This one does not, so it cannot be \
                         expanded and checked — retake the photo."
                            .into(),
                    ),
                    payload,
                }
            }
        },
        _ => digits,
    };

    if mod10_ok(&full) {
        Checked {
            payload,
            symbology: name,
            trusted: true,
            verified: true,
            note: None,
        }
    } else {
        Checked {
            symbology: name.clone(),
            trusted: false,
            verified: false,
            note: Some(format!(
                "These digits do not add up: a {name} code's last digit is a checksum over the \
                 others, and this one does not match. One digit was almost certainly misread, \
                 so it is not offered as the product's code. Retake the photo, or type the \
                 number in from the pack."
            )),
            payload,
        }
    }
}

/// The GS1 modulo-10 checksum, over a code whose LAST digit is the check digit.
///
/// Weights alternate 3 and 1 from the right, so the rightmost data digit is
/// weighted 3. That single rule covers EAN-13, EAN-8 and UPC-A alike; only the
/// length differs.
fn mod10_ok(code: &[u32]) -> bool {
    let Some((check, data)) = code.split_last() else {
        return false;
    };
    let sum: u32 = data
        .iter()
        .rev()
        .enumerate()
        .map(|(i, d)| d * if i % 2 == 0 { 3 } else { 1 })
        .sum();
    (10 - sum % 10) % 10 == *check
}

/// The UPC-A a 8-digit UPC-E stands for.
///
/// The sixth data digit says where the squeezed-out zeroes went; GS1 General
/// Specifications, "Zero-suppressed" UPC-E. Reconstructing it is the only way
/// to reach a checksum, because the check digit printed on a UPC-E is the
/// UPC-A's.
fn expand_upc_e(d: &[u32]) -> Option<Vec<u32>> {
    if d.len() != 8 {
        return None;
    }
    let system = d[0];
    if system > 1 {
        return None;
    }
    let (x, check) = (&d[1..7], d[7]);
    let mut out = vec![system];
    match x[5] {
        0..=2 => {
            out.extend_from_slice(&[x[0], x[1], x[5], 0, 0, 0, 0, x[2], x[3], x[4]]);
        }
        3 => {
            out.extend_from_slice(&[x[0], x[1], x[2], 0, 0, 0, 0, 0, x[3], x[4]]);
        }
        4 => {
            out.extend_from_slice(&[x[0], x[1], x[2], x[3], 0, 0, 0, 0, 0, x[4]]);
        }
        _ => {
            out.extend_from_slice(&[x[0], x[1], x[2], x[3], x[4], 0, 0, 0, 0, x[5]]);
        }
    }
    out.push(check);
    Some(out)
}

/// A symbology reduced to letters and digits, so "VNBarcodeSymbologyEAN13",
/// "EAN-13" and "ean_13" all land on the same key.
fn slug(symbology: &str) -> String {
    let s: String = symbology
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect();
    s.strip_prefix("vnbarcodesymbology")
        .map(str::to_string)
        .unwrap_or(s)
}

fn gs1_family(symbology: &str) -> Option<Gs1> {
    match slug(symbology).as_str() {
        "ean13" => Some(Gs1::Ean13),
        "ean8" => Some(Gs1::Ean8),
        "upca" => Some(Gs1::UpcA),
        "upce" => Some(Gs1::UpcE),
        _ => None,
    }
}

/// How the symbology is spelled to a person. An unrecognised one keeps its own
/// text rather than becoming "unknown": naming what the recogniser said is more
/// use than hiding it.
fn display_name(symbology: &str) -> String {
    match slug(symbology).as_str() {
        "ean13" => "EAN-13",
        "ean8" => "EAN-8",
        "upca" => "UPC-A",
        "upce" => "UPC-E",
        "code128" => "Code 128",
        "code39" | "code39checksum" | "code39fullascii" | "code39fullasciichecksum" => "Code 39",
        "code93" | "code93i" => "Code 93",
        "qr" => "QR",
        "aztec" => "Aztec",
        "datamatrix" => "Data Matrix",
        "pdf417" => "PDF417",
        "itf14" => "ITF-14",
        "i2of5" | "i2of5checksum" => "Interleaved 2 of 5",
        "codabar" => "Codabar",
        "gs1databar" => "GS1 DataBar",
        "" => "barcode",
        _ => {
            // Vision's own prefix stripped, but the rest left alone.
            let bare = symbology
                .trim()
                .strip_prefix("VNBarcodeSymbology")
                .unwrap_or(symbology.trim());
            return bare.to_string();
        }
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_real_ean13_verifies() {
        // 5449000000996 — Coca-Cola 330 ml, a GS1 example code.
        let c = check("5449000000996", "VNBarcodeSymbologyEAN13");
        assert!(c.trusted, "{:?}", c.note);
        assert_eq!(c.payload, "5449000000996");
        assert_eq!(c.symbology, "EAN-13");
        assert!(c.verified, "the check digit was computed and it matched");
        assert_eq!(c.note, None, "a code that verifies needs no explanation");
    }

    #[test]
    fn one_wrong_digit_is_refused_rather_than_stored() {
        // The same code with its last digit changed: the exact failure the
        // check digit exists to catch.
        let c = check("5449000000997", "VNBarcodeSymbologyEAN13");
        assert!(!c.trusted);
        assert!(!c.verified, "the checksum ran and did not match");
        assert_eq!(
            c.payload, "5449000000997",
            "the digits are still reported so the user can see what was read"
        );
        let note = c.note.expect("a failed check has to say so");
        assert!(
            note.contains("checksum"),
            "the sentence should say what failed: {note}"
        );
    }

    #[test]
    fn a_substituted_interior_digit_is_caught_too() {
        // Not just the last digit: a crease in the middle of the code.
        let c = check("5449000010996", "EAN-13");
        assert!(!c.trusted, "an interior misread must not verify");
    }

    #[test]
    fn a_valid_upc_a_verifies() {
        // 036000291452 — the GS1 textbook UPC-A.
        let c = check("036000291452", "VNBarcodeSymbologyUPCA");
        assert!(c.trusted, "{:?}", c.note);
        assert_eq!(c.symbology, "UPC-A");
    }

    #[test]
    fn a_valid_ean8_verifies() {
        let c = check("96385074", "VNBarcodeSymbologyEAN8");
        assert!(c.trusted, "{:?}", c.note);
        assert_eq!(c.symbology, "EAN-8");
    }

    #[test]
    fn a_upc_e_is_expanded_before_its_check_digit_is_summed() {
        // 04252614 expands to UPC-A 042100005264, whose check digit is 4.
        // Summing the eight printed digits where they stand would reject it.
        let c = check("04252614", "VNBarcodeSymbologyUPCE");
        assert!(c.trusted, "{:?}", c.note);
        assert_eq!(c.symbology, "UPC-E");

        let bad = check("04252615", "VNBarcodeSymbologyUPCE");
        assert!(!bad.trusted, "a UPC-E with a wrong check digit must fail");
    }

    #[test]
    fn a_code128_payload_is_passed_through_and_says_it_was_not_checked() {
        let c = check("ABC-1234-XY", "VNBarcodeSymbologyCode128");
        assert!(c.trusted, "there is nothing to fail, so nothing is refused");
        assert!(
            !c.verified,
            "trusted here means only that nothing could be tested"
        );
        assert_eq!(c.payload, "ABC-1234-XY");
        assert_eq!(c.symbology, "Code 128");
        let note = c.note.expect("a symbology with no check digit must say so");
        assert!(
            note.contains("Code 128"),
            "the note names the symbology: {note}"
        );
        assert!(
            note.contains("verify"),
            "and says plainly that nothing was verified: {note}"
        );
    }

    #[test]
    fn an_empty_payload_is_never_trusted() {
        let c = check("", "VNBarcodeSymbologyEAN13");
        assert!(!c.trusted);
        assert_eq!(c.payload, "");
        assert!(c.note.is_some(), "an empty result has to explain itself");
    }

    #[test]
    fn whitespace_around_and_inside_the_digits_is_removed() {
        let c = check("  544 9000 000996 \n", "VNBarcodeSymbologyEAN13");
        assert_eq!(c.payload, "5449000000996");
        assert!(c.trusted);
    }

    #[test]
    fn a_numeric_symbology_with_letters_in_it_is_a_misread() {
        let c = check("54490000O0996", "VNBarcodeSymbologyEAN13");
        assert!(!c.trusted, "a letter O is not a zero");
        assert!(c.note.unwrap().contains("digits"));
    }

    #[test]
    fn a_short_ean13_is_refused_rather_than_padded() {
        let c = check("544900000099", "VNBarcodeSymbologyEAN13");
        assert!(!c.trusted);
        let note = c.note.expect("a length failure has to say so");
        assert!(note.contains("13 digits"), "{note}");
    }

    #[test]
    fn an_unrecognised_symbology_keeps_its_own_name() {
        let c = check("payload", "VNBarcodeSymbologyMicroQR");
        assert_eq!(c.symbology, "MicroQR");
        assert!(c.trusted);
    }
}
