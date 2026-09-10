/**
 * Keeping the screen open while the phone is on the counter.
 *
 * The kitchen case is the whole of it: the phone is propped against the scale,
 * hands are wet or floury, and the screen sleeps between putting the katori
 * down and reading what it says. Nothing here is about battery discipline in
 * the abstract — it is about the twenty seconds in which a person cannot touch
 * their own phone.
 *
 * This asks the Android window flag through `set_keep_awake`, not
 * `navigator.wakeLock`. The web API needs no native code, which is genuinely
 * tempting, but it also exists in WKWebView — so the identical module would
 * quietly stop the user's Mac going to sleep. On the Rust side everything but
 * Android is `Ok(())` by `#[cfg]`, a promise the compiler keeps; an
 * `if (isAndroid)` here would be a promise only until somebody edited it.
 *
 * Note what this module is NOT: it is not per-component state. There is one
 * window and one flag on it, so the count below is deliberately module-level. A
 * boolean per caller would let the cook sheet's own weight field switch out of
 * scale mode and clear the flag the sheet is still holding, and that bug
 * presents as "the screen sometimes sleeps during a cook".
 *
 * There are four ways the flag comes off, and they are not redundant. Leaving
 * the screen unmounts the holder, which is also how the Android back gesture
 * releases it. Half an hour untouched releases it, because a cook sheet is the
 * sort of screen you walk away from. `pagehide` releases it, for the reload
 * that replaces this document while the app stays in the foreground. And the
 * app leaving the foreground is handled entirely in `MainActivity.onPause`,
 * natively — deliberately NOT here. A `visibilitychange` listener looks like
 * the obvious fourth net and it is a race it loses: Wry pauses the WebView on
 * the way out, which freezes this JavaScript, and Chromium only flips page
 * visibility around `onStop`, after the freeze. Anything scheduled here would
 * simply not run. The Activity sees its own pause reliably, so that is where
 * that net lives.
 */
import { useEffect } from "react";
import { setKeepAwake } from "../api";

/**
 * How long the app will hold the screen open with nobody touching the phone.
 *
 * A phone left burning its screen all night is a worse bug than the one this
 * file exists to fix, and it is the likelier one. Thirty minutes is long enough
 * to cover reducing a pot while glancing at the sheet, and short enough that a
 * forgotten phone is a forgotten phone rather than a flat one. Any touch, key
 * or typed character starts it again.
 */
const IDLE_RELEASE_MS = 30 * 60 * 1000;

/** How many mounted components currently want the screen kept open. */
let holders = 0;
/** True once `IDLE_RELEASE_MS` has gone by with nobody touching the phone. */
let idle = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * True between `pagehide` and `pageshow`.
 *
 * A separate flag rather than zeroing `holders`, which is what a first draft
 * did. `pagehide` fires with `persisted: true` on a bfcache navigation and the
 * document comes back intact with its components still mounted, so their later
 * unmounts would each decrement a count that had already been reset — leaving
 * it negative, and the feature silently dead for the rest of the session.
 * `holders` stays a faithful mirror of what is mounted.
 */
let pageHidden = false;
/**
 * What the native side has been told, or `null` for "we do not know".
 *
 * It starts unknown on purpose, and that is the fix for the one leak the other
 * paths miss. The window flag belongs to the Activity and outlives this
 * document; a reload — which `tauri android dev` does on every front-end edit,
 * and which a WebView renderer restart does in the field — hands a fresh
 * document a window that may already be held open by a page that no longer
 * exists. Because `null` matches neither `true` nor `false`, the first
 * reconcile always crosses, so every document begins by putting the flag into
 * a state it actually knows.
 */
let told: boolean | null = null;
let wanted = false;
let inFlight = false;

/**
 * One request at a time, and the last intent wins.
 *
 * `setKeepAwake` crosses to Android's main thread, so two calls racing could
 * land in either order and leave the flag set with nothing holding it. A
 * failure is swallowed and then treated as done: the bridge is either working
 * or gone, and retrying a dead bridge on every touch would be a loop with
 * nobody to see it. Giving up costs a screen that dims on its ordinary
 * timeout, and a flag stuck the other way is caught natively when the app next
 * leaves the foreground.
 */
function reconcile(): void {
  if (inFlight || told === wanted) return;
  const next = wanted;
  inFlight = true;
  setKeepAwake(next)
    .catch(() => { /* the screen keeps its usual timeout; nothing to say */ })
    .finally(() => {
      told = next;
      inFlight = false;
      reconcile();
    });
}

function recompute(): void {
  wanted = holders > 0 && !idle && !pageHidden;
  // Published for `MainActivity.onResume`, which reads it off the window to
  // put the flag back after clearing it on the way out. It asks the live page
  // rather than remembering an answer precisely because a remembered "yes"
  // survives the page that gave it.
  (window as unknown as { __keepAwake?: boolean }).__keepAwake = wanted;
  reconcile();
}

/** Someone touched the phone. Start the idle clock again. */
function poke(): void {
  idle = false;
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idle = true;
    recompute();
  }, IDLE_RELEASE_MS);
  recompute();
}

function onPageHide(): void {
  pageHidden = true;
  recompute();
}

function onPageShow(): void {
  pageHidden = false;
  recompute();
}

/**
 * Listen only while somebody is holding the screen.
 *
 * `input` is in the list alongside `pointerdown` and `keydown`, and it is not
 * decoration: Android's WebView reports composition-based text entry from many
 * soft keyboards as a single keyCode 229 rather than as a `keydown` per
 * character, so a person typing gross weights into the weight field without
 * lifting a finger could otherwise walk into the idle ceiling mid-use.
 */
function watch(on: boolean): void {
  const opts = { capture: true, passive: true } as const;
  if (on) {
    window.addEventListener("pointerdown", poke, opts);
    window.addEventListener("keydown", poke, opts);
    window.addEventListener("input", poke, opts);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
  } else {
    window.removeEventListener("pointerdown", poke, opts);
    window.removeEventListener("keydown", poke, opts);
    window.removeEventListener("input", poke, opts);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    idle = false;
  }
}

/**
 * Ask for the screen to stay open while `hold` is true and this component is
 * mounted.
 *
 * A no-op on desktop and anywhere the bridge is not there — the caller does not
 * branch on the platform, and there is nothing to read back, because a screen
 * that reports whether it is awake invites a control for it and this is not a
 * setting.
 */
export function useKeepAwake(hold: boolean): void {
  useEffect(() => {
    if (!hold) return;
    if (holders === 0) watch(true);
    holders += 1;
    // Arriving on the screen counts as touching the phone. Without this a
    // holder mounting after the clock had already run out would inherit
    // `idle`, and the screen it just asked to keep open would not be.
    poke();
    return () => {
      holders -= 1;
      if (holders === 0) watch(false);
      recompute();
    };
  }, [hold]);
}

// Once, as this document boots: say out loud what the flag should be, which
// with `told` unknown means telling the native side even though the answer is
// "off". See `told` for the reload this is the only cover for.
recompute();
