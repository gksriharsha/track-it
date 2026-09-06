import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { probeFrame, scanBarcode } from "../api";
import type { Probe } from "../types";

export type ScanKind = "nutrition" | "supplement" | "ingredients" | "barcode";

interface Props {
  scanKind: ScanKind;
  onCapture: (dataBase64: string) => void;
  onCancel: () => void;
}

/* ── the two cadences ─────────────────────────────────────────────────────
   The gauge is arithmetic over a 320px canvas: cheap enough to run eight
   times a second, and it is what actually answers "at what distance". The
   probe asks the relevant on-device reader about an encoded frame, so it runs
   a tenth as often and ONLY once the local frame has enough sharp structure.
   Running it while the gauge says blurry would spend the battery confirming
   what a Laplacian already knew. */
const GAUGE_MS = 120;
const PROBE_MS = 1200;

/** Exposure, contrast and focus are properties of the whole frame, so they are
    measured on a 320px-wide copy of all of it. Line pitch is NOT: see CROP_W. */
const GAUGE_W = 320;

/**
 * Line pitch is measured on a centre crop at the sensor's own resolution.
 *
 * A downscaled copy is the wrong place to look for it. At 1080p a 320px copy is
 * six source pixels to the row, so a panel held at arm's length — 12 to 20
 * source pixels of pitch, which is exactly the too-far case the user reported —
 * lands under the copy's resolution and every row of the panel merges into one
 * band. The distance question then has no answer at the distances it is being
 * asked about. At full resolution the same panel has 12 to 20 rows of pitch and
 * is plainly measurable, and the answer needs no scaling back: it is already in
 * the pixels the recogniser sees.
 */
const CROP_W = 320;
const CROP_H = 384;

/**
 * Mean absolute horizontal gradient per pixel, divided by mean luminance, below
 * which the frame holds no structure worth measuring — a wall, a hand, a lens
 * cap. Dividing by the mean is what stops a dim room from reading as empty.
 */
const EDGE_MIN = 0.012;

/**
 * Laplacian variance divided by the square of mean luminance. Both scale with
 * exposure — the variance quadratically, the mean linearly — so the ratio is
 * the same number for a sharp panel in a bright kitchen and in a dim one.
 */
const SHARP_MIN = 0.006;

/**
 * Line pitch, in source pixels, below which the print is too small to read: a
 * panel's leading is roughly twice its cap height, so 30px of pitch is about
 * 14px of glyph, which is where accurate recognition starts guessing.
 */
const PITCH_MIN = 30;

/**
 * Too close is framing, not resolution, so its threshold is relative: a pitch
 * wider than a seventh of the frame means fewer than seven rows are in shot and
 * most of the panel is outside it.
 */
const PITCH_MAX_ROWS = 7;

/**
 * How many consecutive samples must agree before the wording changes. At 120ms
 * that is a quarter-second of steadiness — enough that a hand tremor does not
 * strobe the sentence, short enough that moving the phone still feels live.
 */
const HOLD = 2;

/**
 * The shortest line pitch, in profile rows, worth looking for in the
 * autocorrelation. Below two rows there is nothing left to correlate — the
 * canvas is sampling under the Nyquist limit of the print.
 */
const MIN_LAG = 2;

/**
 * How many rows of the whole-frame copy a line of type needs before that copy
 * can be said to have resolved it, and so the pitch at which the crop hands the
 * question back. Four is the three-row smooth plus a row of leading to fall
 * back down into.
 */
const RESOLVABLE_ROWS = 4;

/**
 * How strongly the profile has to repeat at a lag before that lag is called the
 * line pitch. Normalised against the profile's own variance, so it is a shape
 * test rather than a contrast one: rows of type give 0.5 and upwards, a
 * crumpled bag or a wood grain rarely clears this.
 */
const PERIOD_MIN = 0.3;

/** The longest edge a captured frame keeps, and at what quality. Matches what
    the photo slot stores, so nothing is encoded larger than it will be kept. */
const SHOT_EDGE = 1600;
const SHOT_QUALITY = 0.85;

