import { useCallback, useEffect, useState } from "react";
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
 * Every screen change in this app is a hash change, because that is what makes
 * the Android back gesture work (see `useHashRoute`). A camera sheet held in
 * `useState` is invisible to that: the gesture does not close the lens, it
 * navigates the screen out from under it. On the editors that was merely
 * jarring — the screen unmounts and takes the stream with it. On Add food it
 * would be a leak, because `Foods` is kept mounted behind its asides with
 * `hidden` rather than unmounted, so a backed-out-of camera would go on holding
 * a live `MediaStream` with the indicator light on behind a hidden div.
 *
 * As a hash param the gesture does exactly what a person who just opened a lens
 * expects: it closes the lens. Same shape as the drawer's own `menu` param.
 */
export function useCameraRoute(key: string): {
  open: boolean;
  openCam: () => void;
  closeCam: () => void;
} {
  const read = () => {
    const raw = window.location.hash.replace(/^#\/?/, "");
    const cut = raw.indexOf("?");
    return {
      path: cut === -1 ? raw : raw.slice(0, cut),
      params: new URLSearchParams(cut === -1 ? "" : raw.slice(cut + 1)),
    };
  };

  /*
    A reload with `cam` still in the hash must not hand back a live lens.

    At depth zero there is nothing of ours to pop, so the gesture that closes
    the sheet would close the app instead — and a camera the user did not open
    is the worst thing to trap them behind. Stripped in place on mount, before
    anything reads it.
  */
  useEffect(() => {
    const { path, params } = read();
    if (params.get("cam") === null) return;
    params.delete("cam");
    const s = params.toString();
    window.history.replaceState(window.history.state, "", `#/${path}${s ? `?${s}` : ""}`);
    // The hash is rewritten in place, so nothing re-renders on its own; the
    // subscriber below picks the change up on the next navigation. Dispatching
    // here would fight `App`'s own mount-time depth stamping.
  }, []);

  const force = useForceOnHash();
  const { params } = read();
  const open = params.get("cam") === key;

  const openCam = useCallback(() => {
    const { path, params: q } = read();
    q.set("cam", key);
    window.location.hash = `/${path}?${q.toString()}`;
    force();
  }, [key, force]);

  const closeCam = useCallback(() => {
    // Going BACK, so the button, the scrim and the system gesture all do one
    // thing and leave no forward entry behind — the rule `closeMenu` follows.
    const st = window.history.state as { d?: number } | null;
    if (typeof st?.d === "number" && st.d > 0) {
      window.history.back();
      return;
    }
    const { path, params: q } = read();
    q.delete("cam");
    const s = q.toString();
    window.history.replaceState(st, "", `#/${path}${s ? `?${s}` : ""}`);
    force();
  }, [force]);

  return { open, openCam, closeCam };
}

/**
 * Re-render whenever the hash moves, and return a way to force it.
 *
 * `useCameraRoute` reads the sheet's state straight off `window.location.hash`
 * rather than holding a copy, so something has to tell React the hash changed.
 * The forcer is for the two places that write the hash themselves and must not
 * wait for the event to come back around.
 */
function useForceOnHash(): () => void {
  const [, setN] = useState(0);
  const bump = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    window.addEventListener("hashchange", bump);
    window.addEventListener("popstate", bump);
    return () => {
      window.removeEventListener("hashchange", bump);
      window.removeEventListener("popstate", bump);
    };
  }, [bump]);
  return bump;
}
