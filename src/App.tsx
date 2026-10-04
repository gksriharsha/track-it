import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Today from "./screens/Today";
import Foods from "./screens/Foods";
import Nutrients from "./screens/Nutrients";
import Recipes from "./screens/Recipes";
import CookSheet from "./screens/CookSheet";
import History from "./screens/History";
import Library from "./screens/Library";
import You from "./screens/You";
import Vessels from "./screens/Vessels";
import Bottles from "./screens/Bottles";
import Pantry from "./screens/Pantry";
import ContainerHistory from "./screens/ContainerHistory";
import ContainerEditor from "./screens/ContainerEditor";
import CustomFoods from "./screens/CustomFoods";
import CustomFoodEditor from "./screens/CustomFoodEditor";
import Supplements from "./screens/Supplements";
import Profile from "./screens/Profile";
import Household from "./screens/Household";
import Statistics from "./screens/Statistics";
import Settings from "./screens/Settings";
import SupplementEditor from "./screens/SupplementEditor";
import ImportData from "./screens/ImportData";
import ExportData from "./screens/ExportData";
import Backup from "./screens/Backup";
import UnlockLog from "./components/UnlockLog";
import Logo from "./components/Logo";
import CommandPalette from "./components/CommandPalette";
import type { Command } from "./components/CommandPalette";
import LogSheet from "./components/LogSheet";
import { AnnounceProvider } from "./components/UndoBar";
import { MOD, isAndroid, useHotkeys } from "./lib/desktop";
import { announceHashMoved, setSheetNavigator, useHashSheet } from "./lib/hashSheet";
import { parseHash, planBack, planBackFrom, planLaunch, planReset, planTab } from "./lib/nav";
import type { HistoryOp } from "./lib/nav";
import { getDay, humanDate, shiftIso, takeWidgetLanding, todayIso } from "./api";
import type { DayView, Meal } from "./types";
import { parsePick } from "./types";
import "./styles.css";

/**
 * Adding is not here: it is an action wanted from every one of these places,
 * not a place of its own, so it is drawn as the bottom bar's raised centre
 * button on mobile (see `.bar__add`) and the sidebar's own primary button on
 * desktop — never a tab that would sit at equal weight beside things you
 * actually navigate *to*. Both open the same sheet, which asks food or
 * activity (LogSheet).
 *
 * Desktop's list. The phone's is `BAR_LEFT`/`BAR_RIGHT` below, and it is
 * deliberately shorter: five equal slots on a 390pt screen leaves no room for
 * the one control that matters most.
 */
const TABS = [
  { id: "today", label: "Today" },
  { id: "nutrients", label: "Nutrients" },
  { id: "history", label: "Days" },
  { id: "library", label: "Library" },
  { id: "you", label: "You" },
] as const;

/**
 * The phone's bottom bar: three places, one action, and the way to everything
 * else — in the row a thumb already rests in.
 *
 * This replaced a hamburger drawer that WAS the whole of the mobile
 * navigation. Eleven destinations behind one button cost three interactions to
 * reach any of them, gave no standing sense of where you were, and — because
 * the app opens on Trends, which is an aside rather than a tab — left the
 * screen every cold start lands on with no way to log food at all.
 *
 * Split around the add button rather than listed beside it, because the action
 * belongs in the middle: it is the thing the thumb finds without looking, and
 * putting it at one end would make it the fourth or the fifth item in a row
 * the eye reads left to right.
 */
const BAR_LEFT = [
  { id: "statistics", label: "Trends" },
  { id: "today", label: "Today" },
] as const;
const BAR_RIGHT = [{ id: "history", label: "Days" }] as const;

/** The three ids the bar carries, for the checks that ask "is this a root?". */
const BAR_IDS: readonly string[] = [...BAR_LEFT, ...BAR_RIGHT].map((t) => t.id);

/**
 * Where the bar itself does not belong.
 *
 * Each of these is a task rather than a place — a search being typed into, a
 * pack being transcribed, a pot being weighed, a spreadsheet being read. Every
 * one carries its own primary action at the foot of the screen, and a second
 * bar under it would be two rows of controls arguing about which is the way
 * out. They are left by finishing them, or by the system back gesture.
 */
const BAR_HIDDEN: readonly string[] = [
  "foods",
  "custom-food",
  "container-edit",
  "supplement",
  "cook",
  "import",
  "export",
];

/**
 * Desktop only (see `.sidebar` in styles.css — none of this renders below
 * 721px). "You" is excluded here for the same reason it sits below the main
 * list on desktop rather than beside it: the profile is reached occasionally,
 * not somewhere the day is spent, so it keeps the sidebar's quiet trailing
 * link instead of a fifth equal-weight row. Mobile has no such tier — a
 * bottom bar is either in it or not — so TABS itself carries all five there.
 */
const SIDEBAR_NAV = TABS.filter((t) => t.id !== "you");

