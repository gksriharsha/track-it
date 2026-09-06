//! Reading a pack on the device: text off a nutrition, supplement or
//! ingredients photo, and the digits out of a barcode.
//!
//! All this module does is turn image bytes into positioned lines of text, or
//! into decoded barcode payloads. It knows nothing about nutrients:
//! `trackit_core::panel`, `::suppanel`, `::ingredients` and `::barcode` do
//! that, and keeping the two apart is what lets every parser be tested without
//! a camera, a framework or an image.
//!
//! On macOS this is Apple's Vision framework and on Android it is Google ML
//! Kit. Both run entirely on the device — no photo leaves it. The platform
//! adapters stop at the same small boundary below; parsing a panel stays shared.

/// One line of text as the recognition engine returned it.
///
/// The box is normalised to the image — fractions in `0.0..=1.0` — with the
/// ORIGIN AT TOP-LEFT and `y` increasing downwards, which is the one
/// convention the parser downstream is written against.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(target_os = "android", derive(serde::Deserialize))]
pub struct Line {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// The engine's own confidence in this reading, 0.0 to 1.0. Carried
    /// through so a caller can weigh a shaky line, never so a value can be
    /// accepted without a person looking at it.
    pub confidence: f32,
}

/// Vision reports boxes with the ORIGIN AT BOTTOM-LEFT: `origin_y` is the
/// distance from the bottom of the image up to the bottom edge of the box. The
/// parser groups rows by y and sorts them downwards, so the top edge has to be
/// measured from the top instead.
///
/// Getting this backwards produces no error at all — every row still parses,
/// they just come out bottom-to-top, which silently pairs a nutrient name with
/// the wrong row's number. Hence its own function and its own tests, compiled
/// on every platform so they run wherever the suite does.
// Only the macOS binding calls this today, and the Android build should not
// warn about a helper that is waiting for its engine.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn top_left_y(origin_y: f64, height: f64) -> f64 {
    1.0 - (origin_y + height)
}

/// Assemble a `Line` from one observation's normalised bottom-left-origin box.
///
/// Coordinates are clamped into the unit square: Vision occasionally reports a
/// box a hair outside it, and a negative `y` would sort that line above every
/// real row rather than beside its neighbours.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn line_from_vision(text: String, confidence: f32, x: f64, origin_y: f64, w: f64, h: f64) -> Line {
    let h = h.clamp(0.0, 1.0);
    let w = w.clamp(0.0, 1.0);
    Line {
        text,
        x: x.clamp(0.0, 1.0),
        y: top_left_y(origin_y, h).clamp(0.0, 1.0),
        w,
        h,
        confidence,
    }
}

/// Recognise text in an encoded image (JPEG, PNG or WebP bytes).
///
/// `fast` selects the quick recognition level, which is what a live preview
/// frame wants: it is answering "is a panel in shot", not "what does it say".
/// The accurate level is several times slower and is for the photo the user
/// actually keeps.
#[cfg(target_os = "macos")]
pub fn recognize<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    image: &[u8],
    fast: bool,
) -> Result<Vec<Line>, String> {
    macos::recognize(image, fast)
}

/// Android's ML Kit adapter returns the same positioned lines as Apple Vision.
#[cfg(target_os = "android")]
pub fn recognize<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    image: &[u8],
    fast: bool,
) -> Result<Vec<Line>, String> {
    android::recognize(app, image, fast)
}

/// Platforms without a native on-device reader fail explicitly. An empty list
/// would falsely claim that a valid photo contained no text.
#[cfg(not(any(target_os = "macos", target_os = "android")))]
pub fn recognize<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    image: &[u8],
    fast: bool,
) -> Result<Vec<Line>, String> {
    recognize_unsupported(image, fast)
}

#[cfg(not(any(target_os = "macos", target_os = "android")))]
fn recognize_unsupported(_image: &[u8], _fast: bool) -> Result<Vec<Line>, String> {
    Err("reading a label on this device is not supported yet".into())
}

