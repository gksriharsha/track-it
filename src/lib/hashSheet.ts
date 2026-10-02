import { useCallback, useEffect, useState } from "react";

/**
 * A sheet held open by the URL rather than by component state.
 *
 * Every screen change in this app is a hash change, because that is what makes
 * the Android back gesture work (see `useHashRoute`). A sheet held in
 * `useState` is invisible to that: the gesture does not close the sheet, it
 * navigates the screen out from under it. As a hash param the gesture does
 * exactly what a person who just opened a sheet expects — it closes the sheet.
 * Same shape as the drawer's own `menu` param.
 *
 * `param=value` in the hash means open. Opening pushes an entry; closing goes
 * BACK, so the close button, the scrim and the system gesture all do one thing
 * and leave no forward entry behind — the rule `closeMenu` follows.
 *
 * Sheets stack because history does. A second param opened over the first —
 * an `(i)` over an entry's sheet — is a second entry holding both params, so
 * one Back takes away the top sheet and leaves the one under it standing,
 * which is the order a person expects them to go in.
 *
 * Lifted out of `useCameraRoute`, which is now this with `param` "cam", so the
 * exercise picker (D27) closes the way the lens does.
 */
export function useHashSheetValue(param: string): {
  /** What the sheet is open on — an entry's id, a nutrient's — or null when shut. */
  value: string | null;
  show: (value: string) => void;
  hide: () => void;
} {
  /*
    A reload with the param still in the hash must not reopen the sheet. At
    depth zero there is nothing of ours to pop, so the gesture that closes it
    would close the app instead. Stripped in place, before anything reads it.

    Only a param the PAGE was loaded with is stripped, and only once. The
    strip used to run on every mount of every component holding this hook,
    which was harmless while one screen held one sheet; with an `(i)` beside
    any figure, a row arriving late from the backend would mount its own and
    shut whatever sheet was open — in place, leaving its history entry behind
    for a Back that then appeared to do nothing.
  */
  useEffect(() => {
    if (!LOADED_WITH.has(param)) return;
    LOADED_WITH.delete(param);
    const { path, params } = readHash();
    if (params.get(param) === null) return;
    params.delete(param);
    write(path, params, window.history.state);
    // Rewritten in place, so no event fires on its own. The notice below is
    // ours alone: a `hashchange` here would fight `App`'s own mount-time
    // depth stamping.
    notify();
  }, [param]);

  useForceOnHash();
  const value = readHash().params.get(param);

  const show = useCallback((next: string) => {
    const { path, params } = readHash();
    const now = params.get(param);
    if (now === next) return;
    params.set(param, next);
    if (now !== null) {
      // Already open on something else: the same sheet, moved to another
      // entry. In place, so Back still closes it in one step rather than
      // walking back through every entry it was ever pointed at.
      write(path, params, window.history.state);
      notify();
      return;
    }
    // A plain hash assignment rather than `pushState`, because it fires
    // `hashchange` — which is how `App` learns there is one more entry to go
    // back through. Without it the depth would stand still, and the Android
    // gesture that should close this sheet would close the app.
    window.location.hash = `/${path}?${params.toString()}`;
    notify();
  }, [param]);

  const hide = useCallback(() => {
    const { path, params } = readHash();
    // Already shut. Going back anyway would take the screen with it.
    if (params.get(param) === null) return;
    const st = window.history.state as { d?: number } | null;
    if (typeof st?.d === "number" && st.d > 0) {
      window.history.back();
      return;
    }
    params.delete(param);
    write(path, params, st);
    notify();
  }, [param]);

  return { value, show, hide };
}

/**
 * The same, for a sheet that only ever opens on one thing: `param=key` is open.
 * The camera and the lift picker.
 */
export function useHashSheet(param: string, key: string): {
  open: boolean;
  show: () => void;
  hide: () => void;
} {
  const s = useHashSheetValue(param);
  const open = s.value === key;
  const { show: showValue, hide: hideValue } = s;
  const show = useCallback(() => showValue(key), [showValue, key]);
  // Only its own key: `cam=label` is another lens, and not this one's to shut.
  const hide = useCallback(() => { if (open) hideValue(); }, [open, hideValue]);
  return { open, show, hide };
}

/** The params the page was loaded with — the only ones a mount may strip. */
const LOADED_WITH = new Set(readHash().params.keys());

/**
 * Tells every holder of a sheet hook that the hash moved without an event of
 * its own — a rewrite in place, which `replaceState` never announces. Without
 * it only the component that wrote the hash would re-read it.
 */
const SHEET_EVENT = "trackit:sheet";
function notify(): void {
  window.dispatchEvent(new Event(SHEET_EVENT));
}

function readHash(): { path: string; params: URLSearchParams } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const cut = raw.indexOf("?");
  return {
    path: cut === -1 ? raw : raw.slice(0, cut),
    params: new URLSearchParams(cut === -1 ? "" : raw.slice(cut + 1)),
  };
}

/** The hash rewritten in place, keeping the entry's own state — its depth. */
function write(path: string, params: URLSearchParams, state: unknown): void {
  const s = params.toString();
  window.history.replaceState(state, "", `#/${path}${s ? `?${s}` : ""}`);
}

/**
 * Re-render whenever the hash moves.
 *
 * The sheet's state is read straight off `window.location.hash` rather than
 * held as a copy, so something has to tell React the hash changed: the
 * browser's own two events for a step through history, and ours for a rewrite
 * in place.
 */
function useForceOnHash(): void {
  const [, setN] = useState(0);
  useEffect(() => {
    const bump = () => setN((x) => x + 1);
    window.addEventListener("hashchange", bump);
    window.addEventListener("popstate", bump);
    window.addEventListener(SHEET_EVENT, bump);
    return () => {
      window.removeEventListener("hashchange", bump);
      window.removeEventListener("popstate", bump);
      window.removeEventListener(SHEET_EVENT, bump);
    };
  }, []);
}
