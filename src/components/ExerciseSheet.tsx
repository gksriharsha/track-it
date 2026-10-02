import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { humanDate } from "../api";
import { LOADS, findExercises, setText } from "../lib/activity";
import type { ExerciseHit, ExerciseRef, Load } from "../lib/activity";
import { AREAS, areaFor, artFor, mostlyLine, musclesFor, nameKey } from "../lib/exerciseArt";
import type { Area } from "../lib/exerciseArt";
import LiftFigure from "./LiftFigure";
import Sheet from "./Sheet";

/**
 * Choosing the next lift: a sheet of its own, not a list squeezed under the
 * session (D27).
 *
 * On a phone it covers the screen, because that is the only way a search field,
 * a row of filters and more than two results fit above a keyboard; the system
 * back gesture closes it, like the camera and the menu. With a pointer it is a
 * dialog over the session, closed by Escape or the cross. The shell — focus,
 * the trap, Escape, the scrim — is `Sheet`'s, at its `full` size; what is here
 * is the picking.
 *
 * Your own lifts come first, most recently done first, each with what you
 * lifted last time — the lift you named is the one you do. The common ones
 * follow in the order a gym runs them. Every row leads with its drawing, still:
 * a list where every row moves at once is noise.
 */

/**
 * A keyboard and a pointer, not a phone with a mouse plugged in. The same test
 * as the CSS that draws the keyboard highlight, so "Enter picks the highlighted
 * row" only ever happens where the highlight can be seen.
 */
function hasKeys(): boolean {
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches
    && !window.matchMedia("(any-pointer: coarse)").matches;
}