/// One barcode as the detector decoded it.
///
/// `payload` is the engine's own string for the code — for the numeric GS1
/// family that is the digits, check digit included. Whether those digits can be
/// believed is not decided here: `trackit_core::barcode::check` recomputes
/// the check digit, and it can only do that on an unedited payload. So nothing
/// in this module trims, pads or "corrects" what Vision handed back.
///
/// `symbology` names the engine's format. The Android adapter translates ML
/// Kit's integer constants to the same stable vocabulary the shared checksum
/// code accepts (for example `EAN-13`).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(target_os = "android", derive(serde::Deserialize))]
pub struct Barcode {
    pub payload: String,
    pub symbology: String,
    /// The detector's own confidence, 0.0 to 1.0. Vision reports 1.0 for
    /// symbologies where confidence has no meaning, so this weighs a reading —
    /// it never accepts one.
    pub confidence: f32,
}

/// Decode any barcodes in an encoded image (JPEG, PNG or WebP bytes).
///
/// An image with no barcode in it is `Ok(vec![])`, not an error: a photo of a
/// pack front legitimately carries no code. Only bytes that are not a readable
/// image, or a detector that fails outright, are errors.
#[cfg(target_os = "macos")]
pub fn detect_barcodes<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    image: &[u8],
) -> Result<Vec<Barcode>, String> {
    macos::detect_barcodes(image)
}

/// Decode barcodes through Android's on-device ML Kit model.
#[cfg(target_os = "android")]
pub fn detect_barcodes<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    image: &[u8],
) -> Result<Vec<Barcode>, String> {
    android::detect_barcodes(app, image)
}

#[cfg(not(any(target_os = "macos", target_os = "android")))]
pub fn detect_barcodes<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    image: &[u8],
) -> Result<Vec<Barcode>, String> {
    detect_barcodes_unsupported(image)
}

#[cfg(not(any(target_os = "macos", target_os = "android")))]
fn detect_barcodes_unsupported(_image: &[u8]) -> Result<Vec<Barcode>, String> {
    Err("reading a barcode on this device is not supported yet".into())
}

/// The Android half is a small Tauri mobile-plugin bridge. ML Kit and all of
/// its bytecode/models live in the Android Gradle source set; this Rust module
/// only serialises the already-validated image and receives the neutral types
/// above. Consequently an Apple build contains no ML Kit code, just as the
/// Android build contains none of the Objective-C Vision binding below.
#[cfg(target_os = "android")]
mod android {
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    use super::{Barcode, Line};

    const PLUGIN_IDENTIFIER: &str = "com.kgundu1.trackit";

    pub(super) struct AndroidVision<R: Runtime>(PluginHandle<R>);

    pub(super) fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("vision")
            .setup(|app, api| {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "VisionPlugin")?;
                app.manage(AndroidVision(handle));
                Ok(())
            })
            .build()
    }

    pub(super) fn recognize<R: Runtime>(
        app: &AppHandle<R>,
        image: &[u8],
        fast: bool,
    ) -> Result<Vec<Line>, String> {
        app.state::<AndroidVision<R>>()
            .0
            .run_mobile_plugin::<Vec<Line>>(
                "recognize",
                serde_json::json!({
                    "dataBase64": crate::b64_encode(image),
                    "fast": fast,
                }),
            )
            .map_err(|e| format!("the Android text reader failed on that photo: {e}"))
    }

    pub(super) fn detect_barcodes<R: Runtime>(
        app: &AppHandle<R>,
        image: &[u8],
    ) -> Result<Vec<Barcode>, String> {
        app.state::<AndroidVision<R>>()
            .0
            .run_mobile_plugin::<Vec<Barcode>>(
                "detectBarcodes",
                serde_json::json!({ "dataBase64": crate::b64_encode(image) }),
            )
            .map_err(|e| format!("the Android barcode reader failed on that photo: {e}"))
    }
}

#[cfg(target_os = "android")]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    android::init()
}

