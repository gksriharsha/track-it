import { useEffect, useRef, useState } from "react";
import { readFoodPhoto, saveFoodPhoto } from "../api";
import CameraCapture from "./CameraCapture";
import type { ScanKind } from "./CameraCapture";

interface Props {
  scanKind: Exclude<ScanKind, "barcode">;
  label: string;
  hint: string;
  /** The stored base filename, or null. The parent owns it; this only reports changes. */
  name: string | null;
  onChange: (name: string | null) => void;
  /**
   * A photo was just stored under this name. The parent decides what to do with
   * it — reading the panel is its call, not this slot's, because only the parent
   * knows which slot holds a nutrition panel and what to do with what comes back.
   */
  onScan?: (name: string) => void;
}

/**
 * The longest edge a stored pack photo keeps, and the JPEG quality it keeps it at.
 *
 * A phone camera hands over 3–5 MB; a nutrition panel is legible at 200–400 KB, and
 * the difference is what the user's disk pays for every food they add. 1600px is
 * comfortably above what it takes to read 6pt type on a panel photographed close up.
 */
const MAX_EDGE = 1600;
const QUALITY = 0.82;

/** The backend's own ceiling, checked here so an oversized file fails before the IPC. */
const MAX_BYTES = 6 * 1024 * 1024;

/**
 * Whether this device can hand a live stream to the page at all. A desktop with no
 * camera and a WebView built without the capability both fail at `getUserMedia`, and
 * offering a button that can only apologise is worse than not offering it: the file
 * route below works on every device either way.
 */
const CAN_STREAM =
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/**
 * One photo of the pack, taken or picked, downscaled, and stored by the backend.
 *
 * Two ways in, and both are needed. The file input is the fallback and the way a
 * photo already on disk gets in; on Android its `capture` attribute hands the job
 * to the camera app. The live camera is the way to photograph a panel you are
 * still holding, because it can say whether the frame is readable BEFORE the
 * shutter — which the camera app cannot.
 */