export default function ExerciseSheet(p: {
  open: boolean;
  onClose: () => void;
  /** The session being written, so "last time" is not this time. */
  session: string | null;
  /** Name keys of the lifts already in it. */
  added: ReadonlySet<string>;
  onPick: (ref: ExerciseRef, hit: ExerciseHit | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [area, setArea] = useState<Area | null>(null);
  /** The results, and the query they answer — so a stale set is never acted on. */
  const [result, setResult] = useState<{ q: string; hits: ExerciseHit[] } | null>(null);
  const [hi, setHi] = useState(0);
  const [naming, setNaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const firstKindRef = useRef<HTMLButtonElement>(null);

  // A fresh sheet each time: yesterday's half-typed search is not today's lift.
  useEffect(() => {
    if (!p.open) return;
    setQuery("");
    setArea(null);
    setNaming(false);
    setHi(0);
    setResult(null);
  }, [p.open]);

  useEffect(() => {
    if (!p.open) return;
    let live = true;
    const q = query;
    const t = setTimeout(() => {
      findExercises(q, p.session)
        .then((h) => { if (live) { setResult({ q, hits: h }); setHi(0); } })
        .catch(() => { if (live) setResult({ q, hits: [] }); });
    }, q === "" ? 0 : 120);
    return () => { live = false; clearTimeout(t); };
  }, [query, p.session, p.open]);

  // A new filter is a new list; the highlight starts again at its top.
  useEffect(() => { setHi(0); }, [area]);

  // The kind-of-set question takes focus when it appears, so it is heard.
  useEffect(() => {
    if (naming) firstKindRef.current?.focus();
  }, [naming]);

  const hits = result?.hits ?? null;
  const fresh = result !== null && result.q === query;
  const shown = useMemo(
    () => (hits ?? []).filter((h) => area === null || areaFor(h.name) === area),
    [hits, area],
  );
  const own = shown.filter((h) => h.own);
  const common = shown.filter((h) => !h.own);
  const ordered = [...own, ...common];
  const trimmed = query.trim();
  const exact = (hits ?? []).some((h) => nameKey(h.name) === nameKey(trimmed));
  const canName = fresh && trimmed !== "" && !exact;
  const at = Math.min(hi, ordered.length - 1);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  function pick(h: ExerciseHit) {
    p.onPick({ id: h.id, name: h.name, load: h.load }, h);
  }

  /** The search field's own keys: move the highlight, and pick it. */
  function searchKeys(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((i) => Math.max(0, Math.min(ordered.length - 1, i + 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // On a phone there is no visible highlight to pick, so the keyboard's
      // own key only puts the keyboard away and leaves the results to tap.
      if (!hasKeys()) { inputRef.current?.blur(); return; }
      // Only results for what is in the field now: Enter typed before the
      // search caught up must not add whatever was first a moment ago.
      if (fresh && ordered[at]) pick(ordered[at]);
    }
  }

  const row = (h: ExerciseHit, i: number) => {
    const m = musclesFor(h.name);
    const detail = h.own && h.last_on
      ? `${humanDate(h.last_on)}: ${h.last_sets.map((s) => setText(s, h.load)).join(", ")}`
      : m ? mostlyLine(m) : LOADS.find((l) => l.id === h.load)?.label ?? "";
    const already = p.added.has(nameKey(h.name));
    return (
      <button
        key={`${h.own ? "own" : "common"}:${h.id ?? h.name}`}
        type="button"
        className="xrow"
        data-row={i}
        data-hi={i === at || undefined}
        onMouseEnter={() => setHi(i)}
        onClick={() => pick(h)}
      >
        <span className="xrow__tile" aria-hidden>
          <LiftFigure lift={h.name} still />
          {!artFor(h.name) && <BarbellGlyph />}
        </span>
        <span className="xrow__text">
          <span className="xrow__name">{h.name}</span>
          <span className="xrow__detail tnum">{detail}</span>
        </span>
        {already && <span className="xrow__added">In this session</span>}
      </button>
    );
  };

  const head = (
    <>
      <input
        ref={inputRef}
        className="field xsheet__search"
        type="search"
        enterKeyHint="search"
        value={query}
        placeholder="Search lifts"
        aria-label="Search lifts"
        onChange={(e) => { setQuery(e.target.value); setNaming(false); }}
        onKeyDown={searchKeys}
      />
      <div className="chips xsheet__areas" role="group" aria-label="Part of the body">
        <button type="button" className="chip" aria-pressed={area === null} onClick={() => setArea(null)}>All</button>
        {AREAS.map((a) => (
          <button type="button" key={a.id} className="chip" aria-pressed={area === a.id}
            onClick={() => setArea(area === a.id ? null : a.id)}>{a.label}</button>
        ))}
      </div>
    </>
  );

  return (
    <Sheet
      open={p.open}
      onClose={p.onClose}
      title="Add exercise"
      size="full"
      className="xsheet"
      bodyClassName="xsheet__list"
      head={head}
      // With keys the search is the way in. On a phone the keyboard would cover
      // the list a person may only want to browse, so the dialog itself takes
      // focus — which is what has it announced — and the search waits for a tap.
      initialFocus={() => (hasKeys() ? inputRef.current : null)}
    >
      <div ref={listRef}>
        {hits === null && <p className="xsheet__note">Loading lifts…</p>}

        {own.length > 0 && (
          <section className="xgroup" aria-label="Your lifts">
            <h3 className="xgroup__name">Yours</h3>
            {own.map((h, i) => row(h, i))}
          </section>
        )}

        {common.length > 0 && (
          <section className="xgroup" aria-label="Common lifts">
            <h3 className="xgroup__name">Common lifts</h3>
            {common.map((h, i) => row(h, own.length + i))}
          </section>
        )}

        {hits !== null && ordered.length === 0 && !canName && (
          <p className="xsheet__note">
            {area === null ? "No lifts yet." : "No lifts filed here match. Try All."}
          </p>
        )}

        {canName && (
          <div className="xnew">
            {naming ? (
              <div role="group" aria-labelledby="xnew-q">
                <p className="xnew__q" id="xnew-q">How is “{trimmed}” counted?</p>
                <div className="chips">
                  {LOADS.map((l, i) => (
                    <button type="button" key={l.id} className="chip" ref={i === 0 ? firstKindRef : undefined}
                      onClick={() => p.onPick({ id: null, name: trimmed, load: l.id as Load }, null)}>
                      {l.label}
                    </button>
                  ))}
                </div>
                <p className="xsheet__note xnew__note">Weights is kilograms and reps; bodyweight is reps; held is seconds.</p>
              </div>
            ) : (
              <button type="button" className="xnew__start" onClick={() => setNaming(true)}>
                Add “{trimmed}” as a new exercise
              </button>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** For a lift with no drawing — the user's own, or one the set lacks. */
export function BarbellGlyph() {
  return (
    <svg className="xrow__glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" aria-hidden>
      <path d="M3 12h18M6 8v8M18 8v8M4 10v4M20 10v4" />
    </svg>
  );
}