#[cfg(target_os = "macos")]
mod macos {
    use core::ffi::c_void;
    use core::ptr::NonNull;

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::AnyThread;
    use objc2_core_foundation::{CFData, CFNumber, CFNumberType};
    use objc2_foundation::{NSArray, NSDictionary, NSString};
    use objc2_image_io::{kCGImagePropertyOrientation, CGImagePropertyOrientation, CGImageSource};
    use objc2_vision::{
        VNDetectBarcodesRequest, VNImageOption, VNImageRequestHandler, VNRecognizeTextRequest,
        VNRequest, VNRequestTextRecognitionLevel,
    };

    use super::{line_from_vision, Barcode, Line};

    /// Vision's own floor on how tall a line must be, as a fraction of image
    /// height, before it is looked at. The default of 1/32 throws away most of
    /// a nutrition panel photographed with the whole pack in frame, where a
    /// row of small print is well under one percent of the picture. Lowering
    /// it costs time on the accurate pass, which is the pass that can afford
    /// it.
    const MIN_TEXT_HEIGHT_ACCURATE: f32 = 1.0 / 128.0;

    /// Decode encoded image bytes and build the Vision handler that every
    /// request in this module runs against.
    ///
    /// Text recognition and barcode detection differ only in the request they
    /// hand to `performRequests:`; the CGImageSource dance in front of it —
    /// sniff the container, refuse an empty or truncated file, read the EXIF
    /// orientation — is identical, and identical for a reason: a photo that
    /// reads sideways for one request reads sideways for the other. Two copies
    /// of it would drift, and the drift would show up as one scan finding a
    /// panel where the other finds nothing.
    ///
    /// Every failure here is a sentence about the file, never a panic. A panic
    /// unwinding across an objc frame aborts the process.
    fn image_handler(image: &[u8]) -> Result<Retained<VNImageRequestHandler>, String> {
        if image.is_empty() {
            return Err("there were no image bytes to read".into());
        }

        // SAFETY: `image` is a live slice for the whole call, and CFDataCreate
        // copies the bytes, so nothing outlives the borrow. The default
        // allocator is what `None` selects.
        let data = unsafe { CFData::new(None, image.as_ptr(), image.len() as isize) }
            .ok_or("that photo could not be held in memory to be read")?;

        // SAFETY: `data` holds a valid encoded image or it does not; ImageIO
        // sniffs the container itself and returns null for anything it cannot
        // open, which is the corrupt-input path. No options dictionary means
        // no generics to get wrong.
        let source = unsafe { CGImageSource::with_data(&data, None) }
            .ok_or("that file is not an image this device knows how to open")?;

        // SAFETY: `source` is a live CGImageSource.
        if unsafe { source.count() } == 0 {
            return Err("that image file holds no picture to read".into());
        }

        // SAFETY: index 0 exists — the count above is non-zero. A null return
        // means the bytes are truncated or damaged past decoding.
        let cg_image = unsafe { source.image_at_index(0, None) }
            .ok_or("that photo could not be decoded — it may be incomplete")?;

        let orientation = exif_orientation(&source);

        // Vision takes no options here; an empty dictionary is the documented
        // way to say so.
        let options: Retained<NSDictionary<VNImageOption, AnyObject>> = NSDictionary::new();

        // SAFETY: the image is alive for the duration of the handler, the
        // orientation came from ImageIO's own enum so it is one of the eight
        // legal values, and `options` is an NSDictionary of the declared key
        // and value types.
        Ok(unsafe {
            VNImageRequestHandler::initWithCGImage_orientation_options(
                VNImageRequestHandler::alloc(),
                &cg_image,
                orientation,
                &options,
            )
        })
    }

    /// Run one request against a prepared handler.
    ///
    /// `reader` names the thing that failed in the user's own words — "text
    /// reader", "barcode reader" — so the message says which scan gave up
    /// rather than blaming the photo in the abstract.
    fn perform(
        handler: &VNImageRequestHandler,
        request: &VNRequest,
        reader: &str,
    ) -> Result<(), String> {
        // performRequests: takes an array; one request is the whole array.
        let requests = NSArray::from_slice(&[request]);
        handler
            .performRequests_error(&requests)
            .map_err(|e| format!("the {reader} failed on that photo: {}", ns_error_text(&e)))
    }

