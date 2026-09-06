import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { searchFoods } from "../api";
import type { FoodHit } from "../types";
import { MOD } from "../lib/desktop";

/** One thing the palette can do. Destinations and actions are the same shape. */
export interface Command {
  id: string;
  label: string;
  /** What it is, in a few words. Never a restatement of the label. */
  hint?: string;
  group: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  /** Opens Add food on a query, which is what picking a food result does. */
  onSearchFood: (query: string) => void;
}

/**
 * ⌘K. A keyboard route to everything, and the reason the desktop build is
 * faster than the phone one rather than merely wider.
 *
 * It searches TWO things at once, which is the whole point: the five places
 * you navigate to, and the thirteen thousand foods. Logging is what this app is
 * for, and on a laptop "⌘K, urad dal, Enter" beats reaching for the sidebar,
 * clicking Add food, clicking the search field and typing — which is four
 * pointer trips for one thought.
 *
 * Food results are DEFERRED behind the commands rather than ranked against
 * them. A command list is a closed set the user can learn; search results are
 * an open one that changes with every keystroke, and letting a fuzzy food match
 * outrank "Today" would make the first row unpredictable — which is exactly
 * what a palette must never be, because the first row is what Enter runs.
 */
export default function CommandPalette(p: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FoodHit[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const q = query.trim();

  /** Commands whose label or hint contains what has been typed. */
  const matched = useMemo(() => {
    if (q === "") return p.commands;
    const needle = q.toLowerCase();
    return p.commands.filter(
      (c) =>
        c.label.toLowerCase().includes(needle) ||
        (c.hint ?? "").toLowerCase().includes(needle),
    );
  }, [p.commands, q]);

  /**
   * Food search, debounced. The palette is typed into fast, and firing a
   * query per keystroke would land the results out of order — the same reason
   * Foods itself carries a sequence number.
   */
  useEffect(() => {
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      searchFoods(q, 6)
        .then((r) => {
          if (mine === seq.current) setHits(r);
        })
        .catch(() => {
          // A failed lookup leaves the commands usable rather than emptying
          // the palette — navigation must not depend on the database.
          if (mine === seq.current) setHits([]);
        });
    }, 130);
    return () => clearTimeout(t);
  }, [q]);

  /** Everything Enter could run, in the order it is drawn. */
  const rows = useMemo(
    () => [
      ...matched.map((c) => ({ kind: "cmd" as const, cmd: c })),
      ...hits.map((h) => ({ kind: "food" as const, hit: h })),
    ],
    [matched, hits],
  );

  // A changed result set invalidates the highlight: row 4 of the old list is
  // a different thing from row 4 of the new one, and Enter must never run
  // something the user has not looked at.
  useEffect(() => {
    setActive(0);
  }, [q, hits.length]);

  useEffect(() => {
    if (p.open) {
      setQuery("");
      setHits([]);
      setActive(0);
      // After paint: the element does not exist to focus until the overlay is
      // in the document.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [p.open]);

  const run = useCallback(
    (i: number) => {
      const row = rows[i];
      if (!row) return;
      p.onClose();
      if (row.kind === "cmd") row.cmd.run();
      else p.onSearchFood(row.hit.description);
    },
    [rows, p],
  );

  /**
   * Arrow keys are handled on the input rather than on the window: the palette
   * owns them only while it is focused, and the page behind must keep its own
   * scrolling once it is closed.
   */
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      p.onClose();
    }
  }

  // Keep the highlight in view when the arrow keys walk past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!p.open) return null;

  let group: string | null = null;

  return (
    // The scrim closes on click, which is the pattern every palette shares —
    // and it is a div rather than a button because the dialog is nested inside
    // it and a button may not contain one.
    <div className="pal" onClick={p.onClose}>
      <div
        className="pal__box"
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pal__field">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="1.9" aria-hidden>
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4.5 4.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="pal__input"
            value={query}
            placeholder="Search foods, or jump to a screen"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Search foods, or jump to a screen"
            aria-autocomplete="list"
          />
          <kbd className="kbd">esc</kbd>
        </div>

        <div className="pal__list" ref={listRef} role="listbox" aria-label="Results">
          {rows.length === 0 ? (
            <p className="pal__none">
              Nothing matches “{q}”. Indian names work here too — <em>urad dal</em>,{" "}
              <em>besan</em>, <em>rava</em>.
            </p>
          ) : (
            rows.map((row, i) => {
              const heading = row.kind === "cmd" ? row.cmd.group : "Foods";
              const first = heading !== group;
              group = heading;
              const isActive = i === active;
              return (
                <div key={row.kind === "cmd" ? row.cmd.id : `f-${i}`}>
                  {first && <div className="pal__group">{heading}</div>}
                  <div
                    className="pal__row"
                    role="option"
                    aria-selected={isActive}
                    data-active={isActive}
                    onMouseMove={() => setActive(i)}
                    onClick={() => run(i)}
                  >
                    {row.kind === "cmd" ? (
                      <>
                        <span className="pal__label">{row.cmd.label}</span>
                        {row.cmd.hint && <span className="pal__hint">{row.cmd.hint}</span>}
                      </>
                    ) : (
                      <>
                        <span className="pal__label">{row.hit.description}</span>
                        <span className="pal__hint">
                          {row.hit.note ??
                            (row.hit.kind === "custom" ? "your own food" : row.hit.data_type)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="pal__foot">
          <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> move</span>
          <span><kbd className="kbd">↵</kbd> open</span>
          <span className="pal__footnote">{MOD}K from anywhere</span>
        </div>
      </div>
    </div>
  );
}
