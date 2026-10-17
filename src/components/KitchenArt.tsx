import type { ReactNode } from "react";
import type { Art } from "../lib/kitchen";

/*
 * The things on the kitchen's shelves, drawn on one 48 by 56 grid and
 * standing on its bottom edge, chosen by `guess` in lib/kitchen.ts. Fixed
 * strings rather than anything a person typed, so they go in as markup.
 */
const SK = 'stroke="var(--k-ink)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"';
const P = (d: string, f = "none") => `<path d="${d}" fill="${f}" ${SK}/>`;
const R = (x: number, y: number, w: number, h: number, rx: number, f: string, line = true) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${f}" ${line ? SK : ""}/>`;
const E = (cx: number, cy: number, rx: number, ry: number, f: string) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${f}" ${SK}/>`;
const C = (cx: number, cy: number, r: number, f: string) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${f}" ${SK}/>`;
const fill = "var(--k-fill)", deep = "var(--k-deep)", paper = "var(--k-paper)", kraft = "var(--k-kraft)";

const DRAW: Record<Art, string> = {
  jar: R(13, 9, 22, 7, 2.5, deep) + P("M12 16h24a4 4 0 0 1 4 4v30a5 5 0 0 1-5 5H13a5 5 0 0 1-5-5V20a4 4 0 0 1 4-4z", fill) + R(13, 29, 22, 12, 2, paper, false),
  jarLow: R(14, 21, 20, 6, 2, deep) + P("M13 27h22a4 4 0 0 1 4 4v19a5 5 0 0 1-5 5H14a5 5 0 0 1-5-5V31a4 4 0 0 1 4-4z", fill) + R(14, 36, 20, 9, 2, paper, false),
  jarTall: R(12, 3, 24, 7, 2.5, deep) + P("M11 10h26a4 4 0 0 1 4 4v36a5 5 0 0 1-5 5H12a5 5 0 0 1-5-5V14a4 4 0 0 1 4-4z", fill) + R(12, 22, 24, 15, 2, paper, false),
  spice: R(17, 29, 14, 6, 2, deep) + P("M17 35h14a3 3 0 0 1 3 3v13a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V38a3 3 0 0 1 3-3z", fill),
  bag: P("M10 13l2-6h24l2 6", kraft) + P("M10 13h28l3 37a5 5 0 0 1-5 5H12a5 5 0 0 1-5-5z", kraft) + P("M12 19h24") + R(14, 28, 20, 13, 2, fill, false),
  bag2: P("M11 16l2-5h22l2 5", paper) + P("M11 16h26l3 34a5 5 0 0 1-5 5H13a5 5 0 0 1-5-5z", paper) + `<circle cx="24" cy="36" r="7" fill="${deep}"/>` + P("M24 31v10M21 33.5l3 2 3-2M21 37.5l3 2 3-2"),
  box: R(11, 7, 26, 48, 3, paper) + P("M11 14h26") + `<circle cx="24" cy="33" r="8" fill="${fill}"/>`,
  tea: R(10, 22, 28, 33, 3, paper) + P("M10 28h28") + P("M18 48c0-8 6-12 13-12 0 8-5 12-13 12z", fill) + P("M18 48l8-7"),
  tin: R(10, 18, 28, 5, 2, deep) + P("M10 23h28v28a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4z", fill) + P("M10 28h28M10 50h28"),
  ghee: R(12, 8, 24, 6, 2, deep) + P("M11 14h26v37a4 4 0 0 1-4 4H15a4 4 0 0 1-4-4z", fill) + R(11.8, 26, 24.4, 14, 0, paper, false) + P("M11 26h26M11 40h26"),
  dispenser: `<path d="M24 14V8l11-4" fill="none" stroke="var(--k-ink)" stroke-width="2.2" stroke-linecap="round"/>` + R(18, 13, 12, 6, 2, deep) + P("M14 19h20v31a5 5 0 0 1-5 5H19a5 5 0 0 1-5-5z", fill) + P("M14 30h5M14 38h5M14 46h5"),
  squeeze: P("M14 6h20a3 3 0 0 1 3 3l-2 33H13l-2-33a3 3 0 0 1 3-3z", fill) + R(16, 42, 16, 13, 3, deep) + R(15, 16, 18, 12, 2, paper, false),
  carton: P("M19 8V5h10v3") + P("M13 18l6-10h10l6 10v34a3 3 0 0 1-3 3H16a3 3 0 0 1-3-3z", paper) + P("M13 18h22") + R(16, 27, 16, 14, 2, fill, false),
  eggs: E(14, 35, 5.5, 7.5, paper) + E(24, 34, 5.5, 7.5, paper) + E(34, 35, 5.5, 7.5, paper) + P("M5 41h38l-3 14H8z", kraft),
  tub: R(7, 26, 34, 5, 2, deep) + P("M9 31h30l-3 24H12z", paper) + R(14, 38, 20, 8, 2, fill, false),
  paneer: R(7, 36, 34, 19, 4, paper) + R(11, 40, 26, 11, 2, fill, false),
  tofu: R(9, 30, 30, 25, 4, fill) + P("M9 37h30") + R(15, 42, 18, 8, 2, paper, false),
  butter: P("M6 42l6-6h30l-6 6z", paper) + R(6, 42, 30, 13, 2, paper) + P("M36 42l6-6v13l-6 6z", fill),
  spinach: P("M24 55V38") + P("M24 42C14 40 9 28 13 15c9 4 13 15 11 27z", fill) + P("M24 42c10-2 15-14 11-27-9 4-13 15-11 27z", deep) + P("M24 40c-3-10-2-22 0-31 2 9 3 21 0 31z", fill) + R(20, 45, 8, 4, 1.5, paper),
  tomato: C(15, 46, 9, deep) + C(33, 45, 10, fill) + P("M15 37l-2-3M15 37l3-2M33 35l-2-3M33 35l3-2"),
  cucumber: P("M5 47c0-4 4-7 9-7h21c5 0 8 3 8 7s-3 7-8 7H14c-5 0-9-3-9-7z", deep) + `<path d="M13 46h1M20 49h1M27 45h1M33 48h1" stroke="var(--k-paper)" stroke-width="2" stroke-linecap="round"/>`,
  pot: R(21, 17, 6, 5, 2, deep) + P("M7 30c0-5 8-8 17-8s17 3 17 8z", deep) + P("M8 30h32v18a7 7 0 0 1-7 7H15a7 7 0 0 1-7-7z", fill) + `<path d="M8 35H3.5M40 35h4.5" stroke="var(--k-ink)" stroke-width="2.6" stroke-linecap="round"/>`,
  peas: P("M10 14l3-3 3 3 3-3 3 3 3-3 3 3 3-3 3 3 3-3 3 3v36a5 5 0 0 1-5 5H15a5 5 0 0 1-5-5z", paper) + C(19, 30, 3.2, deep) + C(27, 28, 3.2, deep) + C(23, 36, 3.2, deep) + C(30, 37, 3.2, deep) + C(18, 42, 3.2, deep),
};