    pub fn recognize(image: &[u8], fast: bool) -> Result<Vec<Line>, String> {
        let handler = image_handler(image)?;

        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(if fast {
            VNRequestTextRecognitionLevel::Fast
        } else {
            VNRequestTextRecognitionLevel::Accurate
        });
        // A nutrition panel is not prose. Language correction turns "0g" into a
        // word and "Potas." into "Potatoes", which is exactly the kind of
        // plausible wrong answer this app must never produce.
        request.setUsesLanguageCorrection(false);
        if !fast {
            request.setMinimumTextHeight(MIN_TEXT_HEIGHT_ACCURATE);
        }

        // Deref coercion walks VNRecognizeTextRequest -> VNImageBasedRequest ->
        // VNRequest, which is the element type performRequests: expects.
        perform(&handler, &request, "text reader")?;

        let observations = match request.results() {
            Some(o) => o,
            // No results at all is not a failure: an out-of-focus photo of a
            // table legitimately contains no text.
            None => return Ok(Vec::new()),
        };

        let mut lines = Vec::with_capacity(observations.count());
        for observation in observations.iter() {
            let candidates = observation.topCandidates(1);
            let Some(best) = candidates.iter().next() else {
                continue;
            };
            let text = best.string().to_string();
            if text.trim().is_empty() {
                continue;
            }
            // SAFETY: `observation` is a live VNRecognizedTextObservation;
            // boundingBox is a plain property read on it.
            let bbox = unsafe { observation.boundingBox() };
            lines.push(line_from_vision(
                text,
                best.confidence(),
                bbox.origin.x,
                bbox.origin.y,
                bbox.size.width,
                bbox.size.height,
            ));
        }
        Ok(lines)
    }

    pub fn detect_barcodes(image: &[u8]) -> Result<Vec<Barcode>, String> {
        let handler = image_handler(image)?;

        // SAFETY: +new on a Vision request class; no arguments to get wrong.
        // The symbology list is left at its default, which is every symbology
        // this OS knows. A grocery pack in India can carry EAN-13 while the
        // same product's export carton carries UPC-A, and a supplement bottle
        // sometimes prints a QR alongside — narrowing the list here would turn
        // an ordinary pack into "no barcode found".
        let request = unsafe { VNDetectBarcodesRequest::new() };

        // Deref coercion walks VNDetectBarcodesRequest -> VNImageBasedRequest
        // -> VNRequest, the element type performRequests: expects.
        perform(&handler, &request, "barcode reader")?;

        // SAFETY: `request` is live and has been performed, so reading its
        // results is a plain property read. None means the detector produced
        // nothing at all.
        let observations = match unsafe { request.results() } {
            Some(o) => o,
            // No barcode is not a failure: plenty of photos have none in them.
            None => return Ok(Vec::new()),
        };

        let mut found = Vec::with_capacity(observations.count());
        for observation in observations.iter() {
            // SAFETY: `observation` is a live VNBarcodeObservation. Vision
            // documents payloadStringValue as nullable — a damaged code, or one
            // whose payload is binary, has no string form. Skipping those is
            // the only correct move: there is no partial payload worth showing,
            // and unwrapping here would abort the process on a bad photo.
            let Some(payload) = (unsafe { observation.payloadStringValue() }) else {
                continue;
            };
            let payload = payload.to_string();
            if payload.trim().is_empty() {
                continue;
            }

            // SAFETY: both are property reads on the same live observation.
            // `symbology` is a framework NSString constant and is never null.
            let symbology = unsafe { observation.symbology() }.to_string();
            let confidence = unsafe { observation.confidence() };

            found.push(Barcode {
                payload,
                symbology,
                confidence,
            });
        }
        Ok(found)
    }