export default function PhotoSlot(p: Props) {
  const file = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  /** Which stored name `preview` belongs to, so a re-render is not a re-read. */
  const shown = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [camera, setCamera] = useState(false);

  useEffect(() => {
    const name = p.name;
    if (!name) {
      shown.current = null;
      setPreview(null);
      return;
    }
    if (shown.current === name) return;
    let live = true;
    setLoading(true);
    readFoodPhoto(name).then(
      (b64) => {
        if (!live) return;
        shown.current = name;
        setPreview(`data:${mimeOf(name)};base64,${b64}`);
        setLoading(false);
      },
      () => {
        if (!live) return;
        // The food still names a photo we cannot read. Say so rather than
        // rendering an empty slot, which would read as "no photo taken".
        shown.current = null;
        setPreview(null);
        setLoading(false);
        setError("That photo is no longer on disk. Take it again, or remove it from this food.");
      },
    );
    return () => {
      live = false;
    };
  }, [p.name]);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);

  /**
   * Shrink, store, and hand the stored name up. `src` is anything an `<img>` can
   * decode: an object URL for a picked file, a data URL for a captured frame.
   */
  async function keep(src: string, revoke: boolean) {
    setBusy(true);
    setError(null);
    try {
      const b64 = await shrink(src, revoke);
      if (b64.length * 0.75 > MAX_BYTES) {
        throw new Error("That image is too large to store even after shrinking it.");
      }
      const saved = await saveFoodPhoto(b64);
      // Set the preview from the bytes we already hold, and claim the name before
      // telling the parent — otherwise the effect above reads back from disk what
      // is already in memory.
      shown.current = saved;
      setPreview(`data:image/jpeg;base64,${b64}`);
      p.onChange(saved);
      // Only once the photo is genuinely stored: whatever the parent does with it
      // reads it back by name.
      p.onScan?.(saved);
    } catch (e) {
      // The slot keeps whatever it had. Nothing here may leave it naming a photo
      // that was never stored.
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  function captured(dataBase64: string) {
    setCamera(false);
    // The camera hands over a full-resolution frame, so it goes through the same
    // ceiling as a picked file rather than straight to disk.
    const src = dataBase64.startsWith("data:")
      ? dataBase64
      : `data:image/jpeg;base64,${dataBase64}`;
    void keep(src, false);
  }

  function remove() {
    shown.current = null;
    setPreview(null);
    setError(null);
    setOpen(false);
    p.onChange(null);
  }

  const has = preview !== null;

  return (
    <div className="pslot">
      <div className="pslot__head">
        <span className="group__name">{p.label}</span>
        {p.name && (
          <button className="link" type="button" onClick={remove}>
            Remove
          </button>
        )}
      </div>

      {has ? (
        <>
          <button
            className="pslot__shot"
            type="button"
            onClick={() => {
              setZoom(false);
              setOpen(true);
            }}
            aria-label={`Open the ${p.label.toLowerCase()} full size`}
          >
            <img src={preview} alt={p.label} />
          </button>
          <div className="pslot__acts">
            {CAN_STREAM && (
              <button
                className="btn btn--quiet pslot__btn"
                type="button"
                onClick={() => setCamera(true)}
                disabled={busy}
              >
                Use the camera
              </button>
            )}
            <button
              className="btn btn--quiet pslot__btn"
              type="button"
              onClick={() => file.current?.click()}
              disabled={busy}
            >
              {busy ? "Saving…" : "Replace"}
            </button>
            <span className="pslot__hint">Tap it to read it full size while you type.</span>
          </div>
        </>
      ) : (
        <>
          <button
            className="pslot__drop"
            type="button"
            onClick={() => file.current?.click()}
            disabled={busy || loading}
          >
            <span className="pslot__take">
              {busy ? "Saving…" : loading ? "Opening…" : "Add a photo"}
            </span>
            <span className="pslot__hint">{p.hint}</span>
          </button>
          {CAN_STREAM && (
            <div className="pslot__acts">
              <button
                className="btn btn--quiet pslot__btn"
                type="button"
                onClick={() => setCamera(true)}
                disabled={busy}
              >
                Use the camera
              </button>
              <span className="pslot__hint">
                It shows you whether the print is close enough to read before you take it.
              </span>
            </div>
          )}
        </>
      )}

      {error && (
        <p className="alert pslot__err" role="alert">
          {error}
        </p>
      )}

      {/* The file route, kept for both jobs it does: picking a photo already on
          disk, and standing in when the camera is refused. `capture` asks Android
          for the camera app; desktop ignores it and opens the file picker. */}
      <input
        ref={file}
        className="pslot__file"
        type="file"
        accept="image/*"
        capture="environment"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Cleared so picking the same file twice still fires a change.
          e.target.value = "";
          if (f) void keep(URL.createObjectURL(f), true);
        }}
      />

      {camera && (
        <CameraCapture
          scanKind={p.scanKind}
          onCapture={captured}
          onCancel={() => setCamera(false)}
        />
      )}

      {open && has && (
        <div className="pview" role="dialog" aria-modal="true" aria-label={p.label}>
          <div className="pview__bar">
            <span className="pview__name">{p.label}</span>
            {/* Fitted to the screen a panel's small print is often still small. Actual
                size lets the pane scroll under it instead. */}
            <button className="btn btn--quiet pview__btn" type="button" onClick={() => setZoom(!zoom)}>
              {zoom ? "Fit" : "Actual size"}
            </button>
            <button className="btn btn--quiet pview__btn" type="button" onClick={() => setOpen(false)} autoFocus>
              Close
            </button>
          </div>
          <div className={`pview__body${zoom ? " is-zoom" : ""}`}>
            <img src={preview} alt={p.label} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Shrink to `MAX_EDGE` and re-encode as JPEG, returning bare base64.
 *
 * Drawing through an `<img>` rather than the raw bytes is deliberate: it applies the
 * EXIF orientation a phone writes, so a panel photographed in portrait is stored the
 * way it was seen rather than on its side.
 *
 * `revoke` releases an object URL once decoded; a data URL has nothing to release.
 */
function shrink(src: string, revoke: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const done = () => {
      if (revoke) URL.revokeObjectURL(src);
    };
    img.onload = () => {
      done();
      try {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("This device cannot process the image.");
        // Not a UI colour, so not a token: it is the paper behind a transparent PNG.
        // Left unpainted, transparency composites to black in JPEG and a pale pack
        // comes back unreadable.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const url64 = canvas.toDataURL("image/jpeg", QUALITY);
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
 * The extension the backend gave the file — which it derived from the bytes, not
 * from anything the frontend said — is the one trustworthy thing about the name.
 */
function mimeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
}

function msg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "That photo could not be saved.";
}
