/**
 * Keep whatever is being typed into above the keyboard.
 *
 * On Android the app draws edge to edge, and an edge-to-edge window is not
 * resized when the keyboard opens: the page stays the full height with the
 * keys drawn over its bottom third, and the browser, which only ever scrolls
 * a field into view within the window it was given, sees nothing to do. A
 * field near the foot of a long form — an own food's ingredient list, say —
 * was typed into blind, under the keys.
 *
 * `MainActivity` reports the keyboard's height as `--sys-ime` on the root
 * element (zero when it is down, and zero everywhere but Android). Two things
 * follow from it. The page is given that much more room at its foot
 * (`.app` in styles.css), so there is somewhere to scroll to; and here, once
 * the keyboard is up, the focused field is scrolled — in whatever box scrolls
 * it, the page or a sheet — until it sits above the keys with a little air.
 * The same check runs when focus moves to another field with the keyboard
 * already up. A search whose matches appear under it (`data-results-below`)
 * goes to the top of that room instead, so the matches have somewhere to be.
 */

/** Air between the field and the keys, or the top of the visible box. */
const MARGIN = 16;

function px(name: string): number {
  const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Whether this element raises the system keyboard. A field with
 * `inputmode="none"` is typed into with the app's own keypad, which is part
 * of the page and never covers anything.
 */
function raisesKeyboard(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || el.inputMode === "none") return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    if (el.readOnly || el.disabled) return false;
    return ["text", "search", "number", "tel", "email", "password", "url"].includes(el.type);
  }
  return false;
}

/** The nearest box that scrolls this element, or null for the page itself. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    if ((s.overflowY === "auto" || s.overflowY === "scroll") && p.scrollHeight > p.clientHeight) return p;
    // Pinned in place (the search field over Add food's list): it already
    // sits where it is meant to, and scrolling the page would not move it.
    if (s.position === "fixed") return p;
  }
  return null;
}

function reveal(): void {
  const el = document.activeElement;
  if (!raisesKeyboard(el)) return;
  const ime = px("--sys-ime");
  if (ime <= 0) return;

  const box = scrollerOf(el);
  if (box !== null && getComputedStyle(box).position === "fixed") return;
  const view = box ? box.getBoundingClientRect() : { top: px("--sys-top"), bottom: window.innerHeight };
  const top = view.top + MARGIN;
  const bottom = Math.min(view.bottom, window.innerHeight - ime) - MARGIN;

  const r = el.getBoundingClientRect();
  let dy = 0;
  if (el.hasAttribute("data-results-below")) {
    // A search whose matches appear under it as they are typed: lifted to the
    // top of the room above the keys rather than just clear of them, or the
    // matches would land under the keyboard.
    if (r.top > top) dy = r.top - top;
    if (r.bottom - dy > bottom) dy = r.bottom - bottom;
  } else if (r.bottom > bottom) dy = r.bottom - bottom;
  // Taller than the room left above the keys: its top stays in view, which
  // is where typing starts.
  if (r.top - dy < top) dy = r.top - top;
  if (Math.abs(dy) < 1) return;
  if (box) box.scrollBy({ top: dy });
  else window.scrollBy({ top: dy });
}

/**
 * Just after: reading the field's position forces the layout the new height
 * implies, so there is no frame to wait for — and a timer, unlike an
 * animation frame, still runs in a WebView that is not painting yet.
 */
function revealSoon(): void {
  window.setTimeout(reveal, 30);
}

let installed = false;

/** Start keeping fields above the keyboard. Once per page; a second call does nothing. */
export function followKeyboard(): void {
  if (installed) return;
  installed = true;
  // The keyboard coming up, or changing height (a suggestion strip appearing):
  // `MainActivity` rewrites the root's inline style each time.
  let last = "";
  new MutationObserver(() => {
    const now = document.documentElement.style.getPropertyValue("--sys-ime");
    if (now === last) return;
    last = now;
    revealSoon();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  // Moving to another field with the keyboard already up: no height changes,
  // so nothing above fires.
  document.addEventListener("focusin", revealSoon);
}