/** What the probe is sent: small enough to encode inside the frame budget,
    large enough that panel type or a barcode filling it remains readable. */
const PROBE_EDGE = 900;
const PROBE_QUALITY = 0.6;

type Gauge = "seeking" | "closer" | "back" | "blurry" | "ready";

/** The same camera sheet reads four different parts of a pack. Keeping this copy
    beside the kind prevents a barcode scan from announcing a nutrition panel. */
const SUBJECT: Record<
  ScanKind,
  { title: string; aria: string; seeking: string; ready: string; captured: string }
> = {
  nutrition: {
    title: "Nutrition panel",
    aria: "Read a nutrition panel",
    seeking: "Point the camera at the Nutrition Facts panel",
    ready: "Looks readable",
    captured: "The camera is off. The photo is being stored and read.",
  },
  supplement: {
    title: "Supplement Facts panel",
    aria: "Read a Supplement Facts panel",
    seeking: "Point the camera at the Supplement Facts panel",
    ready: "Looks readable",
    captured: "The camera is off. The photo is being stored and read.",
  },
  ingredients: {
    title: "Ingredient list",
    aria: "Read an ingredient list",
    seeking: "Point the camera at the ingredient list",
    ready: "Looks readable",
    captured: "The camera is off. The photo is being stored and read.",
  },
  barcode: {
    title: "Barcode",
    aria: "Scan a barcode",
    seeking: "Fill the guide with the barcode",
    ready: "Barcode found — looks readable",
    captured: "The camera is off. The barcode is being read.",
  },
};

/** One plainly-worded state per gauge verdict. Never a bare number: "0.004"
    tells the user nothing about which way to move the phone. */
function says(kind: ScanKind, gauge: Gauge): string {
  if (gauge === "seeking") return SUBJECT[kind].seeking;
  if (gauge === "closer") return "Move closer";
  if (gauge === "back") return "Move back a little";
  if (gauge === "blurry") return "Hold steady — too blurry to read";
  return SUBJECT[kind].ready;
}

/** Why the camera is not running, in the user's terms rather than the API's. */
interface Snag {
  title: string;
  body: string;
}

/**
 * The live camera, with a running answer to "is this close enough to read?".
 *
 * A full-screen sheet over the editor. The frame is measured locally and
 * continuously, and — only when that measurement is favourable — sent to the
 * recogniser so the line count shown is a real one rather than a guess. Every
 * track is stopped on capture, on cancel and on unmount: a camera left running
 * behind a closed sheet is a privacy failure, not an untidiness.
 */
