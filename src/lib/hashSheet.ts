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
 * `param=key` in the hash means open. Opening pushes an entry; closing goes
 * BACK, so the close button, the scrim and the system gesture all do one thing
 * and leave no forward entry behind — the rule `closeMenu` follows.
 *
 * Lifted out of `useCameraRoute`, which is now this with `param` "cam", so the
 * exercise picker (D27) closes the way the lens does.
 */
export function useHashSheet(param: string, key: string): {
  open: boolean;
  show: () => void;
  hide: () => void;
} {
  /*
    A reload with the param still in the hash must not reopen the sheet. At
    depth zero there is nothing of ours to pop, so the gesture that closes it
    would close the app instead. Stripped in place on mount, before anything
    reads it.
  */
  useEffect(() => {
    const { path, params } = readHash();
    if (params.get(param) === null) return;
    params.delete(param);
    const s = params.toString();
    window.history.replaceState(window.history.state, "", `#/${path}${s ? `?${s}` : ""}`);
    // The hash is rewritten in place, so nothing re-renders on its own; the
    // subscriber below picks the change up on the next navigation. Dispatching
    // here would fight `App`'s own mount-time depth stamping.
  }, [param]);

  const force = useForceOnHash();
  const open = readHash().params.get(param) === key;

  const show = useCallback(() => {
    const { path, params } = readHash();
    params.set(param, key);
    window.location.hash = `/${path}?${params.toString()}`;
    force();
  }, [param, key, force]);

  const hide = useCallback(() => {
    const st = window.history.state as { d?: number } | null;
    if (typeof st?.d === "number" && st.d > 0) {
      window.history.back();
      return;
    }
    const { path, params } = readHash();
    params.delete(param);
    const s = params.toString();
    window.history.replaceState(st, "", `#/${path}${s ? `?${s}` : ""}`);
    force();
  }, [param, force]);

  return { open, show, hide };
}

function readHash(): { path: string; params: URLSearchParams } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const cut = raw.indexOf("?");
  return {
    path: cut === -1 ? raw : raw.slice(0, cut),
    params: new URLSearchParams(cut === -1 ? "" : raw.slice(cut + 1)),
  };
}

/**
 * Re-render whenever the hash moves, and return a way to force it.
 *
 * The sheet's state is read straight off `window.location.hash` rather than
 * held as a copy, so something has to tell React the hash changed. The forcer
 * is for the two places that write the hash themselves and must not wait for
 * the event to come back around.
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
