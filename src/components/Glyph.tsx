/*
  The few line drawings Today's rows lead with: one per sitting (keyed by the
  sitting's own name, so `<Glyph name={meal} />`), and the marks that say
  where a food came from. Drawn on a 24-unit grid in the current colour, so a
  tile sets their colour and nothing here does.
*/

const PATHS = {
  breakfast: "M4 18h16M7.5 18a4.5 4.5 0 0 1 9 0M12 7.6v2.4M5.9 11.3l1.6 1.4M18.1 11.3l-1.6 1.4",
  lunch: "M12 8.2a3.8 3.8 0 1 0 0 7.6a3.8 3.8 0 1 0 0-7.6M12 3.6v1.9M12 18.5v1.9M3.6 12h1.9M18.5 12h1.9M6.1 6.1l1.3 1.3M16.6 16.6l1.3 1.3M6.1 17.9l1.3-1.3M16.6 7.4l1.3-1.3",
  snack: "M5.5 9.5h10v4a4.5 4.5 0 0 1-4.5 4.5h-1a4.5 4.5 0 0 1-4.5-4.5zM15.5 10.6h1.3a2.3 2.3 0 0 1 0 4.6h-1.5M9 6.6c0-1 .9-1 .9-2M12.2 6.6c0-1 .9-1 .9-2",
  dinner: "M18.6 14.6A7 7 0 1 1 9.4 5.4a5.6 5.6 0 0 0 9.2 9.2z",
  /* A pot from the stove: a cook, or a recipe made at home. */
  pot: "M5 10.5h14v4a4.5 4.5 0 0 1-4.5 4.5h-5A4.5 4.5 0 0 1 5 14.5zM3.3 10.5h17.4M9.6 7.7c0-1.2 1.2-1.2 1.2-2.4M13.4 7.7c0-1.2 1.2-1.2 1.2-2.4",
  /* A carrier bag: ordered in, or eaten out. */
  bag: "M6 8.5h12l-1 11H7zM9.2 8.5V7a2.8 2.8 0 0 1 5.6 0v1.5",
  /* A price tag: a packet off a shelf. */
  tag: "M4.5 12.2V5.5h6.7l8.3 8.3-6.7 6.7zM8.3 8a1.2 1.2 0 1 0 0 2.4a1.2 1.2 0 1 0 0-2.4",
  tablet: "M12 3.5a5.5 5.5 0 0 1 5.5 5.5v6a5.5 5.5 0 0 1-11 0V9A5.5 5.5 0 0 1 12 3.5zM6.5 12h11",
  drop: "M12 3.9c3.1 4 5.1 6.7 5.1 9.4a5.1 5.1 0 0 1-10.2 0c0-2.7 2-5.4 5.1-9.4z",
  walk: "M13.2 2.9a1.7 1.7 0 1 0 0 3.4a1.7 1.7 0 1 0 0-3.4M10.4 20l2.1-5.5-2.5-2.5 1-4 2.9 2 2.6.7M12.5 14.5l2.3 5.5M11 8.1L8 9.8l-.7 3",
  lift: "M6.5 8v8M17.5 8v8M4 10v4M20 10v4M6.5 12h11",
  /* Food in general, for the + sheet's Food choice: no one sitting. */
  bowl: "M3.5 11.5h17a8.5 8.5 0 0 1-17 0zM9 19.5h6",
  /* Something done before, done again: a session repeated in one tap. */
  repeat: "M16.5 3.5l3 3-3 3M4.5 11.5v-1a4 4 0 0 1 4-4h11M7.5 20.5l-3-3 3-3M19.5 12.5v1a4 4 0 0 1-4 4h-11",
} as const;

export type GlyphName = keyof typeof PATHS;

export default function Glyph({ name, size = 20 }: { name: GlyphName; size?: number }) {
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}