export default function CameraCapture(p: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const work = useRef<HTMLCanvasElement | null>(null);
  const near = useRef<HTMLCanvasElement | null>(null);
  const scratch = useRef<Scratch | null>(null);
  const crop = useRef<Profile | null>(null);
  const sheet = useRef<HTMLDivElement>(null);

  const [gauge, setGauge] = useState<Gauge>("seeking");
  const [probe, setProbe] = useState<Probe | null>(null);
  const [barcodeReady, setBarcodeReady] = useState(false);
  const [barcodeMisses, setBarcodeMisses] = useState(0);
  const [snag, setSnag] = useState<Snag | null>(null);
  const [live, setLive] = useState(false);
  const [done, setDone] = useState(false);

  /** Read by the interval callbacks, which are installed once and must not be
      re-installed every time the wording changes. */
  const gaugeNow = useRef<Gauge>("seeking");
  const pending = useRef<{ state: Gauge; runs: number }>({ state: "seeking", runs: 0 });
  const probing = useRef(false);
  const misses = useRef(0);
  /** A barcode has no horizontal line pitch. It is worth asking the native
      detector about once the frame has structure and is sharp enough. */
  const barcodeProbeable = useRef(false);
  /** Every change that makes an in-flight reading obsolete advances this. */
  const probeEpoch = useRef(0);
  const mounted = useRef(true);

  const invalidateProbe = useCallback(() => {
    probeEpoch.current++;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      invalidateProbe();
    };
  }, [invalidateProbe]);

  useEffect(() => {
    invalidateProbe();
    gaugeNow.current = "seeking";
    pending.current = { state: "seeking", runs: 0 };
    barcodeProbeable.current = false;
    misses.current = 0;
    setGauge("seeking");
    setProbe(null);
    setBarcodeReady(false);
    setBarcodeMisses(0);
  }, [p.scanKind, invalidateProbe]);

  const stop = useCallback(() => {
    invalidateProbe();
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    const v = video.current;
    if (v) v.srcObject = null;
  }, [invalidateProbe]);

  const cancel = useCallback(() => {
    stop();
    p.onCancel();
  }, [stop, p.onCancel]);

  useEffect(() => {
    let dead = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setSnag({
          title: "No camera here",
          body: "This device does not offer a camera to the app. Close this and choose a photo you already have.",
        });
        return;
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          // `ideal` rather than `exact`: a laptop has only a front camera and
          // should still open it, rather than failing where a phone succeeds.
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
        });
        if (dead) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = s;
        // A track ending on its own — the lens taken by another app, a webcam
        // unplugged — leaves a frozen last frame that would keep being measured.
        s.getTracks().forEach((t) => {
          t.addEventListener("ended", () => {
            if (dead) return;
            invalidateProbe();
            barcodeProbeable.current = false;
            setBarcodeReady(false);
            setBarcodeMisses(0);
            setLive(false);
            setSnag({
              title: "The camera stopped",
              body: "Something else on this device took the camera. Close this and open it again, or choose a photo you already have.",
            });
          });
        });
        const v = video.current;
        if (!v) return;
        v.srcObject = s;
        await v.play().catch(() => {
          // Autoplay refusal, not a permission problem. The stream is live and
          // the element will render on the next user gesture; nothing to say.
        });
        if (dead) return;
        setLive(true);
      } catch (e) {
        if (dead) return;
        setSnag(explain(e));
      }
    }

    void start();
    return () => {
      dead = true;
      stop();
    };
  }, [stop, invalidateProbe]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [cancel]);

  /**
   * Keep Tab inside the sheet.
   *
   * The editor's own fields are still in the document behind an opaque overlay,
   * and they are still focusable. Without this, tabbing past Capture walks into
   * them and types into the food being created, out of sight.
   */
  function trap(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const box = sheet.current;
    if (!box) return;
    const stops = [...box.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]")].filter(
      (el) => !el.hasAttribute("disabled") && el.tabIndex >= 0,
    );
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    const on = document.activeElement;
    if (e.shiftKey && (on === first || !box.contains(on))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (on === last || !box.contains(on))) {
      e.preventDefault();
      first.focus();
    }
  }

  /* The local gauge. Runs whenever there is a live stream, regardless of what
     it last said — this is the loop that has to keep up with a moving hand. */
  useEffect(() => {
    if (!live || done) return;
    const id = window.setInterval(() => {
      const v = video.current;
      if (!v || v.readyState < 2 || !v.videoWidth) return;

      const h = Math.max(1, Math.round((GAUGE_W * v.videoHeight) / v.videoWidth));
      const canvas = (work.current ??= document.createElement("canvas"));
      if (canvas.width !== GAUGE_W || canvas.height !== h) {
        canvas.width = GAUGE_W;
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, GAUGE_W, h);

      let s = scratch.current;
      if (!s || s.w !== GAUGE_W || s.h !== h) {
        s = {
          w: GAUGE_W,
          h,
          lum: new Float32Array(GAUGE_W * h),
          prof: new Float32Array(h),
          raw: new Float32Array(h),
        };
        scratch.current = s;
      }

      // The centre of the frame at the sensor's own scale. Same tick, second
      // canvas: what the whole-frame copy is good for (exposure, focus) and
      // what it is useless for (line pitch) need different pixels.
      const cw = Math.min(CROP_W, v.videoWidth);
      const ch = Math.min(CROP_H, v.videoHeight);
      const cut = (near.current ??= document.createElement("canvas"));
      if (cut.width !== cw || cut.height !== ch) {
        cut.width = cw;
        cut.height = ch;
      }
      const cctx = cut.getContext("2d", { willReadFrequently: true });
      if (!cctx) return;
      cctx.drawImage(
        v,
        Math.floor((v.videoWidth - cw) / 2),
        Math.floor((v.videoHeight - ch) / 2),
        cw,
        ch,
        0,
        0,
        cw,
        ch,
      );

      let c = crop.current;
      if (!c || c.w !== cw || c.h !== ch) {
        c = { w: cw, h: ch, prof: new Float32Array(ch), raw: new Float32Array(ch) };
        crop.current = c;
      }

      let raw: Gauge;
      try {
        const frame = measure(ctx.getImageData(0, 0, GAUGE_W, h).data, s);
        const fine = pitchOf(cctx.getImageData(0, 0, cw, ch).data, c);
        const scale = v.videoHeight / h;
        const coarse = frame.pitch === null ? null : frame.pitch * scale;
        // Each copy is asked only what it can answer. The crop exists to see
        // print too fine for the whole-frame copy to separate, so it is trusted
        // below that copy's own limit — roughly four of its rows to a line —
        // and no further: at a coarser pitch the crop is looking inside a
        // single line of type, where an x-height band repeats, while the whole
        // frame can see the lines themselves and how many of them are in shot.
        frame.pitch = fine !== null && fine < RESOLVABLE_ROWS * scale ? fine : (coarse ?? fine);
        if (p.scanKind === "barcode") {
          const canProbe = frame.edge >= EDGE_MIN && frame.sharp >= SHARP_MIN;
          if (canProbe !== barcodeProbeable.current) {
            barcodeProbeable.current = canProbe;
            // A result from before the lens lost the code is no longer a result
            // about the frame on screen now.
            if (!canProbe) {
              invalidateProbe();
              setBarcodeReady(false);
              setBarcodeMisses(0);
            }
          }
          // Barcodes are vertical edges rather than rows of type, so their real
          // readiness verdict comes from the native detector below. The local
          // pass still catches the two things it can say honestly.
          raw = frame.edge < EDGE_MIN ? "seeking" : frame.sharp < SHARP_MIN ? "blurry" : "seeking";
        } else {
          raw = verdict(frame, v.videoHeight);
        }
      } catch {
        // getImageData throws on a tainted canvas. Nothing to measure, and
        // claiming a verdict we did not compute would be the worse failure.
        return;
      }

      // Hysteresis: a new wording has to hold for HOLD samples before it lands.
      const pen = pending.current;
      pen.runs = raw === pen.state ? pen.runs + 1 : 1;
      pen.state = raw;
      if (pen.runs < HOLD || raw === gaugeNow.current) return;

      gaugeNow.current = raw;
      setGauge(raw);
      if (raw !== "ready") {
        // The count belonged to a frame that no longer exists. Keeping it on
        // screen would let a stale "seeing 14 lines" outlive the framing it
        // described.
        misses.current = 0;
        setProbe(null);
        if (p.scanKind !== "barcode") invalidateProbe();
      }
    }, GAUGE_MS);
    return () => window.clearInterval(id);
  }, [live, done, p.scanKind, invalidateProbe]);

  /* The remote probe. Same lifetime as the gauge, but every tick asks the gauge
     ref first — installing and tearing this down on each state change would
     reset its cadence every time the wording flickered. */
  useEffect(() => {
    if (!live || done) return;
    const id = window.setInterval(() => {
      const barcode = p.scanKind === "barcode";
      if ((barcode ? !barcodeProbeable.current : gaugeNow.current !== "ready") || probing.current) return;
      const v = video.current;
      if (!v || v.readyState < 2 || !v.videoWidth) return;
      const b64 = encode(v, PROBE_EDGE, PROBE_QUALITY);
      if (!b64) return;
      const epoch = ++probeEpoch.current;
      probing.current = true;

      if (barcode) {
        scanBarcode(b64).then(
          (r) => {
            probing.current = false;
            if (!mounted.current || epoch !== probeEpoch.current || !barcodeProbeable.current) return;
            const found = r.payload !== null && r.trusted;
            setBarcodeReady(found);
            setBarcodeMisses((n) => (found ? 0 : Math.min(2, n + 1)));
          },
          () => {
            probing.current = false;
            if (!mounted.current || epoch !== probeEpoch.current) return;
            setBarcodeReady(false);
            setBarcodeMisses(0);
          },
        );
        return;
      }

      probeFrame(b64).then(
        (r) => {
          probing.current = false;
          if (!mounted.current || epoch !== probeEpoch.current || gaugeNow.current !== "ready") return;
          const seen = p.scanKind === "nutrition" ? r.panel_lines : r.lines;
          misses.current = seen > 0 ? 0 : misses.current + 1;
          setProbe(r);
        },
        () => {
          // The recogniser is unavailable on this platform, or the frame was
          // rejected. The gauge is still the useful signal; say nothing extra.
          probing.current = false;
        },
      );
    }, PROBE_MS);
    return () => {
      window.clearInterval(id);
      invalidateProbe();
    };
  }, [live, done, p.scanKind, invalidateProbe]);

  function shoot() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const b64 = encode(v, SHOT_EDGE, SHOT_QUALITY);
    if (!b64) {
      // Terminal, and the lens goes off with it: the message covers the live
      // view, so leaving the camera running would only be a blind retry.
      stop();
      setLive(false);
      setSnag({
        title: "That frame could not be saved",
        body: "This device could not turn the picture into a JPEG. Close this and take the photo with the camera app instead.",
      });
      return;
    }
    // Stopped before handing it over: the shot is taken, and there is no reason
    // for the lens to stay open while the parent stores and reads it.
    stop();
    setDone(true);
    p.onCapture(b64);
  }

  const shownGauge: Gauge = p.scanKind === "barcode" && barcodeReady ? "ready" : gauge;
  const ready = shownGauge === "ready";
  const count = p.scanKind === "barcode"
    ? barcodeReady
      ? "Barcode found in the frame"
      : barcodeMisses >= 2
        ? "Not finding a barcode yet"
        : null
    : probe && ready
      ? probeSays(probe, misses.current, p.scanKind)
      : null;
  const subject = SUBJECT[p.scanKind];

  return (
    <div
      className="cam"
      role="dialog"
      aria-modal="true"
      aria-label={subject.aria}
      ref={sheet}
      onKeyDown={trap}
    >
      <div className="cam__top">
        <span className="cam__title">{subject.title}</span>
        {/* Focused on open. `aria-modal` tells a screen reader that everything
            outside this sheet is not there; leaving focus on the button that
            opened it would park the user on content the reader has just hidden,
            with nothing said about the sheet at all. Cancel rather than Capture:
            the way out is the safe thing to land on. */}
        <button className="btn btn--quiet cam__x" type="button" onClick={cancel} autoFocus>
          Cancel
        </button>
      </div>

      <div className="cam__stage">
        {/* Always mounted, never `hidden`: the stream is attached before this
            knows it is live, and a display:none video is one some engines decline
            to decode frames for. What covers it while it is not worth showing is
            the opaque overlay below. */}
        <video ref={video} className="cam__view" playsInline muted autoPlay />

        {live && !done && (
          // Contained, not cropped: the gauge measures the whole sensor frame,
          // so the user has to be shown the whole sensor frame. A cover fit
          // would have them framing to a box that is not what gets read.
          <div className="cam__guide" aria-hidden="true">
            <span className={`cam__box${ready ? " is-ready" : ""}`} />
          </div>
        )}

        {snag && (
          <div className="cam__snag">
            <h3 className="cam__snagh">{snag.title}</h3>
            <p className="cam__snagp">{snag.body}</p>
          </div>
        )}

        {done && (
          <div className="cam__snag">
            <h3 className="cam__snagh">Captured</h3>
            <p className="cam__snagp">{subject.captured}</p>
          </div>
        )}

        {!live && !snag && !done && <p className="cam__wait">Opening the camera…</p>}
      </div>

      {live && !done && (
        <div className="cam__bar">
          <div className="cam__read">
            {/* One live region, not two: the wording is what the user is
                waiting on, and a count re-read every 1.2s would talk over it. */}
            <p className="cam__state" aria-live="polite">
              <span className={`cam__dot${ready ? " is-ready" : ""}`} aria-hidden="true" />
              {says(p.scanKind, shownGauge)}
            </p>
            {/* A non-breaking space rather than nothing: the line keeps its
                height, so the sentence above it does not hop as a count
                arrives or goes. */}
            <p className="cam__count">{count ?? "\u00a0"}</p>
          </div>
          {/* Enabled whatever the gauge says. The gauge is an opinion about the
              frame, and the user is allowed to overrule it. */}
          <button
            className={`btn cam__shot${ready ? "" : " is-dim"}`}
            type="button"
            onClick={shoot}
          >
            Capture
          </button>
        </div>
      )}
    </div>
  );
}