/** One stroke-based glyph per destination, 24×24, matching the sidebar's icon size. */
const NAV_ICON: Record<string, ReactNode> = {
  today: (
    <>
      <circle cx="12" cy="12" r="7.2" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
    </>
  ),
  nutrients: <path d="M4.5 7.5h9M4.5 12h14M4.5 16.5h6" strokeLinecap="round" />,
  /* A calendar, not a clock. The screen is a month you tap a date in; a clock
     face promises elapsed time, which is what the row was called back when it
     said "History" and nobody could tell it from "Statistics". */
  history: (
    <>
      <rect x="3.8" y="5.2" width="16.4" height="15" rx="2.2" strokeLinejoin="round" />
      <path d="M3.8 9.6h16.4" strokeLinecap="round" />
      <path d="M8.4 3.2v3.6M15.6 3.2v3.6" strokeLinecap="round" />
    </>
  ),
  library: (
    <>
      <path d="M12 4l8 4-8 4-8-4z" strokeLinejoin="round" />
      <path d="M4 12l8 4 8-4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 16l8 4 8-4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  you: (
    <>
      <circle cx="12" cy="8.5" r="3.4" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" strokeLinecap="round" />
    </>
  ),
  /* The drawer's own rows. Same 24×24 grid and stroke discipline as the five
     above, because on mobile they sit in one list together. */
  /* A box plot, because that is literally what the screen draws: an axis, the
     middle half of the days as a box, and the median through it. A bar chart
     glyph would promise a different screen — and would be the generic choice
     for anything called "statistics". */
  statistics: (
    <>
      <path d="M3.5 12h17" strokeLinecap="round" />
      <rect x="8" y="7.5" width="8" height="9" rx="1.5" strokeLinejoin="round" />
      <path d="M12 6v12" strokeLinecap="round" />
    </>
  ),
  /* Two devices of different sizes, which is what a household is here — not a
     house. The screen is about what crosses between them. */
  household: (
    <>
      <rect x="3.5" y="5.5" width="7.5" height="13" rx="1.6" strokeLinejoin="round" />
      <rect x="14" y="9" width="6.5" height="9.5" rx="1.5" strokeLinejoin="round" />
    </>
  ),
  /* A book with a visible spine. The first draft put the spine line on the
     cover's own right edge, where it coincided with the border and the whole
     glyph read as an empty square at 20px. */
  recipes: (
    <>
      <path d="M6 5h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" strokeLinejoin="round" />
      <path d="M9 5v14" strokeLinecap="round" />
    </>
  ),
  "custom-foods": (
    <>
      <path d="M7 3.5h10a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z" strokeLinejoin="round" />
      <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" strokeLinecap="round" />
    </>
  ),
  supplements: (
    <>
      <path d="M6.5 8.5h11a3.5 3.5 0 0 1 0 7h-11a3.5 3.5 0 0 1 0-7z" strokeLinejoin="round" />
      <path d="M12 8.5v7" strokeLinecap="round" />
    </>
  ),
  vessels: (
    <>
      <path d="M6 9h12l-1 9.5a2 2 0 0 1-2 1.8H9a2 2 0 0 1-2-1.8z" strokeLinejoin="round" />
      <path d="M4.5 9h15" strokeLinecap="round" />
    </>
  ),
  pantry: (
    <>
      <path d="M8 3.8h8v2.8H8z" strokeLinejoin="round" />
      <path d="M8.6 6.6C7 7.6 6 9 6 11v7.2A1.8 1.8 0 0 0 7.8 20h8.4a1.8 1.8 0 0 0 1.8-1.8V11c0-2-1-3.4-2.6-4.4" strokeLinejoin="round" />
    </>
  ),
  bottles: (
    <>
      <path d="M10 3h4v3.2l2 2.6V20a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V8.8l2-2.6z" strokeLinejoin="round" />
      <path d="M8 13.5h8" strokeLinecap="round" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="8.5" r="3.4" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" strokeLinecap="round" />
    </>
  ),
  import: (
    <>
      <path d="M12 4v10M8.5 10.5L12 14l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 17v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2" strokeLinecap="round" />
    </>
  ),
  /* The same tray as `import`, with the arrow going the other way. Two glyphs
     that differ only in the direction of one stroke is the whole point: they
     are the same door, and nothing else about them should look different. */
  export: (
    <>
      <path d="M12 14V4M8.5 7.5L12 4l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 17v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2" strokeLinecap="round" />
    </>
  ),
  /* A cloud with the arrow going up into it. The screen is about one sealed
     file leaving the phone and coming back; a shield would promise a security
     panel and a database cylinder would describe the implementation. */
  backup: (
    <>
      <path d="M7.2 18.5a4 4 0 0 1-.3-8 5.4 5.4 0 0 1 10.3 1.1 3.5 3.5 0 0 1-.5 6.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 20.5v-7.8M9.2 15l2.8-2.8 2.8 2.8" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  /* Three dots, not a hamburger. A hamburger is the idiom for a panel that
     slides in from the screen's edge; this one rises out of the bar the button
     sits in, and the glyph should say "the rest of it" rather than "a drawer
     lives over there". */
  more: (
    <>
      <circle cx="5.6" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="18.4" cy="12" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
  /* Sliders, not a cogwheel. A six-spoke gear at 20px reads as a sunburst,
     and two tracks with a knob each say "settings" at any size. */
  settings: (
    <>
      <path d="M4 8.5h8M16.5 8.5H20M4 15.5h3.5M12 15.5h8" strokeLinecap="round" />
      <circle cx="14.2" cy="8.5" r="2.2" />
      <circle cx="9.8" cy="15.5" r="2.2" />
    </>
  ),
};

/**
 * What "More" opens: everything the bottom bar does not carry.
 *
 * It no longer repeats the bar's own destinations. While the drawer WAS the
 * navigation it had to list them, so the menu read as a complete map rather
 * than an overflow bin; now that Trends, Today and Days are permanently on
 * screen, listing them again would be four rows telling you about buttons you
 * can already see. Nutrients has gone too — it is a view of the day, opened
 * as a sheet from the day's energy line on Today, not a place of its own.
 *
 * What is left is eleven things you go looking for deliberately, in the two
 * groups they divide into: the kitchen you have built up, and the app's
 * settings. Each is named for what you would say out loud. "Vessels" and
 * "Bottles" were this app's own words for a weighed-empty bowl and a
 * weighed-full bottle; nobody opens a menu looking for a vessel.
 */
const DRAWER_GROUPS: readonly { heading: string | null; items: readonly { id: string; label: string }[] }[] = [
  {
    heading: "Your kitchen",
    items: [
      { id: "recipes", label: "Recipes" },
      { id: "custom-foods", label: "Foods you added" },
      { id: "pantry", label: "Pantry" },
      { id: "supplements", label: "Supplements" },
      { id: "vessels", label: "Bowls & plates" },
      { id: "bottles", label: "Water bottles" },
    ],
  },
  {
    heading: "Your account",
    items: [
      { id: "profile", label: "About you" },
      { id: "settings", label: "Targets & goals" },
      { id: "household", label: "Your devices" },
      { id: "import", label: "Import" },
      { id: "export", label: "Export" },
      // Android only. SQLCipher is compiled into the Android build alone and
      // Google's Auto Backup exists nowhere else, so on a desktop this is not
      // a destination that is merely empty — it is one that does not exist.
      ...(isAndroid() ? [{ id: "backup", label: "Backup" }] : []),
    ],
  },
];

/** Every id the drawer can reach — what lights "More" while you are on one. */
const DRAWER_IDS: readonly string[] = DRAWER_GROUPS.flatMap((g) => g.items.map((i) => i.id));

/**
 * Routable, but deliberately not tabs. Add food is wanted from everywhere, not
 * navigated to, so it is the floating button's/sidebar CTA's destination
 * rather than a nav row; Recipes, the vessel library and the two transcription
 * screens are all reached by browsing Library or mid-task from Foods itself;
 * the importer and the profile screens are reached from You. None of them
 * stand permanently alongside Today and Nutrients.
 */
const ASIDES = [
  "foods",
  "recipes",
  "cook",
  "vessels",
  "bottles",
  "pantry",
  "container",
  "container-edit",
  "custom-foods",
  "custom-food",
  "supplements",
  "supplement",
  "import",
  "export",
  "profile",
  "household",
  "statistics",
  "settings",
  "backup",
] as const;

type Tab = (typeof TABS)[number]["id"] | (typeof ASIDES)[number];

/** What each destination is for, in the command palette's own second column. */
const TAB_HINT: Record<string, string> = {
  statistics: "how the last few weeks have gone",
  today: "what you have eaten today",
  nutrients: "every nutrient, and what was not measured",
  history: "pick a day, or average a period",
  library: "recipes, your foods, vessels",
  you: "profile, targets, import and export",
};

/**
 * Where each aside returns to when Escape closes it and nothing recorded
 * where it was opened from — a reload landing straight on one, say. These
 * mirror the `route.from ?? …` fallbacks each screen already passes.
 */
const ASIDE_HOME: Record<string, Tab> = {
  foods: "today",
  recipes: "library",
  cook: "recipes",
  vessels: "foods",
  bottles: "foods",
  pantry: "library",
  container: "pantry",
  "container-edit": "pantry",
  "custom-foods": "foods",
  "custom-food": "custom-foods",
  supplements: "foods",
  supplement: "supplements",
  import: "history",
  export: "you",
  profile: "you",
  household: "you",
  statistics: "statistics",
  settings: "you",
  backup: "you",
};

const ROUTES: readonly string[] = [...TABS.map((t) => t.id), ...ASIDES];

/**
 * A screen, plus the two things a screen sometimes needs to know that must not
 * live in memory: which record it is on, and where it came from.
 */
interface Route {
  tab: Tab;
  /** The custom food being edited, or null for a new one. */
  id: string | null;
  /** Where an aside returns to when it closes, when that is not its default. */
  from: Tab | null;
  /**
   * A search to open Add food on, from the command palette.
   *
   * In the hash for the same reason the editor's id is: ⌘K is the fastest way
   * into a search, and a reload or an Android back gesture landing on a blank
   * search field would throw away the one thing the user had typed.
   */
  q: string | null;
  /**
   * A food an Android home-screen widget handed over, as `"<kind>:<id>"` — or
   * the literal `"water"` for the bottle tab.
   *
   * In the hash for the same reason `q` is: a widget tap is the fastest way
   * into logging a staple, and a reload or a back gesture landing on a blank
   * Add food screen would throw away the one thing the tap was for. Read by
   * `Foods`, which parses it — never spliced into a hash by hand.
   */
  pick: string | null;
  /**
   * A barcode read off a pack, on its way to the custom-food editor.
   *
   * In the hash for the reason `q` and `pick` are: reading a code off a packet
   * is work the user has already done, and a reload or a back gesture landing
   * on an editor that had thrown it away would ask them to hold the pack up
   * twice for one food.
   */
  code: string | null;
  /**
   * Whether the mobile drawer is open.
   *
   * In the hash, not in state, for the reason everything else here is: on
   * Android the back gesture drives WebView history, and a drawer held in
   * state would leave Back to exit the app while a menu was covering the
   * screen. As a hash param, Back closes the drawer — which is what a person
   * who just opened it expects the gesture to do.
   */
  menu: boolean;
}

/** Where to go, and what the destination should carry in the hash. */
interface Nav {
  id?: string | null;
  from?: Tab;
  q?: string;
  /** A widget's pick token, on its way to `Foods`. See `Route.pick`. */
  pick?: string;
  /** A scanned barcode, on its way to the custom-food editor. See `Route.code`. */
  code?: string;
  /**
   * A sheet to arrive with open, read by the screen that owns it (see
   * `useHashSheetValue`): the + sheet's water row lands on Today's water sheet.
   */
  sheet?: string;
  /**
   * Overwrite the current history entry instead of pushing a new one.
   *
   * For a screen that takes the place of the one showing rather than sitting
   * on it: a drawer row over the open drawer, the + sheet's choice over the
   * sheet, profile and targets swapping for each other, a new container over
   * its saved editor. Pushing would leave the thing replaced one Back away.
   */
  replace?: boolean;
}

/**
 * Hash routing rather than in-memory state.
 *
 * Android's back gesture drives WebView session history, so a screen change
 * has to be a history entry or Back exits the app instead of going back a
 * screen. Hash also survives a reload under the Tauri asset protocol.
 *
 * The editor's target id goes in the hash for exactly those two reasons: held
 * in state it would survive neither, and reopening a reloaded editor on the
 * wrong food — or on a blank new one — would overwrite or lose a transcription.
 */
function readRoute(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const cut = raw.indexOf("?");
  const path = cut === -1 ? raw : raw.slice(0, cut);
  const params = new URLSearchParams(cut === -1 ? "" : raw.slice(cut + 1));
  const from = params.get("from");
  return {
    /*
      The front door is the aggregate, not the day.

      Every cold start used to land on a single day with the largest number in
      the app at the top of it. A day is a noisy sample — a festival, a travel
      day, an ordinary Tuesday — and opening on it every time is what turns a
      record into a thing to check. Statistics answers the question a person
      actually has between meals, which is how the last few weeks have gone.

      Logging is not made harder by this: the add-food button floats over every
      screen, and Today is one row away in the drawer.
    */
    tab: (ROUTES.includes(path) ? path : "statistics") as Tab,
    id: params.get("id"),
    from: from !== null && ROUTES.includes(from) ? (from as Tab) : null,
    q: params.get("q"),
    pick: params.get("pick"),
    code: params.get("code"),
    menu: params.get("menu") === "1",
  };
}

/**
 * How deep into the app this history entry is, stamped into `history.state`.
 *
 * `history.length` cannot answer "is there anywhere to go back to": it counts
 * entries but does not shrink when you go back, so at the very first entry it
 * still reads greater than one and Back would appear to have somewhere to go.
 * A depth ON the entry is exact — zero means this is where the app opened.
 */
function depthOf(): number {
  const st = window.history.state as { d?: number } | null;
  return typeof st?.d === "number" ? st.d : 0;
}

/** The hash a route is written as. Built here only, so nothing splices one by hand. */
function hashOf(t: Tab, nav: Nav = {}): string {
  const q = new URLSearchParams();
  if (nav.id) q.set("id", nav.id);
  if (nav.from) q.set("from", nav.from);
  if (nav.q) q.set("q", nav.q);
  if (nav.pick) q.set("pick", nav.pick);
  if (nav.code) q.set("code", nav.code);
  if (nav.sheet) q.set("sheet", nav.sheet);
  const s = q.toString();
  return s ? `#/${t}?${s}` : `#/${t}`;
}

/** The ways the app moves through history. See `lib/nav.ts` for the rule. */
interface Navigation {
  route: Route;
  /** Open a screen over this one, or write over this one with `replace`. */
  go: (t: Tab, nav?: Nav) => void;
  /**
   * Leave this screen for the one that opened it, `steps` entries back —
   * counted from `at`, the depth of the screen asking, when it is given (see
   * `planBackFrom`), or from wherever history stands when it runs.
   */
  back: (steps?: number, fallback?: Tab, at?: number) => void;
  /** A bar or sidebar destination: Trends alone, or Trends and the tab. */
  tab: (t: Tab) => void;
  /** Trends, then exactly what is given: where a log or a widget lands. */
  reset: (screens: readonly { t: Tab; nav?: Nav }[]) => void;
  openMenu: () => void;
  closeMenu: () => void;
  /**
   * Something not held in history that Back should close first — the command
   * palette. Returns true when it closed something.
   */
  backGuard: { current: (() => boolean) | null };
  /** The depth of the entry on screen, as of this render. */
  depth: number;
}

function useHashRoute(): Navigation {
  const [route, setRoute] = useState<Route>(readRoute);
  const [shownDepth, setShownDepth] = useState(depthOf);
  /** The depth of the entry currently showing. Mirrors `history.state.d`. */
  const depth = useRef(0);
  /**
   * Plans waiting their turn, each worked out only when it runs, against the
   * depth history has by then. A plan computed early against a depth a walk
   * is about to change would write its entries in the wrong place.
   */
  const queue = useRef<(() => HistoryOp[])[]>([]);
  /**
   * A walk back is under way: the depth it is going to, and what to write
   * once it gets there. The depth is what tells its landing apart from a
   * late event left over from the walk before it — a traversal fires popstate
   * at once but queues its hashchange, and by the time that arrives the next
   * walk may already have set off.
   */
  const walking = useRef<{ target: number; rest: HistoryOp[] } | null>(null);
  const watchdog = useRef<number | undefined>(undefined);
  const backGuard = useRef<(() => boolean) | null>(null);

  /**
   * Carry out a plan from `ops`, stopping at a walk.
   *
   * A walk is answered by popstate some time later, and the entries after it
   * belong on the entry it reaches, so the rest of the plan waits in
   * `walking` until `sync` hears that it has landed. Everything else is
   * `replaceState`/`pushState`, which take effect at once and fire nothing —
   * so the route is re-read here and the sheet holders told.
   */
  const present = useCallback(() => {
    setRoute(readRoute());
    setShownDepth(depth.current);
  }, []);

  const apply = useCallback((ops: HistoryOp[]) => {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.kind === "walk") {
        walking.current = { target: depth.current + op.by, rest: ops.slice(i + 1) };
        // A walk the browser never answers would hold every later move — a
        // go() past the first entry, which Android's WebView ignores. In that
        // case the rest is written where history stands, which shows the
        // right screen even if what lies behind it is not tidy.
        window.clearTimeout(watchdog.current);
        watchdog.current = window.setTimeout(() => {
          const w = walking.current;
          if (w === null) return;
          walking.current = null;
          depth.current = depthOf();
          apply(w.rest);
          drain();
        }, 1500);
        window.history.go(op.by);
        return;
      }
      if (op.kind === "replace") window.history.replaceState({ d: op.d }, "", op.hash);
      else window.history.pushState({ d: op.d }, "", op.hash);
      depth.current = op.d;
    }
    present();
    announceHashMoved();
    // `drain` is declared below and only reads refs, so the closure is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drain = useCallback(() => {
    while (walking.current === null && queue.current.length > 0) {
      const plan = queue.current.shift() as () => HistoryOp[];
      apply(plan());
    }
  }, [apply]);

  /** Run a plan now, or after whatever is already under way. */
  const perform = useCallback((plan: () => HistoryOp[]) => {
    queue.current.push(plan);
    drain();
  }, [drain]);

  // Stamp the entry the app booted on, so the first Back can tell that there is
  // nothing behind it and let Android close the app — and if the page opened
  // somewhere other than Trends, put Trends under it. A second run (StrictMode)
  // finds the work done: the depth is no longer 0.
  useEffect(() => {
    if ((window.history.state as { d?: number } | null)?.d === undefined) {
      window.history.replaceState({ d: 0 }, "");
    }
    depth.current = depthOf();
    perform(() => planLaunch(depth.current, window.location.hash));
  }, [perform]);

  useEffect(() => {
    const sync = () => {
      const st = window.history.state as { d?: number } | null;
      if (st?.d === undefined) {
        // An entry pushed by a plain `location.hash = …`. Nothing in the app
        // writes one any more, but a stamp keeps the count true if something
        // ever does: an unstamped entry would read as depth 0 and close the
        // app on Back.
        depth.current += 1;
        window.history.replaceState({ d: depth.current }, "");
      } else {
        depth.current = st.d;
      }
      const w = walking.current;
      if (w !== null) {
        // Only the walk's own landing finishes it. Anything else — the
        // hashchange of the walk before, which arrives after its popstate —
        // leaves it walking.
        if (depth.current !== w.target) return;
        walking.current = null;
        window.clearTimeout(watchdog.current);
        apply(w.rest);
        drain();
        return;
      }
      present();
    };
    // Both fire for a hash change, and going back fires popstate first. Once a
    // walk is finished, the second call only re-reads the same route.
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, [apply, drain, present]);

  const back = useCallback((steps = 1, fallback: Tab = "statistics", at?: number) => {
    perform(() => (at === undefined
      ? planBack(depth.current, steps, hashOf(fallback))
      : planBackFrom(depth.current, at, steps, hashOf(fallback))));
  }, [perform]);

  // Sheets move history through the same queue. See `setSheetNavigator`.
  useEffect(() => {
    setSheetNavigator({
      push: (make) => perform(() => {
        const hash = make();
        return hash === null ? [] : [{ kind: "push", d: depth.current + 1, hash }];
      }),
      back: (stillOpen) => perform(() => (stillOpen() ? planBack(depth.current, 1, hashOf("statistics")) : [])),
    });
    return () => setSheetNavigator(null);
  }, [perform]);

  /**
   * The Android back gesture, answered by the app instead of by the WebView.
   *
   * `MainActivity.kt` calls this and closes the app when it does not get back a
   * literal `true`. Every screen change here is a hash change, which the
   * WebView's native back-forward list never records — so `canGoBack()`, which
   * is what Wry asks by default, always says no and Back closed the app from
   * every screen.
   *
   * Anything above depth zero has somewhere to go back to, and depth zero is
   * Trends. A gesture while a move is still under way is swallowed rather than
   * stacked on top of it: the screen it was aimed at is about to change.
   */
  useEffect(() => {
    const w = window as unknown as { __androidBack?: () => boolean };
    w.__androidBack = () => {
      if (backGuard.current?.()) return true;
      if (walking.current !== null || queue.current.length > 0) return true;
      if (depth.current > 0) {
        back();
        return true;
      }
      return false;
    };
    return () => { delete w.__androidBack; };
  }, [back]);

  const go = useCallback((t: Tab, nav: Nav = {}) => {
    perform(() => [
      nav.replace
        ? { kind: "replace", d: depth.current, hash: hashOf(t, nav) }
        : { kind: "push", d: depth.current + 1, hash: hashOf(t, nav) },
    ]);
  }, [perform]);

  const tab = useCallback((t: Tab) => {
    perform(() => planTab(depth.current, window.location.hash, t));
  }, [perform]);

  const reset = useCallback((screens: readonly { t: Tab; nav?: Nav }[]) => {
    perform(() => planReset(depth.current, screens.map((x) => hashOf(x.t, x.nav))));
  }, [perform]);

  /**
   * Open the drawer by adding `menu=1` to the hash the app is already on.
   *
   * Rewriting the whole hash would be wrong: an editor's `id` and a search's
   * `q` live there too, and opening a menu must not drop the food being
   * transcribed or the query just typed. Trends' own entry has an empty path
   * on a cold start, and the drawer opened there sits over Trends.
   */
  const openMenu = useCallback(() => {
    perform(() => {
      const { path, params } = parseHash(window.location.hash);
      params.set("menu", "1");
      return [{ kind: "push", d: depth.current + 1, hash: `#/${path || "statistics"}?${params.toString()}` }];
    });
  }, [perform]);

  /**
   * Close it by going BACK, so the button, the scrim and the system gesture all
   * do one thing and leave no forward entry behind.
   *
   * A reload with `menu=1` still in the hash is the exception: there is no
   * entry of ours to pop, and going back then would leave the app. That case
   * rewrites the hash in place instead.
   */
  const closeMenu = useCallback(() => {
    perform(() => {
      if (depth.current > 0) return [{ kind: "walk", by: -1 }];
      const { path, params } = parseHash(window.location.hash);
      params.delete("menu");
      const s = params.toString();
      return [{ kind: "replace", d: 0, hash: `#/${path || "statistics"}${s ? `?${s}` : ""}` }];
    });
  }, [perform]);

  return { route, go, back, tab, reset, openMenu, closeMenu, backGuard, depth: shownDepth };
}

/**
 * The app, inside the one thing every screen shares: the bar that says what was
 * just written and offers the way back (see UndoBar.tsx). Outside the shell so
 * that it outlives any one screen — an Undo is still there after a tap away.
 */
export default function App() {
  return (
    <AnnounceProvider>
      <Shell />
    </AnnounceProvider>
  );
}

function Shell() {
  const { route, go, back: backBy, tab: toTab, reset, openMenu, closeMenu, backGuard, depth: here } = useHashRoute();
  const tab = route.tab;
  /*
    Every way out of a screen steps back from that screen, not from wherever
    history happens to be when the step runs. A Save that finishes after a
    Back pressed while it was saving has nothing more to do, and one that
    finishes with a camera opened over the form closes both. `here` is the
    depth of the screen this render drew, so each callback carries its own.
  */
  const back = (steps = 1, fallback: Tab = "statistics") => backBy(steps, fallback, here);

  /*
    A tap on an Android home-screen widget, landed on the right screen.

    Two arrivals and one destination. A COLD start's Intent exists long before
    this component mounts, so `MainActivity` writes it to a file and this pulls
    it here — after mount, where writing a hash always takes. A WARM relaunch
    goes the other way: the page is already up, so `MainActivity` pokes
    `window.__widgetTap` and we pull again. The poke carries no data at all,
    only the news that there is something to take, which keeps the Intent's
    untrusted strings out of JavaScript entirely.

    The route is validated here as well as in Kotlin and in Rust. MainActivity
    is exported because it carries LAUNCHER, so any installed app can start it
    with an extra of its choosing — and `go` is given the pick as a value
    rather than having it concatenated into a hash, so a token that got this far
    still cannot become part of a URL it was not designed for.
  */
  useEffect(() => {
    const land = async () => {
      try {
        const l = await takeWidgetLanding();
        if (l === null || !ROUTES.includes(l.route)) return;
        const pick = parsePick(l.pick);
        // A widget is a front door, like the launcher icon: whatever was on
        // screen gives way, and Trends stands behind where it lands. A form
        // left open keeps its draft (see each editor's own draft store); the
        // tap is the person saying where they want to be now.
        if (l.route === "statistics") toTab("statistics");
        else reset([{ t: l.route as Tab, nav: pick === null ? {} : { pick: l.pick as string } }]);
      } catch {
        // Silence, not an alert. The app has simply opened on its usual front
        // door, which is where it opens anyway.
      }
    };
    const w = window as unknown as { __widgetTap?: () => void };
    w.__widgetTap = () => { void land(); };
    void land();
    return () => { delete w.__widgetTap; };
  }, [toTab, reset]);
  const [date, setDate] = useState(todayIso());
  const [meal, setMeal] = useState<Meal>(defaultMeal());

  /*
    The bar's + and the sidebar's Add: one sheet that asks food or activity
    (LogSheet). A hash param like every sheet, so Back closes it.
  */
  const logSheet = useHashSheet("sheet", "log");
  const { show: showLog } = logSheet;
  const openLog = useCallback(() => {
    // The sitting its foods go into is the one the clock says, each time it
    // opens. The app's meal is whichever was chosen last, which by the evening
    // can be the morning's.
    setMeal(defaultMeal());
    showLog();
  }, [showLog]);
  const [day, setDay] = useState<DayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Whether the log is open. Only ever false on Android, and only in two
   * situations — see `UnlockLog`, which decides which and then draws the way
   * through. Everything else on this page waits: a locked session's database
   * connection is deliberately empty, so drawing Today over it would show a
   * missing-table error where a day should be.
   */
  const [opened, setOpened] = useState(false);

  const refresh = useCallback(async (iso: string) => {
    try {
      setDay(await getDay(iso));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!opened) return;
    setLoading(true);
    refresh(date);
  }, [date, refresh, opened]);

  /*
    Re-read the day being shown NOW, whichever that is. For a write whose
    consequences arrive later than the screen that made it: an Undo pressed in
    the bar after the date has moved on must re-read the day on screen, not set
    it to the day the bar was raised on under a heading that says another.
  */
  const dateNow = useRef(date);
  dateNow.current = date;
  const refreshShown = useCallback(() => refresh(dateNow.current), [refresh]);

  /*
    Logged: the day it went into, with only Trends behind it. The + sheet, the
    search and the amount that led here are gone from history, so Back from
    Today goes to Trends and can never reopen any of them (see lib/nav.ts).
    The move comes before the re-read, so a Back pressed while the day loads
    acts on Today rather than on the search it is leaving.
  */
  const onLogged = useCallback(() => {
    reset([{ t: "today" }]);
    void refresh(date);
  }, [date, refresh, reset]);

  /**
   * The three screens that sit over Add food. Foods stays mounted behind all of
   * them for the same reason: each is reached mid-task, from a search that is
   * still worth something when you come back.
   */
  const overFoods =
    // The cook sheet is reached from Available to correct a pot mid-log, which
    // is the same mid-task detour as the others: the search and the weight
    // being entered are still worth something on the way back.
    tab === "cook" ||
    tab === "vessels" ||
    tab === "custom-foods" ||
    tab === "custom-food" ||
    tab === "supplements" ||
    tab === "supplement";

  /**
   * Whether the phone's bottom bar belongs on screen — everywhere except the
   * handful of screens that are a task rather than a place. See `BAR_HIDDEN`.
   */
  const showBar = !BAR_HIDDEN.includes(tab);
  /** Lights "More" while you are on one of the places it leads to. */
  const inDrawer = DRAWER_IDS.includes(tab) || tab === "container" || tab === "container-edit";

  // Shared by Today's own props and the desktop toolbar's date-stepper, so
  // the two surfaces can never disagree about what "today" or "forward" mean.
  const canGoForward = date < todayIso();
  const goPrevDay = () => setDate(shiftIso(date, -1));
  const goNextDay = () => setDate(shiftIso(date, 1));
  const goToday = () => setDate(todayIso());
  const todayEntries = day?.entries ?? [];

  /* ── the keyboard, which is the desktop's real input device ──────────────
     Every shortcut carries the platform command modifier. Bare letters are
     deliberately unused: this app has a search field on most screens and a
     text field that swallows "n" is worse than no shortcut at all. */

  const [palOpen, setPalOpen] = useState(false);

  /**
   * Everything ⌘K can reach. Destinations first, then the actions that are
   * not places — the same distinction the sidebar already draws between its
   * four nav rows and its one primary button.
   */
  /** An aside from the palette, unless it is the screen already showing. */
  const open = (t: Tab, nav: Nav = {}) => {
    const here = tab === t && route.id === (nav.id ?? null) && route.pick === (nav.pick ?? null)
      && route.q === (nav.q ?? null);
    if (here) return;
    go(t, nav);
  };

  const commands: Command[] = [
    { id: "go-statistics", label: "Trends", hint: TAB_HINT.statistics, group: "Go to", run: () => toTab("statistics") },
    ...TABS.map((t) => ({
      id: `go-${t.id}`,
      label: t.label,
      hint: TAB_HINT[t.id],
      group: "Go to",
      run: () => toTab(t.id),
    })),
    { id: "add", label: "Add food", hint: "search, weigh and log", group: "Do", run: () => open("foods") },
    { id: "add-activity", label: "Add activity", hint: "a walk, a class, a gym session", group: "Do", run: () => open("foods", { pick: "activity" }) },
    { id: "prev", label: "Previous day", hint: humanDate(shiftIso(date, -1)), group: "Do", run: () => { setDate(shiftIso(date, -1)); toTab("today"); } },
    ...(canGoForward
      ? [{ id: "next", label: "Next day", hint: humanDate(shiftIso(date, 1)), group: "Do", run: () => { setDate(shiftIso(date, 1)); toTab("today"); } }]
      : []),
    ...(canGoForward
      ? [{ id: "back-today", label: "Back to today", hint: humanDate(todayIso()), group: "Do", run: () => { setDate(todayIso()); toTab("today"); } }]
      : []),
    { id: "recipes", label: "Recipes", hint: "dishes you cook repeatedly", group: "Library", run: () => open("recipes", { from: "library" }) },
    { id: "own", label: "Foods you added", hint: "transcribed from a pack", group: "Library", run: () => open("custom-foods", { from: "library" }) },
    { id: "sups", label: "Supplements", hint: "taken by count, not by weight", group: "Library", run: () => open("supplements", { from: "library" }) },
    { id: "vessels", label: "Bowls & plates", hint: "weighed empty once", group: "Library", run: () => open("vessels", { from: "library" }) },
    { id: "bottles", label: "Water bottles", hint: "weighed full once", group: "Library", run: () => open("bottles", { from: "library" }) },
    { id: "pantry", label: "Pantry", hint: "salt, oil and the rest, read by the jar", group: "Library", run: () => open("pantry", { from: "library" }) },
    { id: "new-own", label: "Transcribe a new food", hint: "from the pack in front of you", group: "Library", run: () => open("custom-food", { from: "custom-foods" }) },
    { id: "profile", label: "About you", hint: "who the figures are for", group: "Settings", run: () => open("profile", { from: "you" }) },
    { id: "targets", label: "Targets & goals", hint: "what every figure is read against", group: "Settings", run: () => open("settings", { from: "you" }) },
    { id: "import", label: "Import", hint: "a log you kept elsewhere", group: "Settings", run: () => open("import", { from: "you" }) },
    { id: "export", label: "Export", hint: "a spreadsheet you keep", group: "Settings", run: () => open("export", { from: "you" }) },
    { id: "household", label: "Your devices", hint: "the others in this kitchen", group: "Settings", run: () => open("household", { from: "you" }) },
    // Filtered out rather than disabled off Android, for the same reason the
    // drawer item is: a palette entry that cannot go anywhere is worse than an
    // absent one.
    ...(isAndroid()
      ? [{ id: "backup", label: "Backup", hint: "one sealed file, carried by Google", group: "Settings", run: () => open("backup", { from: "you" }) }]
      : []),
  ];

  /*
    The palette is held in state rather than in history, so Back has to be
    told about it: on a tablet it opens by touch, and the gesture should close
    it rather than take the screen from under it.
  */
  backGuard.current = () => {
    if (!palOpen) return false;
    setPalOpen(false);
    return true;
  };

  /*
    Escape is the desktop's Back, on the screens that are a task or a detour
    (the asides): it leaves for whatever opened them, by history, exactly as
    the gesture does on a phone. On a tab it does nothing, as before — a tab is
    a place, not something to be dismissed. Sheets and overlays take Escape
    first and stop it, so one press never closes a sheet and the screen.
  */
  const leaveAside = () => {
    if (tab === "statistics" || !ASIDES.includes(tab as (typeof ASIDES)[number])) return;
    back(1, ASIDE_HOME[tab] ?? "statistics");
  };

  useHotkeys([
    { key: "k", mod: true, run: () => setPalOpen((o) => !o) },
    { key: "n", mod: true, run: openLog },
    { key: "0", mod: true, run: () => toTab("statistics") },
    { key: "1", mod: true, run: () => toTab("today") },
    { key: "2", mod: true, run: () => toTab("nutrients") },
    { key: "3", mod: true, run: () => toTab("history") },
    { key: "4", mod: true, run: () => toTab("library") },
    { key: "5", mod: true, run: () => toTab("you") },
    // The date only means something on Today, so stepping it takes you there
    // rather than silently changing a day you cannot see.
    { key: "ArrowLeft", mod: true, run: () => { setDate(shiftIso(date, -1)); toTab("today"); } },
    { key: "ArrowRight", mod: true, run: () => { if (canGoForward) { setDate(shiftIso(date, 1)); toTab("today"); } } },
    { key: "t", mod: true, shift: true, run: () => { setDate(todayIso()); toTab("today"); } },
    {
      key: "Escape",
      inFields: true,
      run: () => {
        if (palOpen) { setPalOpen(false); return; }
        leaveAside();
      },
    },
  // Not until the log is open: behind the passphrase field there is nothing a
  // shortcut could open, and a move made there would be waiting underneath.
  ], opened);

  /*
    The launch gate, and it returns EARLY rather than overlaying the shell.

    An overlay would leave every screen underneath it querying a database this
    session cannot read, so the first thing behind the passphrase field would be
    a stack of SQLite errors. Placed after every hook above, so the rules of
    hooks hold: what changes is what is rendered, never how many hooks run.

    `UnlockLog` renders nothing at all when there is nothing to ask, which is
    every launch on every platform but a locked or freshly restored Android
    phone — one tick of an empty shell, the same tick the day already spends
    loading.
  */
  if (!opened) {
    return (
      <div className="app">
        <div className="shell">
          <main className="main">
            <UnlockLog onOpened={() => setOpened(true)} />
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {/* ⌘K. Mounted always but only openable from a keyboard, so it costs a
          phone nothing and is the fastest path on a laptop. */}
      <CommandPalette
        open={palOpen}
        onClose={() => setPalOpen(false)}
        commands={commands}
        onSearchFood={(q) => go("foods", { q })}
      />

      {/* Each choice replaces the sheet's own history entry with where it
          leads, so Back from there returns to the screen under the sheet
          rather than reopening it. Anything logged from the sheet itself ends
          on Today, as every log does. */}
      <LogSheet
        open={logSheet.open}
        onClose={logSheet.hide}
        date={date}
        meal={meal}
        // Already on Add food (the sidebar's Add, or ⌘N, pressed there): the
        // sheet just closes, rather than stacking a second search on the first.
        onFood={() => (tab === "foods" && route.pick === null ? logSheet.hide() : go("foods", { replace: true }))}
        onActivity={() => go("foods", { pick: "activity", replace: true })}
        onStrength={() => go("foods", { pick: "strength", replace: true })}
        // Today's own water sheet, over Today with Trends behind it: closing it,
        // or logging from it, leaves the day with the bottle in view.
        onWater={() => reset([{ t: "today" }, { t: "today", nav: { sheet: "water" } }])}
        onChanged={refreshShown}
        onLogged={() => reset([{ t: "today" }])}
      />

      {/* Desktop only. Brand + the one action + the four places, replacing
          the flat row of pills above 721px — see styles.css. Untouched
          below that width: this renders in the DOM but `.sidebar` stays
          `display:none` until the desktop-shell media query turns it on. */}
      <aside className="sidebar">
        {/* macOS draws its traffic lights over this corner (titleBarStyle:
            Overlay), so the corner is reserved rather than shared — and the
            reserved strip is what the window is dragged by, since there is no
            title bar left to grab. Renders nowhere else: see
            [data-chrome="macos"] in styles.css. */}
        <div className="dragband" data-tauri-drag-region />

        <div className="sidebar__brand">
          <Logo size={28} />
          <span className="sidebar__word">TrackIt</span>
        </div>

        <button
          className="sidebar__cta"
          aria-current={tab === "foods" || overFoods ? "page" : undefined}
          aria-haspopup="dialog"
          onClick={openLog}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="sidebar__icon">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" />
          </svg>
          Add
          <kbd className="kbd">{MOD}N</kbd>
        </button>

        {/* The palette, given somewhere to be discovered. A shortcut that only
            exists in a changelog is a shortcut nobody presses — and this is
            the fastest route to both a food and a screen, so it earns a
            standing affordance rather than a hidden one. Tertiary weight:
            "Add food" above is the primary action and two filled buttons
            stacked would be two CTAs fighting. */}
        <button className="sidebar__find" onClick={() => setPalOpen(true)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4.5 4.5" strokeLinecap="round" />
          </svg>
          <span className="sidebar__findword">Search</span>
          <kbd className="kbd">{MOD}K</kbd>
        </button>

        <nav className="sidebar__nav" aria-label="Main">
          {/* Trends first, because it is home: the screen the app opens on and
              the one Back ends at. Without a row of its own it was reachable
              only by backing all the way out, on a tablet as on a desktop. */}
          {[{ id: "statistics", label: "Trends" } as const, ...SIDEBAR_NAV].map((t, i) => (
            <button
              key={t.id}
              className="sidebar__link"
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => toTab(t.id)}
              title={`${t.label} (${MOD}${i})`}
            >
              <span className="sidebar__rail" aria-hidden />
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="sidebar__icon">
                {NAV_ICON[t.id]}
              </svg>
              {t.label}
              {/* Shown on hover and on the current row — a hint, not a label,
                  so it must not compete with the destination's own name. */}
              <span className="sidebar__key" aria-hidden>{MOD}{i}</span>
            </button>
          ))}
        </nav>

        {/* Below the destinations and above the footnote: reached
            occasionally, and not a place you spend the day. */}
        <button
          className="sidebar__link sidebar__link--quiet"
          aria-current={
            tab === "you" ||
            tab === "profile" ||
            tab === "settings" ||
            tab === "import" ||
            tab === "export"
              ? "page"
              : undefined
          }
          onClick={() => toTab("you")}
          title={`You (${MOD}5)`}
        >
          <span className="sidebar__rail" aria-hidden />
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="sidebar__icon">
            <circle cx="12" cy="8" r="3.2" />
            <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" strokeLinecap="round" />
          </svg>
          You
          <span className="sidebar__key" aria-hidden>{MOD}5</span>
        </button>

        <p className="sidebar__note">13,694 reference foods, plus what you've added yourself.</p>
      </aside>

      <div className="shell">
        {/*
          There is no top bar on a phone, and that is the point.

          It held a wordmark and a hamburger. The wordmark told you which app
          you had opened, which you knew, and the hamburger opened the menu
          that is now a button in the bottom bar — so between them they spent
          64px of every screen, the most valuable band on a phone, saying
          nothing you could act on. Each screen already renders its own title
          through `ScreenHead`, which lands in that space instead and tells you
          where you actually are.
        */}
        {/* The drawer and its scrim. Both stay mounted so opening and closing
            transition rather than cut, and both are inert when closed. */}
        <div
          className={route.menu ? "scrim scrim--on" : "scrim"}
          onClick={closeMenu}
          aria-hidden
        />
        <aside className={route.menu ? "drawer drawer--on" : "drawer"}
          aria-label="Everything else" aria-hidden={!route.menu}>
          {/* A grab handle, because on a phone this panel now rises out of the
              bottom bar rather than sliding in from the left edge. The left
              drawer was the hamburger's shape; this one should come from where
              the finger pressed. */}
          <div className="drawer__grip" aria-hidden />
          <nav className="drawer__nav">
            {DRAWER_GROUPS.map((group, gi) => (
              <div className="drawer__group" key={group.heading ?? `g${gi}`}>
                {group.heading && <div className="drawer__heading">{group.heading}</div>}
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    className="drawer__link"
                    aria-current={tab === item.id ? "page" : undefined}
                    tabIndex={route.menu ? 0 : -1}
                    onClick={() => {
                      // `replace` so one Back from here returns to the screen
                      // the drawer was opened from, not to the open drawer.
                      //
                      // `from` is only passed for the five real destinations:
                      // an aside such as the cook sheet needs an id in the
                      // hash, and sending a Back button to `#/cook` without
                      // one would land on an error instead of a screen.
                      // Already there: the drawer just closes. Written over
                      // the drawer's entry instead, the screen would stand in
                      // history twice and the next Back would seem to do
                      // nothing.
                      if (tab === item.id) { closeMenu(); return; }
                      const home = BAR_IDS.includes(tab) ? (tab as Tab) : undefined;
                      go(item.id as Tab, { from: home, replace: true });
                    }}
                  >
                    <span className="drawer__icon" aria-hidden>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth={tab === item.id ? 2 : 1.9}>
                        {NAV_ICON[item.id]}
                      </svg>
                    </span>
                    <span className="drawer__label">{item.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        {/* Desktop only, and only for Today — the one screen the date
            actually belongs to. The stepper is bounded in its own control
            rather than sitting in the corner this app's real Back buttons
            occupy, so its shape says "adjust a value" rather than "return". */}
        {tab === "today" && (
          <div className="toolbar" data-tauri-drag-region>
            <div className="stepper">
              <button className="stepper__seg" onClick={goPrevDay} aria-label="Previous day"
                title={`Previous day (${MOD}←)`}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <span className="stepper__mid">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="1.8">
                  <rect x="4.5" y="5.5" width="15" height="14.5" rx="2" />
                  <path d="M4.5 9.5h15" />
                  <path d="M8.5 3.5v4M15.5 3.5v4" />
                  <circle cx="12" cy="14.5" r="1.3" fill="var(--ink-3)" stroke="none" />
                </svg>
                <span className="num stepper__label">{humanDate(date)}</span>
              </span>
              <button className="stepper__seg" onClick={goNextDay} disabled={!canGoForward} aria-label="Next day"
                title={`Next day (${MOD}→)`}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>

            <button className="btn btn--quiet toolbar__today" onClick={goToday} disabled={!canGoForward}
              title={`Back to today (${MOD}⇧T)`}>
              Today
            </button>

            {todayEntries.length > 0 && (
              <span className="toolbar__count">
                {todayEntries.length} item{todayEntries.length > 1 ? "s" : ""}
              </span>
            )}
          </div>
        )}

        <main className="main">
          {error && (
            <p className="alert" role="alert" style={{ marginBottom: "var(--s5)" }}>
              {error}
            </p>
          )}

          {tab === "today" && (
            <Today
              day={day}
              loading={loading}
              date={date}
              label={humanDate(date)}
              canGoForward={canGoForward}
              onToday={goToday}
              onPickDate={setDate}
              onChanged={refreshShown}
              // A meal's own + opens Add on that sitting: the one choice the
              // press has already made is not asked for again on the next
              // screen. Shared state, so Add's own meal chips agree.
              onAddFood={(m) => { if (m) setMeal(m); go("foods"); }}
              onAddWater={() => go("foods", { pick: "water" })}
              onOpenProfile={() => go("profile", { from: "today" })}
              onAddActivity={() => go("foods", { pick: "activity", from: "today" })}
              onOpenActivity={(id) => go("foods", { pick: `activity:${id}`, from: "today" })}
            />
          )}

        {/*
          Kept mounted while an aside covers it, and hidden rather than
          unmounted. The vessel library is only ever reached from the weight
          field, which means a food is always already picked when the user
          leaves — unmounting would throw away the search, the pick and the
          scale reading, and the first-run path (weigh your first katori
          mid-log) would land back on a blank search screen. The custom-food
          screens are reached from a search that found the wrong thing or
          nothing, which is exactly the query you want back afterwards. Foods
          reloads its vessels and re-runs its search when it comes forward.
        */}
        {(tab === "foods" || overFoods) && (
          <div hidden={tab !== "foods"}>
            <Foods
              date={date}
              meal={meal}
              active={tab === "foods"}
              seed={route.q}
              preselect={route.pick}
              onMealChange={setMeal}
              onLogged={onLogged}
              onChanged={refreshShown}
              onManageVessels={() => go("vessels")}
              onEditCook={(id) => go("cook", { id, from: "foods" })}
              onManageCustomFoods={() => go("custom-foods", { from: "foods" })}
              /* The digits travel in the hash, like every other thing a screen
                 needs to survive a reload or a back gesture. A barcode read off
                 a pack and then dropped on the way to the editor would be asked
                 for twice for one food. */
              onCreateCustomFood={(code) => go("custom-food", { from: "foods", code })}
              onCreateSupplement={() => go("supplement", { from: "foods" })}
              onManageSupplements={() => go("supplements", { from: "foods" })}
              onManageBottles={() => go("bottles")}
            />
          </div>
        )}

        {tab === "nutrients" && (
          <Nutrients day={day} loading={loading} label={humanDate(date)} />
        )}

        {tab === "history" && (
          <History
            // The day picked is shown on Today, which is a tab like any other:
            // Trends stands behind it, not this calendar (see lib/nav.ts).
            onPickDate={(iso) => {
              setDate(iso);
              toTab("today");
            }}
            onImport={() => go("import", { from: "history" })}
          />
        )}

        {tab === "library" && (
          <Library
            onOpenRecipes={() => go("recipes", { from: "library" })}
            onOpenCustomFoods={() => go("custom-foods", { from: "library" })}
            onOpenSupplements={() => go("supplements", { from: "library" })}
            onOpenVessels={() => go("vessels", { from: "library" })}
            onOpenBottles={() => go("bottles", { from: "library" })}
            onOpenPantry={() => go("pantry", { from: "library" })}
          />
        )}

        {tab === "you" && (
          <You
            onOpenProfile={() => go("profile", { from: "you" })}
            onOpenSettings={() => go("settings", { from: "you" })}
            onOpenImport={() => go("import", { from: "you" })}
            onOpenExport={() => go("export", { from: "you" })}
          />
        )}

        {/*
          No nav tab leads here; Library's "Recipes" row is the way in, and it
          goes through the router rather than writing the hash itself, same as
          every other aside.
        */}
        {tab === "recipes" && (
          <Recipes
            onBack={() => back(1, route.from ?? "library")}
            onCook={(recipeId) => go("cook", { id: `r:${recipeId}`, from: "recipes" })}
          />
        )}
        {/* The id carries which of the two things this sheet was opened on:
            `r:` a recipe, to start a fresh pot from, or a bare cook id to
            re-open one. Both go in the hash for the reason every other editor's
            does — a reload or an Android back gesture must land on the same
            pot, not on a blank new one. */}
        {tab === "cook" && (
          <CookSheet
            cookId={route.id?.startsWith("r:") ? null : route.id}
            recipeId={route.id?.startsWith("r:") ? route.id.slice(2) : null}
            // Saved or abandoned, the pot returns to whatever opened it — the
            // recipes, or Add food mid-log — and is not left behind it, where
            // Back would have started a fresh pot from the recipe again.
            onBack={() => back(1, route.from ?? "recipes")}
            onSaved={() => back(1, route.from ?? "recipes")}
            onManageVessels={() => go("vessels", { id: route.id, from: "cook" })}
          />
        )}

        {/*
          No nav tab leads here either; History's own action is the way in, and
          it goes through the router rather than writing the hash itself, same
          as the other asides. Foods does not need to stay mounted behind this
          one — unlike the vessel/custom-food/supplement asides, nothing about
          reaching the importer starts from an in-progress search.
        */}
        {tab === "import" && (
          <ImportData
            onBack={() => back(1, route.from ?? "history")}
            onDone={() => back(1, route.from ?? "history")}
          />
        )}

        {/*
          Beside the importer, and reached the same way. There is deliberately
          no second action on History's own header for this: `ScreenHead`'s
          `action` prop takes ONE primary action and "Import data" is already
          it, so getting here from a period on History goes through the menu.
          This screen carries the same four presets, which makes that cheap.
        */}
        {tab === "export" && <ExportData onBack={() => back(1, route.from ?? "you")} />}

        {/*
          `onChanged` re-reads the day. Targets are the denominator of every
          percentage on it, so changing one has to move the dashboard behind
          this screen rather than waiting for the next navigation.
        */}
        {tab === "profile" && (
          <Profile
            onBack={() => back(1, route.from ?? "you")}
            // Profile and targets lead to each other. Each swaps for the other
            // rather than stacking, so going back and forth between them does
            // not build a trail, and Back from either returns to whatever
            // opened the first.
            onOpenSettings={() => go("settings", { from: route.from ?? "you", replace: true })}
            onChanged={() => refresh(date)}
          />
        )}

        {tab === "settings" && (
          <Settings
            onBack={() => back(1, route.from ?? "you")}
            onOpenProfile={() => go("profile", { from: route.from ?? "you", replace: true })}
            onChanged={() => refresh(date)}
          />
        )}

        {tab === "household" && <Household onBack={() => back(1, route.from ?? "you")} />}

        {/* Android only, and gated in the render as well as in the drawer:
            the route is reachable by typing a hash, and a desktop build has no
            keystore, no SQLCipher and no Auto Backup to describe. */}
        {tab === "backup" && isAndroid() && <Backup onBack={() => back(1, route.from ?? "you")} />}

        {/* No way back: this is where the app opens. */}
        {tab === "statistics" && (
          <Statistics
            onOpenProfile={() => go("profile", { from: "statistics" })}
            onAddFood={() => go("foods", { from: "statistics" })}
          />
        )}

        {/*
          No nav tab leads here, so the screen carries its own way out, and it
          is the same step Android's Back takes: to the entry that opened it.
          That entry still holds whatever was open there — the amount sheet
          with its reading, the pot being cooked with its id — so nothing has
          to be carried back out in the hash. `from` is only the fallback for a
          screen with nothing behind it.
        */}
        {tab === "vessels" && (
          <Vessels onBack={() => back(1, route.from ?? "foods")} />
        )}

        {tab === "bottles" && (
          <Bottles onBack={() => back(1, route.from ?? "foods")} />
        )}

        {tab === "pantry" && (
          <Pantry
            onBack={() => back(1, route.from ?? "library")}
            onOpen={(id) => go("container", { id, from: "pantry" })}
            onAdd={() => go("container-edit", { from: "pantry" })}
          />
        )}

        {tab === "container" && route.id && (
          <ContainerHistory
            key={route.id}
            id={route.id}
            onBack={() => back(1, "pantry")}
            onEdit={(id) => go("container-edit", { id, from: "container" })}
          />
        )}

        {/* A container edited returns to its own page, which re-reads it. A
            new one has no page yet, so it takes the editor's place in history:
            Back from it goes to the pantry rather than into a form that has
            already been saved. Deleted from the editor opened on its page,
            both are passed on the way back, since the page now describes
            nothing. */}
        {tab === "container-edit" && (
          <ContainerEditor
            key={route.id ?? "new"}
            id={route.id}
            onDone={(id) => (route.id ? back(1, "pantry") : go("container", { id, from: "pantry", replace: true }))}
            onCancel={() => back(1, "pantry")}
            onDeleted={() => back(route.from === "container" ? 2 : 1, "pantry")}
          />
        )}

        {tab === "custom-foods" && (
          <CustomFoods
            onBack={() => back(1, route.from ?? "foods")}
            onEdit={(id) => go("custom-food", { id, from: "custom-foods" })}
          />
        )}

        {/*
          The id comes off the hash, so a reload and Android's Back both land on
          the same food. `from` carries the way out: a food added from a search
          returns to that search, where it can be logged straight away, while
          one edited from the list returns to the list.
        */}
        {tab === "supplements" && (
          <Supplements
            onBack={() => back(1, route.from ?? "foods")}
            onEdit={(id) => go("supplement", { id, from: "supplements" })}
          />
        )}

        {/*
          Keyed on the id for the same reason the custom-food editor is: a
          reload and Android's Back both have to land on the same bottle, or a
          transcription gets written over the wrong one.
        */}
        {tab === "supplement" && (
          <SupplementEditor
            key={route.id ?? "new"}
            id={route.id}
            onDone={() => back(1, route.from ?? "supplements")}
            onCancel={() => back(1, route.from ?? "supplements")}
          />
        )}

        {tab === "custom-food" && (
          <CustomFoodEditor
            key={route.id ?? "new"}
            id={route.id}
            barcode={route.code}
            onDone={() => back(1, route.from ?? "custom-foods")}
            onCancel={() => back(1, route.from ?? "custom-foods")}
          />
        )}
        </main>

        {/* Mobile only — see `.bar` in styles.css. Desktop has the sidebar,
            which is this bar's job done with a pointer's precision and a
            window's room. */}
        {showBar && (
          <nav className="bar" aria-label="Main">
            {BAR_LEFT.map((t) => (
              <BarLink key={t.id} id={t.id} label={t.label}
                /* Nutrients keeps Today lit. It is not a destination of its
                   own on a phone — it is the same day counted differently, and
                   the bar should not go blank because you looked at it that
                   way. On a phone it is a sheet over Today now (DaySheet), so
                   this only matters for an address left over from before. */
                current={tab === t.id || (t.id === "today" && tab === "nutrients")}
                onClick={() => toTab(t.id)} />
            ))}

            {/*
              Not a tab, and shaped so that it cannot be read as one: raised
              off the bar, filled, and the only accent-coloured thing in the
              row. Adding is the one thing you do here that is not going
              somewhere, and it is wanted from every screen. It asks food or
              activity, as the user chose: activity is logged as readily as a
              meal, so the + cannot mean food alone.
            */}
            <button className="bar__add" onClick={openLog} aria-label="Add food or activity"
              aria-haspopup="dialog">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.4" strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>

            {BAR_RIGHT.map((t) => (
              <BarLink key={t.id} id={t.id} label={t.label}
                current={tab === t.id} onClick={() => toTab(t.id)} />
            ))}
            <BarLink id="more" label="More" current={route.menu || inDrawer}
              onClick={openMenu} expanded={route.menu} />
          </nav>
        )}
      </div>
    </div>
  );
}

/**
 * One destination in the phone's bottom bar.
 *
 * Tone rather than inversion for the selected row — a wash behind the glyph
 * and the accent on the word, the same restraint the drawer and the desktop
 * sidebar already spend. A solid filled pill is the heaviest mark a warm,
 * near-white screen can carry, and it belongs to the add button alone.
 */
function BarLink({
  id, label, current, onClick, expanded,
}: {
  id: string;
  label: string;
  current: boolean;
  onClick: () => void;
  expanded?: boolean;
}) {
  return (
    <button
      className="bar__link"
      aria-current={current ? "page" : undefined}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <span className="bar__icon" aria-hidden>
        <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth={current ? 2.1 : 1.8}>
          {NAV_ICON[id]}
        </svg>
      </span>
      <span className="bar__label">{label}</span>
    </button>
  );
}

function defaultMeal(): Meal {
  const h = new Date().getHours();
  if (h < 11) return "breakfast";
  if (h < 16) return "lunch";
  if (h < 21) return "dinner";
  return "snack";
}