export default function KitchenArt({ art, size = 40 }: { art: Art; size?: number }) {
  return (
    <svg className="kept" viewBox="0 0 48 56" width={size} height={Math.round((size * 56) / 48)} aria-hidden dangerouslySetInnerHTML={{ __html: DRAW[art] }} />
  );
}

/**
 * One thing on a shelf: its drawing standing on the shelf, and a label on the
 * shelf's edge with its name and when it was last used. A thing not used for a
 * while is greyed back rather than removed.
 */
export function Thing(p: { art: Art; name: string; line: ReactNode; old?: boolean; size?: number; j: number; onClick?: () => void }) {
  return (
    <button className={`thing${p.old ? " is-old" : ""}`} style={{ ["--j" as string]: p.j }} onClick={p.onClick}>
      <span className="thing__art"><KitchenArt art={p.art} size={p.size ?? 44} /></span>
      <span className="thing__tag"><b>{p.name}</b><span>{p.line}</span></span>
    </button>
  );
}

/** Things in rows of `per`, each row on its own shelf. */
export function Rows<T>(p: { items: T[]; per: number; glass?: boolean; render: (item: T, j: number) => ReactNode; start?: number }) {
  const rows: T[][] = [];
  for (let i = 0; i < p.items.length; i += p.per) rows.push(p.items.slice(i, i + p.per));
  let j = p.start ?? 0;
  return (
    <>
      {rows.map((row, i) => (
        <div key={i} className={`shelf-row${p.glass ? " shelf-row--glass" : ""}`} style={{ ["--i" as string]: i, ["--per" as string]: p.per }}>
          {row.map((item) => p.render(item, j++))}
        </div>
      ))}
    </>
  );
}