/** Reusable buffers, so a loop running eight times a second is not also
    allocating a megabyte of arrays on every tick. */
interface Profile {
  w: number;
  h: number;
  prof: Float32Array;
  /** The profile before smoothing. Band finding needs the smoothed one; the
      period search needs the fine structure the smoothing removes. */
  raw: Float32Array;
}

/** The whole-frame buffers. Only the Laplacian needs a luminance plane, and
    only the whole frame is asked for a Laplacian. */
interface Scratch extends Profile {
  lum: Float32Array;
}

interface Frame {
  /** Mean |horizontal gradient| per pixel, over mean luminance. */
  edge: number;
  /** Laplacian variance over mean luminance squared. */
  sharp: number;
  /**
   * Line pitch in SOURCE pixels, or null when no line structure was found.
   * Source pixels because that is what the recogniser is handed, and because
   * the crop it is measured on is at that scale already.
   */
  pitch: number | null;
}

/**
 * Everything the gauge knows about one frame.
 *
 * Both figures are normalised by luminance rather than taken raw: a dark frame
 * has a small Laplacian variance for the same reason a blurred one does, and
 * without the normalisation the two are indistinguishable — which would tell a
 * user in a dim kitchen to hold steadier when the real answer is to move to the
 * window or, more often, nothing at all.
 */