    /// The EXIF orientation ImageIO found on image 0, or `Up` when the file
    /// does not say.
    ///
    /// A photo taken in portrait on a phone is stored landscape with a tag
    /// saying which way is up. Vision will still read sideways text, but it
    /// reports every box in the unrotated frame, so the rows come out stacked
    /// along the wrong axis and the parser can no longer tell which number
    /// belongs to which nutrient. Measured on a 90°-rotated copy of the fig
    /// bar panel: with the tag honoured the boxes match the upright image;
    /// without it every line lands at x ≈ 0.98 on almost the same y.
    fn exif_orientation(source: &CGImageSource) -> CGImagePropertyOrientation {
        // SAFETY: `source` is live and no options dictionary is passed, so
        // there are no generics to mismatch.
        let Some(properties) = (unsafe { source.properties_at_index(0, None) }) else {
            return CGImagePropertyOrientation::Up;
        };

        // SAFETY: kCGImagePropertyOrientation is a framework constant CFString
        // and `properties` is a live CFDictionary; CFDictionaryGetValue returns
        // null for an absent key, which is the untagged case.
        let value = unsafe {
            properties
                .as_opaque()
                .value(kCGImagePropertyOrientation as *const _ as *const c_void)
        };
        let Some(value) = NonNull::new(value.cast_mut()) else {
            return CGImagePropertyOrientation::Up;
        };

        // ImageIO documents this key as a CFNumber. Reading it as one and
        // ignoring anything else is safer than trusting the cast blindly.
        let mut raw: i32 = 0;
        // SAFETY: the value is a CFNumber per ImageIO's contract, it is owned
        // by the dictionary which outlives this borrow, and `raw` is a live
        // i32 matching the IntType we ask for.
        let read = unsafe {
            let number: &CFNumber = value.cast().as_ref();
            number.value(
                CFNumberType::IntType,
                std::ptr::from_mut(&mut raw).cast::<c_void>(),
            )
        };
        if !read {
            return CGImagePropertyOrientation::Up;
        }

        // Only the eight values EXIF defines are legal; anything else means the
        // file is lying and upright is the honest fallback.
        match raw {
            1 => CGImagePropertyOrientation::Up,
            2 => CGImagePropertyOrientation::UpMirrored,
            3 => CGImagePropertyOrientation::Down,
            4 => CGImagePropertyOrientation::DownMirrored,
            5 => CGImagePropertyOrientation::LeftMirrored,
            6 => CGImagePropertyOrientation::Right,
            7 => CGImagePropertyOrientation::RightMirrored,
            8 => CGImagePropertyOrientation::Left,
            _ => CGImagePropertyOrientation::Up,
        }
    }

    /// An NSError's own description, so the message the user sees names what
    /// Vision actually objected to.
    fn ns_error_text(error: &objc2_foundation::NSError) -> String {
        let description: Retained<NSString> = error.localizedDescription();
        description.to_string()
    }

    /// Nothing here is reachable without a live framework, so the only thing
    /// worth asserting in a unit test is that the module builds against the
    /// API it thinks it has, plus the handful of decisions that are pure.
    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn empty_bytes_are_an_error_not_an_empty_reading() {
            // The distinction matters: an empty reading would be shown as "this
            // pack prints nothing", which is a claim about the food.
            assert!(recognize(&[], false).is_err());
        }

        #[test]
        fn junk_bytes_are_an_error_and_do_not_panic() {
            let junk = vec![0x00u8, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07];
            assert!(recognize(&junk, true).is_err());
        }

