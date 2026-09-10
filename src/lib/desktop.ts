/**
 * What the app needs to know about being on a desktop rather than in a hand.
 *
 * Three separate facts, deliberately not collapsed into one "isDesktop":
 *
 *   width    how much room there is — a narrow window on a Mac is still narrow
 *   pointer  whether the input device is a mouse, which is what decides how
 *            small a target may be; 44px is a thumb's minimum, not a cursor's
 *   platform whether macOS is drawing the window chrome, which is what decides
 *            whether the top-left corner belongs to the app or to the traffic
 *            lights
 *
 * A tablet with a stylus is wide and coarse; a phone-sized window on a laptop
 * is narrow and fine. Keying density off width alone would shrink a touch
 * target on an Android tablet, and keying the titlebar inset off width alone
 * would punch a hole in the top of the Windows and Android builds.
 */
import { useEffect, useRef } from "react";
import { inTauri } from "./bridge";

/**
 * Marks the document with what is drawing the window, so CSS can reserve the
 * top-left corner for the traffic lights on macOS and nowhere else.
 *
 * Called once, from `main.tsx`, before React renders — the inset changes layout,
 * and applying it a frame later would show the sidebar jumping down.
 */
export function markPlatform(): void {
  const root = document.documentElement;
  const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
  // Only the Tauri macOS build has the overlaid titlebar. Safari on a Mac is
  // still a browser tab with its own chrome above the page, and reserving
  // 28px there would just be a gap.
  if (mac && inTauri()) root.dataset.chrome = "macos";
  if (inTauri()) root.dataset.shell = "native";
}

/**
 * Whether this is the Android build.
 *
 * The user agent alone, and deliberately NOT `inTauri() && /Android/`. The
 * tighter test would be false in `pnpm dev`, which would make every fixture
 * written for an Android-only screen dead code and leave that screen reachable
 * only on a physical phone — so the one surface most in need of design work
 * would be the one surface nobody could look at. A plain production browser
 * never reaches a real command anyway: `bridge.ts` rejects with a sentence when
 * Tauri is absent and the build is not a dev build.
 *
 * The query-string override is dev-only, substituted away by `vite build`, and
 * exists so a Mac browser can open `?android` and see the screen at all.
 */
export const isAndroid = (): boolean => {
  if (typeof navigator !== "undefined" && /Android/.test(navigator.userAgent)) return true;
  return (
    import.meta.env.DEV &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("android")
  );
};

/* ── keyboard ───────────────────────────────────────────────────────────── */

/** The platform's own command modifier, so hints read right on both. */
export const MOD = /Mac|iPhone|iPad/.test(
  typeof navigator === "undefined" ? "" : navigator.userAgent,
)
  ? "⌘"
  : "Ctrl";

export interface Hotkey {
  /** `event.key`, compared case-insensitively. */
  key: string;
  /** Requires the platform command modifier (⌘ on macOS, Ctrl elsewhere). */
  mod?: boolean;
  shift?: boolean;
  run: (e: KeyboardEvent) => void;
  /**
   * Fire even while a text field has focus. Off by default — a plain "n" typed
   * into the search box must stay an "n" — and on for Escape and for anything
   * carrying the command modifier, which no text field consumes.
   */
  inFields?: boolean;
}

/** Whether a key event started inside something the user is typing into. */
function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

/**
 * Binds a set of shortcuts for as long as the component is mounted.
 *
 * The list is read through a ref rather than closed over, so a caller may pass
 * a freshly-built array every render — which is the natural way to write these
 * — without the window listener being torn down and rebound each time.
 */
export function useHotkeys(keys: Hotkey[], enabled = true): void {
  const latest = useRef(keys);
  latest.current = keys;

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      // A composition in progress (an IME picking a character) must not be
      // read as a shortcut — the keystrokes belong to the text being composed.
      if (e.isComposing) return;
      const mod = e.metaKey || e.ctrlKey;
      for (const k of latest.current) {
        if (k.key.toLowerCase() !== e.key.toLowerCase()) continue;
        if (!!k.mod !== mod) continue;
        if (k.shift !== undefined && k.shift !== e.shiftKey) continue;
        const allowed = k.inFields || k.mod || e.key === "Escape";
        if (!allowed && typing(e.target)) continue;
        e.preventDefault();
        k.run(e);
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