function measure(px: Uint8ClampedArray, s: Scratch): Frame {
  const { w, h, lum, prof, raw } = s;

  let sum = 0;
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
    // Rec.601 luma. Green carries most of the detail a sensor resolves, and a
    // flat average would let a red pack read as lower contrast than it is.
    const v = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    lum[p] = v;
    sum += v;
  }
  const mean = sum / lum.length || 1;

  // 3×3 Laplacian, interior only. Its variance is the standard focus measure:
  // an in-focus edge produces a large second derivative, a blurred one does not.
  let ls = 0;
  let lss = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = lum[i - w] + lum[i + w] + lum[i - 1] + lum[i + 1] - 4 * lum[i];
      ls += lap;
      lss += lap * lap;
      n++;
    }
  }
  const varL = n > 0 ? lss / n - (ls / n) ** 2 : 0;

  // Horizontal edge-projection profile. A row of type is dense in horizontal
  // gradient; the leading between two rows is not. The profile therefore has a
  // band per line of text, and the gaps between bands are the line pitch.
  let edgeSum = 0;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let row = 0;
    for (let x = 1; x < w; x++) row += Math.abs(lum[base + x] - lum[base + x - 1]);
    prof[y] = w > 1 ? row / (w - 1) : 0;
    raw[y] = prof[y];
    edgeSum += prof[y];
  }

  return {
    edge: edgeSum / h / mean,
    sharp: varL / (mean * mean),
    // In this canvas's rows. The caller converts, or replaces it with the
    // crop's answer, which is in source pixels already.
    pitch: pitchFrom(prof, raw, h),
  };
}

