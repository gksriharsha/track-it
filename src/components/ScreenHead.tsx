import type { ReactNode } from "react";

interface Props {
  title: string;
  /**
   * Where this screen closes to.
   *
   * Rendered on desktop only, and deliberately: on Android the system back
   * gesture already does this. Every navigation in this app writes a hash,
   * every hash is a WebView history entry, and the gesture drives that
   * history — so an in-app back button there is a second control for
   * something the platform already provides, spending the most valuable row
   * on the screen to do it. A pointer has no such gesture, which is the whole
   * reason this is not simply deleted. See `.head__back` in styles.css.
   */
  onBack?: () => void;
  /**
   * The screen's ONE primary action. Pass nothing when an empty state is
   * showing — its own button is that action, and two buttons doing the same
   * thing is two calls to action fighting over one intent.
   */
  action?: ReactNode;
}

/**
 * Every screen's title block, and the reason they now look alike.
 *
 * Before this, each screen improvised: three different back treatments (a bare
 * "‹ back" link wedged before the title, a quiet button pushed to the right, a
 * "Back to Library"), the subtitle baseline-aligned beside the title so it
 * wrapped into the heading on a phone, and the primary action anywhere in that
 * same wrapping row. Nothing was wrong in isolation and the whole was
 * incoherent — the eye had to find the title afresh on every screen.
 *
 * One shape now: an optional way back, then the title with at most one action
 * beside it.
 *
 * There is no subtitle any more, and that is on purpose. Every screen had one —
 * "what every percentage is measured against", "the proportions, not one batch
 * of it" — and twenty taglines under twenty titles were a good part of why the
 * app read as explanation before it read as a record. A subtitle that carried
 * real state ("4 weighed", "no other devices yet") has moved to the list or
 * the empty state it describes, which is where the eye is when it matters.
 * What a screen is FOR belongs one tap away, not printed over its content.
 */
export default function ScreenHead({ title, onBack, action }: Props) {
  return (
    <header className="head">
      {onBack && (
        <button className="head__back" onClick={onBack}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M14 6l-6 6 6 6" />
          </svg>
          Back
        </button>
      )}
      {/* When the action does not fit beside the title it wraps underneath,
          still right-aligned, rather than squeezing the title into an
          ellipsis to keep one row. */}
      <div className="head__row">
        <div className="head__text">
          <h1 className="head__title">{title}</h1>
        </div>
        {action && <div className="head__act">{action}</div>}
      </div>
    </header>
  );
}
