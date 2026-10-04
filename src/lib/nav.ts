/**
 * Where Back goes, worked out before anything touches history. See D30.
 *
 * The rule the app keeps (chosen from rendered options, "Tabs, then Trends"):
 *
 * - Trends is the root of history, depth 0, and Back on it closes the app.
 * - The tabs never stack. Switching to one leaves exactly Trends under it, so
 *   Back from Today, Days or anything the bar or the sidebar reaches goes to
 *   Trends rather than replaying every tab visited.
 * - Logging ends on Today with only Trends behind it. The + sheet, the search
 *   and the amount that led there are gone from history, so Back cannot reopen
 *   any of them.
 * - Finishing a form goes back to the screen that opened it. It never opens
 *   that screen again on top, which would leave the finished form behind it.
 *
 * Browser history cannot be truncated, only walked back and written over. So
 * every one of these is a short list of operations: perhaps a walk back to the
 * root, then entries written over it. A walk is asynchronous — the browser
 * answers it with a popstate later — so whoever runs a plan must wait for that
 * before carrying on (see `useHashRoute` in App.tsx). Kept free of the DOM so
 * the arithmetic can be tested in a bare Node process (nav.test.ts).
 */

/** One step against `window.history`. Every entry carries its depth as `d`. */
export type HistoryOp =
  /** Walk back this many entries: a negative number, always. */
  | { kind: "walk"; by: number }
  /** Write over the entry at this depth. */
  | { kind: "replace"; d: number; hash: string }
  /** Add an entry at this depth, dropping anything forward of it. */
  | { kind: "push"; d: number; hash: string };

/** What the root entry holds once the app has written it. */
export const ROOT_HASH = "#/statistics";

/** Where a hash points, and whether anything rides on it: a sheet, the drawer. */
export function parseHash(hash: string): { path: string; params: URLSearchParams } {
  const raw = hash.replace(/^#\/?/, "");
  const cut = raw.indexOf("?");
  return {
    path: cut === -1 ? raw : raw.slice(0, cut),
    params: new URLSearchParams(cut === -1 ? "" : raw.slice(cut + 1)),
  };
}

/**
 * Whether this hash is Trends and nothing else. A cold start loads with no
 * fragment at all, and that empty path is Trends too.
 */
export function isBareRoot(hash: string): boolean {
  const { path, params } = parseHash(hash);
  return (path === "" || path === "statistics") && [...params.keys()].length === 0;
}

/** Whether this hash is the screen `path` and nothing else. */
export function isBare(hash: string, path: string): boolean {
  const h = parseHash(hash);
  return h.path === path && [...h.params.keys()].length === 0;
}

/**
 * History made to read exactly Trends, then `hashes` in order.
 *
 * At the root, the root is written over and the rest pushed. One entry above
 * it, that entry is written over instead of walking back to it, which spares
 * a frame of Trends between the two screens; the root is already Trends,
 * because the app puts it there at launch (`planLaunch`). Anywhere deeper, the
 * walk back to the root comes first.
 */
export function planReset(depth: number, hashes: readonly string[]): HistoryOp[] {
  if (depth === 1 && hashes.length > 0) {
    return [
      { kind: "replace", d: 1, hash: hashes[0] },
      ...hashes.slice(1).map((hash, i): HistoryOp => ({ kind: "push", d: i + 2, hash })),
    ];
  }
  const ops: HistoryOp[] = depth > 0 ? [{ kind: "walk", by: -depth }] : [];
  ops.push({ kind: "replace", d: 0, hash: ROOT_HASH });
  hashes.forEach((hash, i) => ops.push({ kind: "push", d: i + 1, hash }));
  return ops;
}

/**
 * A tab, from wherever the person is: history reads Trends, then the tab.
 * Trends itself is the root alone. Already standing on the bare tab, nothing
 * is written — a second tap on Today does not add a second Today.
 */
export function planTab(depth: number, currentHash: string, tab: string): HistoryOp[] {
  if (tab === "statistics") {
    return depth === 0 && isBareRoot(currentHash) ? [] : planReset(depth, []);
  }
  if (depth === 1 && isBare(currentHash, tab)) return [];
  return planReset(depth, [`#/${tab}`]);
}

/**
 * Leave the current screen for the one that opened it, `steps` entries back.
 *
 * The opener is wherever history says it is, not what a `from` param claims.
 * With nothing behind this entry, which only happens on Trends once
 * `planLaunch` has run, `fallback` takes its place instead of closing the app.
 */
export function planBack(depth: number, steps: number, fallback: string): HistoryOp[] {
  if (depth >= steps) return [{ kind: "walk", by: -steps }];
  if (depth > 0) return [{ kind: "walk", by: -depth }];
  return [{ kind: "replace", d: 0, hash: fallback }];
}

/**
 * `planBack`, anchored to the screen that asked for it.
 *
 * A Save that finishes after an await steps back from wherever history is
 * by then, not from where the button was. If the person pressed Back while
 * it was saving, a plain step would go one further than they meant; and if
 * an overlay opened meanwhile, it would close that instead of the form. So
 * the step is worked out from `at`, the depth of the screen that asked:
 * history ends `steps` below it, or stays put if it is already there.
 */
export function planBackFrom(depth: number, at: number, steps: number, fallback: string): HistoryOp[] {
  const target = at - steps;
  if (depth <= target) return [];
  return planBack(depth, depth - target, fallback);
}

/**
 * The entry the app opened on, made to sit on Trends.
 *
 * A cold start opens on Trends and needs nothing. A page that opens anywhere
 * else at depth 0 — a reload of a deep screen, a hash typed in a browser —
 * would leave Back closing the app from Today. So the root is written over
 * with Trends and the screen pushed above it. A depth above 0 means this page
 * has been here before and already did this.
 */
export function planLaunch(depth: number, hash: string): HistoryOp[] {
  if (depth > 0 || isBareRoot(hash)) return [];
  // Trends with a sheet or the drawer still in the hash: sheets never reopen
  // on a reload (see hashSheet.ts), so the root is simply Trends again rather
  // than Trends with a second, emptied Trends one Back above it.
  const { path, params } = parseHash(hash);
  if (path === "" || path === "statistics") return [{ kind: "replace", d: 0, hash: ROOT_HASH }];
  // The drawer does not come back either. Left in, it would sit one Back above
  // Trends with the screen under it, and closing it would take the screen too.
  params.delete("menu");
  const rest = params.toString();
  return [
    { kind: "replace", d: 0, hash: ROOT_HASH },
    { kind: "push", d: 1, hash: `#/${path}${rest ? `?${rest}` : ""}` },
  ];
}