/**
 * Line pitch in the crop's own pixels — which, the crop being at the sensor's
 * scale, are source pixels.
 *
 * Only the gradient profile is wanted here, so the luminance is never kept: a
 * row's worth is read, differenced and dropped.
 */
function pitchOf(px: Uint8ClampedArray, s: Profile): number | null {
  const { w, h, prof, raw } = s;
  for (let y = 0; y < h; y++) {
    let row = 0;
    let prev = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      if (x > 0) row += Math.abs(v - prev);
      prev = v;
    }
    prof[y] = w > 1 ? row / (w - 1) : 0;
    raw[y] = prof[y];
  }
  return pitchFrom(prof, raw, h);
}

/**
 * A gradient profile turned into a line pitch, in that profile's own rows.
 *
 * `prof` is smoothed in place; `raw` must hold the same values unsmoothed,
 * because the period search below needs the fine structure the smoothing is
 * there to remove.
 */
function pitchFrom(prof: Float32Array, raw: Float32Array, h: number): number | null {
  // Three-row box smooth, in place. p0/p1 hold the pre-smoothing values, and
  // prof[y] is only written after prof[y+1] has been read, so this is safe.
  let p0 = prof[0];
  let p1 = prof[0];
  for (let y = 0; y < h; y++) {
    const p2 = prof[Math.min(h - 1, y + 1)];
    const sm = (p0 + p1 + p2) / 3;
    p0 = p1;
    p1 = p2;
    prof[y] = sm;
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < h; y++) {
    if (prof[y] < lo) lo = prof[y];
    if (prof[y] > hi) hi = prof[y];
  }

  // Relative to this frame's own range rather than absolute: a pale pack under
  // kitchen light and a glossy one under a lamp have very different gradient
  // magnitudes and the same line structure.
  const thr = lo + (hi - lo) * 0.4;
  const centres: number[] = [];
  const thick: number[] = [];
  let start = -1;
  for (let y = 0; y < h; y++) {
    const on = prof[y] >= thr && hi > lo;
    if (on && start < 0) start = y;
    if (start >= 0 && (!on || y === h - 1)) {
      const end = on ? y : y - 1;
      centres.push((start + end) / 2);
      thick.push(end - start + 1);
      start = -1;
    }
  }

  if (centres.length >= 4) {
    const gaps: number[] = [];
    for (let i = 1; i < centres.length; i++) gaps.push(centres[i] - centres[i - 1]);
    return median(gaps);
  }

  // Fewer than four bands has two opposite causes, and band thickness cannot
  // tell them apart: one line of type filling the view, and a panel whose rows
  // have merged into a single band because they are finer than this profile can
  // separate. The period search settles it — merged rows still repeat at their
  // pitch, a single line does not repeat at all — so it is asked first.
  // Guessing from thickness alone is what told a too-far frame to move back.
  const p = period(raw, h);
  if (p !== null) return p;

  // Nothing repeating, and the ink covers little enough of the view to be one
  // row of it. A band is the ink; the pitch is the ink plus its leading, about
  // as much again.
  if (centres.length >= 1 && median(thick) <= h * 0.5) return median(thick) * 2;
  return null;
}