        #[test]
        fn a_truncated_jpeg_is_an_error() {
            // A JPEG magic number and nothing behind it: ImageIO opens the
            // container and then finds no image in it.
            let truncated = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46];
            assert!(recognize(&truncated, false).is_err());
        }

        #[test]
        fn a_real_image_with_no_text_reads_as_no_lines() {
            let png = super::super::tests::flat_png();
            assert_eq!(recognize(&png, true), Ok(Vec::new()));
        }

        #[test]
        fn barcodes_from_empty_bytes_are_an_error_not_an_empty_list() {
            // An empty list means "this pack carries no barcode". Nothing was
            // read, so nothing can be said about the pack.
            assert!(detect_barcodes(&[]).is_err());
        }

        #[test]
        fn barcodes_from_junk_bytes_are_an_error_and_do_not_panic() {
            let junk = vec![0x00u8, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07];
            assert!(detect_barcodes(&junk).is_err());
        }

        #[test]
        fn barcodes_from_a_truncated_jpeg_are_an_error() {
            let truncated = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46];
            assert!(detect_barcodes(&truncated).is_err());
        }

        #[test]
        fn a_real_image_with_no_barcode_reads_as_no_barcodes() {
            let png = super::super::tests::flat_png();
            assert_eq!(detect_barcodes(&png), Ok(Vec::new()));
        }

        #[test]
        fn a_printed_ean13_comes_back_as_its_own_digits() {
            // The one test that proves the binding does its job rather than
            // merely compiling. 4006381333931 is a valid EAN-13; the leading 4
            // is not drawn as bars at all, it is carried by the parity of the
            // left-hand six, so getting it back proves Vision decoded the
            // symbol rather than something that merely looks like one.
            let png = super::super::tests::ean13_png("4006381333931");
            let found = detect_barcodes(&png).expect("a clean synthetic barcode should decode");
            assert_eq!(found.len(), 1, "one symbol was printed, {found:?}");
            assert_eq!(found[0].payload, "4006381333931");
            // The core parser matches on this string to decide whether the code
            // even has a check digit to verify, so its exact spelling matters.
            assert_eq!(found[0].symbology, "VNBarcodeSymbologyEAN13");
            assert!(found[0].confidence > 0.0);
        }

        #[test]
        fn both_readers_reject_the_same_bad_file() {
            // The shared decode path is the whole point of factoring it: a file
            // one scan refuses must not be a file the other silently accepts.
            let truncated = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
            assert!(recognize(&truncated, false).is_err());
            assert!(detect_barcodes(&truncated).is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An 8-bit greyscale PNG of `rows`, written out by hand so the tests need
    /// no fixture file and no encoder dependency. One byte per pixel, one
    /// `Vec` per row.
    #[cfg(target_os = "macos")]
    fn grey_png(rows: &[Vec<u8>]) -> Vec<u8> {
        fn crc32(bytes: &[u8]) -> u32 {
            let mut crc: u32 = 0xFFFF_FFFF;
            for &b in bytes {
                crc ^= b as u32;
                for _ in 0..8 {
                    crc = if crc & 1 != 0 {
                        (crc >> 1) ^ 0xEDB8_8320
                    } else {
                        crc >> 1
                    };
                }
            }
            !crc
        }
        fn adler32(bytes: &[u8]) -> u32 {
            let (mut a, mut b) = (1u32, 0u32);
            for &byte in bytes {
                a = (a + byte as u32) % 65521;
                b = (b + a) % 65521;
            }
            (b << 16) | a
        }
        fn chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
            let mut out = Vec::new();
            out.extend_from_slice(&(body.len() as u32).to_be_bytes());
            out.extend_from_slice(kind);
            out.extend_from_slice(body);
            let mut crc_input = kind.to_vec();
            crc_input.extend_from_slice(body);
            out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
            out
        }

        let h = rows.len() as u32;
        let w = rows.first().map(|r| r.len()).unwrap_or(0) as u32;
        // 8-bit greyscale, no interlace.
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 0, 0, 0, 0]);

        // One filter byte plus one row of pixels, per row.
        let mut raw = Vec::new();
        for row in rows {
            raw.push(0u8);
            raw.extend_from_slice(row);
        }
        // A zlib stream of stored (uncompressed) deflate blocks, which needs no
        // compressor.
        let mut zlib = vec![0x78, 0x01];
        for (i, block) in raw.chunks(65535).enumerate() {
            let last = (i + 1) * 65535 >= raw.len();
            zlib.push(if last { 1 } else { 0 });
            zlib.extend_from_slice(&(block.len() as u16).to_le_bytes());
            zlib.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
            zlib.extend_from_slice(block);
        }
        zlib.extend_from_slice(&adler32(&raw).to_be_bytes());

        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend(chunk(b"IHDR", &ihdr));
        png.extend(chunk(b"IDAT", &zlib));
        png.extend(chunk(b"IEND", &[]));
        png
    }

    /// A 16x16 mid-grey PNG: a decodable image with nothing printed on it.
    /// Proves an empty reading is reported as "found nothing", not as an error.
    #[cfg(target_os = "macos")]
    pub(super) fn flat_png() -> Vec<u8> {
        grey_png(&vec![vec![0x80u8; 16]; 16])
    }

    /// The 95 black/white modules of an EAN-13 symbol, encoded from the digits
    /// rather than typed out as a bit string.
    ///
    /// EAN-13 hides its first digit: only twelve digits are drawn, and the
    /// thirteenth is carried by which parity table each of the left-hand six
    /// uses. Deriving that here is what makes the test a real end-to-end check
    /// — if Vision hands back the wrong leading digit, the assertion fails.
    #[cfg(target_os = "macos")]
    fn ean13_modules(digits: &str) -> Vec<bool> {
        const LEFT_ODD: [&str; 10] = [
            "0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011",
            "0110111", "0001011",
        ];
        const LEFT_EVEN: [&str; 10] = [
            "0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001",
            "0001001", "0010111",
        ];
        const RIGHT: [&str; 10] = [
            "1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100",
            "1001000", "1110100",
        ];
        // Which of the left six use the even table, per leading digit.
        const PARITY: [&str; 10] = [
            "LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG",
            "LGLGGL", "LGGLGL",
        ];

        let d: Vec<usize> = digits.bytes().map(|b| (b - b'0') as usize).collect();
        assert_eq!(d.len(), 13, "EAN-13 needs thirteen digits");

        let mut bits = String::from("101"); // start guard
        for (i, parity) in PARITY[d[0]].chars().enumerate() {
            bits.push_str(if parity == 'L' {
                LEFT_ODD[d[1 + i]]
            } else {
                LEFT_EVEN[d[1 + i]]
            });
        }
        bits.push_str("01010"); // centre guard
        for digit in &d[7..13] {
            bits.push_str(RIGHT[*digit]);
        }
        bits.push_str("101"); // end guard
        bits.chars().map(|c| c == '1').collect()
    }

    /// A PNG of a printed EAN-13 barcode, quiet zones included.
    ///
    /// The quiet zones are not decoration: a scanner that cannot see clear
    /// white either side of the guard bars reads nothing at all, which is
    /// exactly the failure a bare module strip would produce.
    #[cfg(target_os = "macos")]
    pub(super) fn ean13_png(digits: &str) -> Vec<u8> {
        const MODULE_PX: usize = 4;
        const QUIET_MODULES: usize = 12;
        const BAR_HEIGHT_PX: usize = 160;
        const MARGIN_PX: usize = 20;

        let modules = ean13_modules(digits);
        let mut row = vec![0xFFu8; QUIET_MODULES * MODULE_PX];
        for module in &modules {
            let ink = if *module { 0x00u8 } else { 0xFF };
            row.extend(std::iter::repeat_n(ink, MODULE_PX));
        }
        row.extend(std::iter::repeat_n(0xFFu8, QUIET_MODULES * MODULE_PX));

        let blank = vec![0xFFu8; row.len()];
        let mut rows = vec![blank.clone(); MARGIN_PX];
        rows.extend(std::iter::repeat_n(row, BAR_HEIGHT_PX));
        rows.extend(std::iter::repeat_n(blank, MARGIN_PX));
        grey_png(&rows)
    }

    #[test]
    fn the_top_of_the_image_becomes_a_small_y() {
        // Vision: a box whose bottom edge sits 0.9 up the image and is 0.05
        // tall reaches 0.95, so its top edge is 0.05 down from the top.
        assert!((top_left_y(0.9, 0.05) - 0.05).abs() < 1e-12);
    }

    #[test]
    fn the_bottom_of_the_image_becomes_a_large_y() {
        assert!((top_left_y(0.02, 0.05) - 0.93).abs() < 1e-12);
    }

    #[test]
    fn a_full_height_box_starts_at_zero() {
        assert!((top_left_y(0.0, 1.0)).abs() < 1e-12);
    }

    #[test]
    fn the_flip_is_its_own_inverse() {
        // Applying it twice returns the bottom-left origin, which is what makes
        // it a flip rather than an offset.
        let (origin_y, h) = (0.31, 0.07);
        let flipped = top_left_y(origin_y, h);
        assert!((top_left_y(flipped, h) - origin_y).abs() < 1e-12);
    }

    #[test]
    fn rows_sort_top_to_bottom_after_the_flip() {
        // The failure this guards against: the panel parses fine but upside
        // down, so "Total Fat" is paired with the number from the row below it.
        // In Vision's frame the FIRST line of the panel has the LARGEST
        // origin_y.
        let vision_order = [
            ("Nutrition Facts", 0.90),
            ("Serving Size 1 package (57g)", 0.80),
            ("Calories 200", 0.70),
            ("Total Fat 5g 6%", 0.60),
        ];
        let mut lines: Vec<Line> = vision_order
            .iter()
            .map(|(text, origin_y)| {
                line_from_vision((*text).to_string(), 0.9, 0.1, *origin_y, 0.5, 0.04)
            })
            .collect();
        lines.reverse(); // whatever order the engine hands them back in
        lines.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap());

        let read: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(
            read,
            [
                "Nutrition Facts",
                "Serving Size 1 package (57g)",
                "Calories 200",
                "Total Fat 5g 6%",
            ]
        );
    }

    #[test]
    fn two_nutrients_on_one_row_keep_the_same_y() {
        // "Vit. D 0.6mcg 4% • Iron 0.9mg 6%" arrives as two blocks at the same
        // height. The flip must not separate them, or the row grouping that
        // reassembles them cannot work.
        let left = line_from_vision("Vit. D 0.6mcg 4%".into(), 0.9, 0.08, 0.42, 0.35, 0.03);
        let right = line_from_vision("Iron 0.9mg 6%".into(), 0.9, 0.55, 0.42, 0.30, 0.03);
        assert!((left.y - right.y).abs() < 1e-12);
        assert!(left.x < right.x);
    }

    #[test]
    fn a_box_reported_outside_the_image_is_pulled_back_inside() {
        // Vision can overshoot by a fraction on a rotated frame. A negative y
        // would sort that line above every real row.
        let line = line_from_vision("Calories".into(), 0.5, -0.02, 0.99, 0.4, 0.05);
        assert!(line.x >= 0.0);
        assert!(line.y >= 0.0);
        assert!(line.y <= 1.0);
    }

    #[test]
    fn text_and_confidence_survive_the_conversion() {
        let line = line_from_vision(
            "Includes 14g Added Sugars".into(),
            0.42,
            0.1,
            0.5,
            0.6,
            0.03,
        );
        assert_eq!(line.text, "Includes 14g Added Sugars");
        assert!((line.confidence - 0.42).abs() < 1e-6);
        assert!((line.w - 0.6).abs() < 1e-12);
        assert!((line.h - 0.03).abs() < 1e-12);
    }

    #[cfg(not(any(target_os = "macos", target_os = "android")))]
    #[test]
    fn platforms_without_an_engine_say_so_rather_than_reading_nothing() {
        assert!(recognize_unsupported(&[1, 2, 3], false).is_err());
    }

    #[cfg(not(any(target_os = "macos", target_os = "android")))]
    #[test]
    fn platforms_without_a_detector_say_so_rather_than_finding_no_barcode() {
        assert!(detect_barcodes_unsupported(&[1, 2, 3]).is_err());
    }
}
