import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A sheet: what opens when something on the page is asked about.
 *
 * The app's one way of putting a layer over a screen, so that every figure, an
 * entry, an `(i)` and the lift picker open, close and hold focus the same way.
 * Its shell was the exercise picker's (D27), which had worked all of this out
 * for one sheet; lifted here so the next ones do not each work it out again,
 * slightly differently.
 *
 * On a phone it rises from the bottom edge and stops short of the top, so a
 * sliver of the screen it came from stays in view — that is what says it is
 * over the screen rather than a new one. `full` covers the screen, for a sheet
 * that needs the whole height above a keyboard (a search and its results).
 * Where there is a pointer it is a panel down the right-hand side of the
 * window instead, beside the page rather than on top of it, and `full` is a
 * dialog in the middle of the window.
 *
 * Open state belongs to the caller, and is meant to come from the hash (see
 * `useHashSheetValue`), so the Android back gesture closes the sheet rather
 * than leaving the screen under it. Rendered into the end of the document, so
 * a sheet opened over another sheet lands over it, and a transform on some
 * screen's container can never pin it inside that container.
 */
export default function Sheet(p: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** `full` covers a phone's screen; the default stops short of its top. */
  size?: "auto" | "full";
  /** On the outer layer, so an area (`xsheet`, heather) reaches everything in it. */
  className?: string;
  /**
   * Content that stays put above the scrolling body — a search field and its
   * filters. Ruled off from the body, since the body scrolls under it.
   */
  head?: ReactNode;
  bodyClassName?: string;
  /**
   * Where focus lands when the sheet opens. Nothing, or null back, and the
   * dialog itself takes it — which is what has a screen reader announce it,
   * without a keyboard springing up over what the sheet came to show.
   */
  initialFocus?: () => HTMLElement | null | undefined;
}) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  /** Where the press that ends in a click began: only a press AND release on the scrim closes. */
  const pressedScrim = useRef(false);
  const onCloseRef = useRef(p.onClose);
  onCloseRef.current = p.onClose;
  const focusRef = useRef(p.initialFocus);
  focusRef.current = p.initialFocus;

  // In, and back out to where it came from. Focus returns without a scroll:
  // closing is a step back in history, and the browser is already putting the
  // page back where it was.
  useEffect(() => {
    if (!p.open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = focusRef.current?.() ?? boxRef.current;
    target?.focus({ preventScroll: true });
    return () => {
      if (before && before.isConnected && before !== document.body) before.focus({ preventScroll: true });
    };
  }, [p.open]);

  // The page behind does not scroll while a sheet is up — counted, so a sheet
  // over a sheet does not hand the scroll back when only the top one goes.
  useEffect(() => {
    if (!p.open) return;
    lockScroll();
    return unlockScroll;
  }, [p.open]);

  /*
    Escape and Tab belong to the top sheet while it is up, wherever focus is.
    On the capture phase of the document, before App's own Escape — which would
    otherwise take a click on a heading followed by Escape as "leave Add food".
    Only the top sheet answers, so Escape takes sheets away one at a time, the
    order Back does.
  */
  useEffect(() => {
    if (!p.open) return;
    const me = Symbol("sheet");
    STACK.push(me);
    const onKey = (e: KeyboardEvent) => {
      const box = boxRef.current;
      if (!box || STACK[STACK.length - 1] !== me) return;
      // Focus inside some other modal layer — the ⌘K palette, opened over this
      // sheet — is that layer's to move and to close.
      const modal = document.activeElement?.closest('[aria-modal="true"]');
      if (modal && modal !== box) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "Tab") {
        const all = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)]
          .filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
        const first = all[0];
        const last = all[all.length - 1];
        if (!first || !last) { e.preventDefault(); return; }
        const inside = box.contains(document.activeElement);
        if (!inside || document.activeElement === box) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const at = STACK.indexOf(me);
      if (at !== -1) STACK.splice(at, 1);
    };
  }, [p.open]);

  if (!p.open) return null;

  const size = p.size ?? "auto";
  return createPortal(
    <div
      className={`sheet sheet--${size}${p.className ? ` ${p.className}` : ""}`}
      role="presentation"
      onPointerDown={(e) => { pressedScrim.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        // A press inside a sheet is not a press on whatever its owner sits in.
        // React carries a portal's events up its own tree, not the document's,
        // so without this a tap on an (i)'s sheet would also land on the row
        // the (i) belongs to — and open that row's sheet under it.
        e.stopPropagation();
        if (pressedScrim.current && e.target === e.currentTarget) p.onClose();
      }}
    >
      <div ref={boxRef} className="sheet__box" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className={p.head ? "sheet__head sheet__head--ruled" : "sheet__head"}>
          {/* The one affordance that says "this came up and can go back down",
              the drawer's own. Not on a sheet that covers the screen. */}
          {size === "auto" && <span className="sheet__grip" aria-hidden />}
          <div className="sheet__bar">
            <h2 id={titleId} className="sheet__title">{p.title}</h2>
            {/* Wherever there is a pointer — a Mac window of any width — since
                a pointer has no back gesture. Phones have one. */}
            <button type="button" className="sheet__close" aria-label="Close" onClick={p.onClose}>×</button>
          </div>
          {p.head}
        </div>
        <div className={p.bodyClassName ? `sheet__body ${p.bodyClassName}` : "sheet__body"}>
          {p.children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Everything Tab can land on. Selects, text areas and anything given a
 * `tabindex` as well as buttons and fields: the picker's trap knew only the two
 * it held, and a sheet holding a select would have let Tab walk out of it.
 */
const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), ' +
  'a[href], [tabindex]:not([tabindex="-1"])';

/** The open sheets, oldest first; only the last answers the keyboard. */
const STACK: symbol[] = [];

let locks = 0;
let overflowBefore = "";
function lockScroll(): void {
  if (locks === 0) {
    overflowBefore = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  locks += 1;
}
function unlockScroll(): void {
  locks = Math.max(0, locks - 1);
  if (locks === 0) document.body.style.overflow = overflowBefore;
}