/**
 * The dominant vertical period of the edge profile, in gauge rows, or null when
 * the profile does not repeat.
 *
 * Counting bands answers "how far apart are the rows of type" only for as long
 * as the canvas can still separate them, and it stops being able to well before
 * the print stops being readable — which is exactly the range the user is being
 * asked to move out of. Autocorrelation degrades the other way: the peak stays
 * where the period is and merely weakens as the contrast between a line and its
 * leading goes, so a panel held too far away reports a SMALL pitch and is told
 * to come closer.
 *
 * The search starts after the profile has first fallen out of correlation with
 * itself, so the shoulder of the zero-lag peak cannot be mistaken for a period.
 */
function period(prof: Float32Array, h: number): number | null {
  const last = Math.floor(h / 4);
  if (last < MIN_LAG) return null;

  let mean = 0;
  for (let y = 0; y < h; y++) mean += prof[y];
  mean /= h;

  let energy = 0;
  for (let y = 0; y < h; y++) {
    const d = prof[y] - mean;
    energy += d * d;
  }
  if (energy <= 0) return null;
  const variance = energy / h;

  let dipped = false;
  let best = 0;
  let at: number | null = null;
  for (let lag = MIN_LAG; lag <= last; lag++) {
    let acc = 0;
    for (let y = 0; y + lag < h; y++) acc += (prof[y] - mean) * (prof[y + lag] - mean);
    // Per overlapping sample, so a long lag is not penalised for having fewer.
    const r = acc / (h - lag) / variance;
    if (r <= 0) {
      dipped = true;
      continue;
    }
    if (dipped && r > best) {
      best = r;
      at = lag;
    }
  }
  return best >= PERIOD_MIN ? at : null;
}

