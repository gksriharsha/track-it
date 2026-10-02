import { useHashSheet } from "./hashSheet";
import { scanBarcode } from "../api";
import type { BarcodeScan } from "../types";

/**
 * The pieces every camera surface in this app needs, in one place.
 *
 * There used to be four copies of some of this — `CAN_STREAM` in three files,
 * `bare` in two, and `shrink` privately inside `PhotoSlot` — which is how the
 * barcode sheet ended up without the file fallback the panel slots have had all
 * along.
 */

/** The longest edge a photo keeps, and the quality it keeps it at. */
const MAX_EDGE = 1600;
const QUALITY = 0.82;

/**
 * Whether this device can hand a live stream to the page.
 *
 * A FUNCTION, not a module-level constant. It used to be evaluated once at
 * import, which meant a WebView that gained `getUserMedia` after the bundle
 * loaded — a permission granted mid-session, a page restored from bfcache —
 * kept every camera control hidden until a reload. Asking at click time costs
 * nothing and cannot go stale.
 */
export function canStream(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

/** The camera hands over bare base64; a data URL is stripped in case it ever does not. */
export const bare = (s: string) => (s.startsWith("data:") ? s.slice(s.indexOf(",") + 1) : s);

/**
 * Shrink to `maxEdge` and re-encode as JPEG, returning bare base64.
 *
 * Drawing through an `<img>` rather than the raw bytes is deliberate: it applies
 * the EXIF orientation a phone writes, so a panel photographed in portrait is
 * read the way it was seen rather than on its side.
 *
 * `revoke` releases an object URL once decoded; a data URL has nothing to release.
 */
export function shrinkToBase64(
  src: string,
  revoke: boolean,
  maxEdge = MAX_EDGE,
  quality = QUALITY,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const done = () => {
      if (revoke) URL.revokeObjectURL(src);
    };
    img.onload = () => {
      done();
      try {
        const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("This device cannot process the image.");
        // Not a UI colour, so not a token: it is the paper behind a transparent
        // PNG. Left unpainted, transparency composites to black in JPEG and a
        // pale pack comes back unreadable.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const url64 = canvas.toDataURL("image/jpeg", quality);
        const comma = url64.indexOf(",");
        if (!url64.startsWith("data:image/jpeg") || comma < 0) {
          throw new Error("This device could not re-encode the photo.");
        }
        resolve(url64.slice(comma + 1));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => {
      done();
      reject(new Error("That image could not be read. JPEG, PNG and WebP work."));
    };
    img.src = src;
  });
}

/**
 * Read a barcode off a photo the user already has, rather than off the lens.
 *
 * This was missing, and its absence was not a backend limitation: `scan_barcode`
 * takes the same `decode_photo` gate every stored photo does — any JPEG, PNG or
 * WebP up to 6 MB — and never cared whether the bytes came from a live frame.
 * Only the UI insisted on a lens, so on a phone with the camera permission
 * denied the barcode field could only be typed, while the camera sheet's own
 * apology told the user to "pick a photo you already have".
 *
 * Shrunk first, and that is what makes it work rather than a nicety: a modern
 * phone's photo is 3–8 MB and the 6 MB gate would refuse it outright.
 */
export async function readBarcodeFromFile(f: File): Promise<BarcodeScan> {
  const url = URL.createObjectURL(f);
  // A barcode is fine strokes, so it keeps more quality than a pack photo: the
  // decoder needs the edges the panel OCR can afford to lose.
  const b64 = await shrinkToBase64(url, true, MAX_EDGE, 0.85);
  return scanBarcode(bare(b64));
}

/**
 * A camera sheet held open by the URL rather than by component state.
 *
 * On Add food a sheet held in `useState` would be a leak as well as a wrong
 * Back: `Foods` is kept mounted behind its asides with `hidden` rather than
 * unmounted, so a backed-out-of camera would go on holding a live `MediaStream`
 * with the indicator light on behind a hidden div. As a hash param the gesture
 * closes the lens. The mechanism is `useHashSheet`, shared with the exercise
 * picker; this keeps the camera's own names for it.
 */
export function useCameraRoute(key: string): {
  open: boolean;
  openCam: () => void;
  closeCam: () => void;
} {
  const { open, show, hide } = useHashSheet("cam", key);
  return { open, openCam: show, closeCam: hide };
}