/**
 * One frame's measurements turned into one sentence's worth of state.
 *
 * `frameH` is the source frame's height, which is what "too close" is relative
 * to: the pitch is already in source pixels, so both tests are in the units the
 * recogniser works in.
 */
function verdict(f: Frame, frameH: number): Gauge {
  if (f.edge < EDGE_MIN) return "seeking";
  if (f.pitch === null) {
    // Structure, but no line structure. If it is also soft, blur is the more
    // likely reason and the more actionable thing to say.
    return f.sharp < SHARP_MIN ? "blurry" : "seeking";
  }
  if (f.pitch < PITCH_MIN) return "closer";
  if (f.pitch * PITCH_MAX_ROWS > frameH) return "back";
  if (f.sharp < SHARP_MIN) return "blurry";
  return "ready";
}

/** What the recogniser actually found, in words. Never silent about a miss:
    two empty passes in a row is information the user can act on. */
function probeSays(
  r: Probe,
  misses: number,
  kind: Exclude<ScanKind, "barcode">,
): string | null {
  const seen = kind === "nutrition" ? r.panel_lines : r.lines;
  if (seen > 0) {
    return kind === "nutrition"
      ? `Seeing ${seen} ${seen === 1 ? "line" : "lines"} of the panel`
      : `Seeing ${seen} ${seen === 1 ? "line" : "lines"} of text`;
  }
  if (misses < 2) return null;
  if (kind !== "nutrition") return "Not finding readable text yet";
  return r.lines > 0
    ? "Reading text, but not a nutrition panel yet"
    : "Not finding a panel yet";
}

/**
 * The current video frame as bare base64 JPEG, downscaled to `edge` on its
 * longest side. Returns null rather than throwing: a frame that will not encode
 * is a reason to keep going, not to tear the sheet down.
 */
function encode(v: HTMLVideoElement, edge: number, quality: number): string | null {
  const scale = Math.min(1, edge / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.max(1, Math.round(v.videoWidth * scale));
  const h = Math.max(1, Math.round(v.videoHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(v, 0, 0, w, h);
    const url = canvas.toDataURL("image/jpeg", quality);
    const comma = url.indexOf(",");
    if (!url.startsWith("data:image/jpeg") || comma < 0) return null;
    return url.slice(comma + 1);
  } catch {
    return null;
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Why getUserMedia refused, said as the thing the user can do about it. The
 * names are the spec's; the sentences are not, because "NotAllowedError" is
 * not an instruction.
 */
function explain(e: unknown): Snag {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      title: "TrackIt was not allowed to use the camera",
      body:
        "On a Mac, look in System Settings › Privacy & Security › Camera. If TrackIt is not " +
        "listed there at all, it has not been able to ask yet — a development build is signed " +
        "too loosely for macOS to offer the choice, and the packaged app asks properly. " +
        "On Android it is under Settings › Apps › TrackIt › Permissions. " +
        "Either way, close this and pick a photo you already have — it is read exactly the same.",
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return {
      title: "No camera found",
      body: "This device has no camera the app can open. Close this and choose a photo you already have.",
    };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return {
      title: "The camera is busy",
      body: "Another app is using it. Close that app and try again, or choose a photo you already have.",
    };
  }
  return {
    title: "The camera would not open",
    body: "Close this and choose a photo you already have — a picture taken with the camera app reads just as well.",
  };
}
