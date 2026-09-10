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
import { MOD, isAndroid, useHotkeys } from "./lib/desktop";
import { getDay, humanDate, shiftIso, takeWidgetLanding, todayIso } from "./api";
import type { DayView, Meal } from "./types";
import { parsePick } from "./types";
import "./styles.css";

/**
 * Add food is not here: it is an action wanted from every one of these places,
 * not a place of its own, so it is drawn as a floating button on mobile (see
 * `.fab`) and the sidebar's own primary button on desktop — never a tab that
 * would sit at equal weight beside five things you actually navigate *to*.
 */
const TABS = [
  { id: "today", label: "Today" },
  { id: "nutrients", label: "Nutrients" },
  { id: "history", label: "History" },
  { id: "library", label: "Library" },
  { id: "you", label: "You" },
] as const;

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
  history: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" strokeLinecap="round" strokeLinejoin="round" />
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
 * The mobile drawer: every destination in the app, in one list.
 *
 * It lists the three bar shortcuts as well, so the menu reads as a complete map
 * rather than an overflow bin. The two headings are what USED to be
 * destinations — Library and You were hub screens whose only job was to hold a
 * list of links, and the drawer holds those lists instead. That is what the
 * drawer is actually for: eleven places do not fit five slots, and the six that
 * did not fit were costing a screen you had to walk through to reach a recipe.
 */
const DRAWER_GROUPS: readonly { heading: string | null; items: readonly { id: string; label: string }[] }[] = [
  {
    heading: null,
    items: [
      { id: "statistics", label: "Statistics" },
      { id: "today", label: "Today" },
      { id: "history", label: "History" },
      { id: "nutrients", label: "Nutrients" },
    ],
  },
  {
    heading: "Your library",
    items: [
      { id: "recipes", label: "Recipes" },
      { id: "custom-foods", label: "Your foods" },
      { id: "supplements", label: "Supplements" },
      { id: "vessels", label: "Vessels" },
      { id: "bottles", label: "Bottles" },
    ],
  },
  {
    heading: "You",
    items: [
      { id: "profile", label: "Profile & reference figures" },
      { id: "household", label: "Household" },
      { id: "import", label: "Import a spreadsheet" },
      { id: "export", label: "Export your log" },
      { id: "settings", label: "Settings" },
      // Android only. SQLCipher is compiled into the Android build alone and
      // Google's Auto Backup exists nowhere else, so on a desktop this is not
      // a destination that is merely empty — it is one that does not exist.
      ...(isAndroid() ? [{ id: "backup", label: "Backup" }] : []),
    ],
  },
];

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
  history: "a day, or a period",
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
  /**
   * Overwrite the current history entry instead of pushing a new one.
   *
   * Used only by the drawer's own rows. Pushing would stack the destination on
   * top of the entry that opened the menu, so one Back from a recipe would
   * reopen the drawer rather than return to the screen it was opened from.
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

function useHashRoute() {
  const [route, setRoute] = useState<Route>(readRoute);
  /** The depth of the entry currently showing. Mirrors `history.state.d`. */
  const depth = useRef(0);

  // Stamp the entry the app booted on, so the first Back can tell that there is
  // nothing behind it and let Android close the app.
  useEffect(() => {
    if ((window.history.state as { d?: number } | null)?.d === undefined) {
      window.history.replaceState({ d: 0 }, "");
    }
    depth.current = depthOf();
  }, []);

  useEffect(() => {
    const sync = () => {
      const st = window.history.state as { d?: number } | null;
      if (st?.d === undefined) {
        // An entry pushed by a plain `location.hash = …` — a few screens still
        // navigate that way. Stamp it rather than leaving a hole in the count,
        // or Back from it would read as depth 0 and close the app.
        depth.current += 1;
        window.history.replaceState({ d: depth.current }, "");
      } else {
        depth.current = st.d;
      }
      setRoute(readRoute());
    };
    // Both fire for a hash change, and going back fires popstate first; `sync`
    // is idempotent, so being called twice costs nothing.
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  /**
   * The Android back gesture, answered by the app instead of by the WebView.
   *
   * `MainActivity.kt` calls this and closes the app when it does not get back a
   * literal `true`. Every screen change here is a hash change, which the
   * WebView's native back-forward list never records — so `canGoBack()`, which
   * is what Wry asks by default, always says no and Back closed the app from
   * every screen.
   *
   * One rule covers both cases, because the open drawer IS a history entry:
   * anything above depth zero has somewhere to go back to.
   */
  useEffect(() => {
    const w = window as unknown as { __androidBack?: () => boolean };
    w.__androidBack = () => {
      if (depth.current > 0) {
        window.history.back();
        return true;
      }
      return false;
    };
    return () => { delete w.__androidBack; };
  }, []);

  const go = useCallback((t: Tab, nav: Nav = {}) => {
    const q = new URLSearchParams();
    if (nav.id) q.set("id", nav.id);
    if (nav.from) q.set("from", nav.from);
    if (nav.q) q.set("q", nav.q);
    if (nav.pick) q.set("pick", nav.pick);
    const s = q.toString();
    const target = s ? `/${t}?${s}` : `/${t}`;
    if (nav.replace) {
      // Keeps this entry's depth: the destination stands exactly where the
      // entry it replaced stood, so one Back reaches what came before it.
      window.history.replaceState({ d: depth.current }, "", `#${target}`);
      setRoute(readRoute());
      return;
    }
    depth.current += 1;
    window.history.pushState({ d: depth.current }, "", `#${target}`);
    setRoute(readRoute());
  }, []);

  /**
   * Open the drawer by adding `menu=1` to the hash the app is already on.
   *
   * Rewriting the whole hash would be wrong: an editor's `id` and a search's
   * `q` live there too, and opening a menu must not drop the food being
   * transcribed or the query just typed.
   */
  const openMenu = useCallback(() => {
    const raw = window.location.hash.replace(/^#\/?/, "");
    const cut = raw.indexOf("?");
    const path = cut === -1 ? raw : raw.slice(0, cut);
    const params = new URLSearchParams(cut === -1 ? "" : raw.slice(cut + 1));
    params.set("menu", "1");
    depth.current += 1;
    window.history.pushState({ d: depth.current }, "", `#/${path || "today"}?${params.toString()}`);
    setRoute(readRoute());
  }, []);

  /**
   * Close it by going BACK, so the button, the scrim and the system gesture all
   * do one thing and leave no forward entry behind.
   *
   * A reload with `menu=1` still in the hash is the exception: there is no
   * entry of ours to pop, and going back then would leave the app. That case
   * rewrites the hash in place instead.
   */
  const closeMenu = useCallback(() => {
    if (depth.current > 0) {
      window.history.back();
      return;
    }
    const raw = window.location.hash.replace(/^#\/?/, "");
    const cut = raw.indexOf("?");
    const path = cut === -1 ? raw : raw.slice(0, cut);
    const params = new URLSearchParams(cut === -1 ? "" : raw.slice(cut + 1));
    params.delete("menu");
    const s = params.toString();
    window.history.replaceState({ d: 0 }, "", `#/${path || "today"}${s ? `?${s}` : ""}`);
    setRoute(readRoute());
  }, []);

  return [route, go, openMenu, closeMenu] as const;
}

export default function App() {
  const [route, go, openMenu, closeMenu] = useHashRoute();
  const tab = route.tab;

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
        go(l.route as Tab, pick === null ? {} : { pick: l.pick as string });
      } catch {
        // Silence, not an alert. The app has simply opened on its usual front
        // door, which is where it opens anyway.
      }
    };
    const w = window as unknown as { __widgetTap?: () => void };
    w.__widgetTap = () => { void land(); };
    void land();
    return () => { delete w.__widgetTap; };
  }, [go]);
  const [date, setDate] = useState(todayIso());
  const [meal, setMeal] = useState<Meal>(defaultMeal());
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

  const onLogged = useCallback(async () => {
    await refresh(date);
    go("today");
  }, [date, refresh, go]);

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
   * Whether the floating "Add food" button belongs on screen. It stands in
   * for the desktop sidebar's own CTA on the five places you actually
   * navigate to; every aside already has its own primary action or its own
   * way back, and floating a second button over an editor's Save or over
   * Foods itself would be clutter rather than a shortcut.
   */
  const showFab = TABS.some((t) => t.id === tab);

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
  const commands: Command[] = [
    ...TABS.map((t) => ({
      id: `go-${t.id}`,
      label: t.label,
      hint: TAB_HINT[t.id],
      group: "Go to",
      run: () => go(t.id),
    })),
    { id: "add", label: "Add food", hint: "search, weigh and log", group: "Do", run: () => go("foods") },
    { id: "prev", label: "Previous day", hint: humanDate(shiftIso(date, -1)), group: "Do", run: () => { setDate(shiftIso(date, -1)); go("today"); } },
    ...(canGoForward
      ? [{ id: "next", label: "Next day", hint: humanDate(shiftIso(date, 1)), group: "Do", run: () => { setDate(shiftIso(date, 1)); go("today"); } }]
      : []),
    ...(canGoForward
      ? [{ id: "back-today", label: "Back to today", hint: humanDate(todayIso()), group: "Do", run: () => { setDate(todayIso()); go("today"); } }]
      : []),
    { id: "recipes", label: "Recipes", hint: "dishes you cook repeatedly", group: "Library", run: () => go("recipes", { from: "library" }) },
    { id: "own", label: "Your foods", hint: "transcribed from a pack", group: "Library", run: () => go("custom-foods", { from: "library" }) },
    { id: "sups", label: "Supplements", hint: "taken by count, not by weight", group: "Library", run: () => go("supplements", { from: "library" }) },
    { id: "vessels", label: "Vessels", hint: "weighed empty once", group: "Library", run: () => go("vessels", { from: "library" }) },
    { id: "bottles", label: "Bottles", hint: "weighed full once", group: "Library", run: () => go("bottles", { from: "library" }) },
    { id: "new-own", label: "Transcribe a new food", hint: "from the pack in front of you", group: "Library", run: () => go("custom-food", { from: "custom-foods" }) },
    { id: "profile", label: "Profile", hint: "who the targets are for", group: "Settings", run: () => go("profile", { from: "you" }) },
    { id: "targets", label: "Reference figures", hint: "what every figure is read against", group: "Settings", run: () => go("settings", { from: "you" }) },
    { id: "import", label: "Import a spreadsheet", hint: "a log you kept elsewhere", group: "Settings", run: () => go("import", { from: "you" }) },
    { id: "export", label: "Export your log", hint: "a spreadsheet you keep", group: "Settings", run: () => go("export", { from: "you" }) },
    { id: "household", label: "Household", hint: "the other devices in this kitchen", group: "Settings", run: () => go("household", { from: "you" }) },
    { id: "statistics", label: "Statistics", hint: "how you have been eating", group: "Settings", run: () => go("statistics", { from: "history" }) },
    // Filtered out rather than disabled off Android, for the same reason the
    // drawer item is: a palette entry that cannot go anywhere is worse than an
    // absent one.
    ...(isAndroid()
      ? [{ id: "backup", label: "Backup", hint: "one sealed file, carried by Google", group: "Settings", run: () => go("backup", { from: "you" }) }]
      : []),
  ];

  /**
   * Where Escape goes from an aside.
   *
   * `route.from` rather than `history.back()`: the app already records where
   * each aside was opened from, and honouring that is predictable in a way
   * that walking the history stack is not — a reload landing directly on an
   * editor has no previous entry to return to, and Escape must not close the
   * window.
   */
  const escapeTarget = (): Tab | null => {
    if (!ASIDES.includes(tab as (typeof ASIDES)[number])) return null;
    return route.from ?? ASIDE_HOME[tab] ?? "today";
  };

  useHotkeys([
    { key: "k", mod: true, run: () => setPalOpen((o) => !o) },
    { key: "n", mod: true, run: () => go("foods") },
    { key: "1", mod: true, run: () => go("today") },
    { key: "2", mod: true, run: () => go("nutrients") },
    { key: "3", mod: true, run: () => go("history") },
    { key: "4", mod: true, run: () => go("library") },
    { key: "5", mod: true, run: () => go("you") },
    // The date only means something on Today, so stepping it takes you there
    // rather than silently changing a day you cannot see.
    { key: "ArrowLeft", mod: true, run: () => { setDate(shiftIso(date, -1)); go("today"); } },
    { key: "ArrowRight", mod: true, run: () => { if (canGoForward) { setDate(shiftIso(date, 1)); go("today"); } } },
    { key: "t", mod: true, shift: true, run: () => { setDate(todayIso()); go("today"); } },
    {
      key: "Escape",
      inFields: true,
      run: () => {
        if (palOpen) { setPalOpen(false); return; }
        const back = escapeTarget();
        if (back) go(back, { id: route.id });
      },
    },
  ]);

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
          onClick={() => go("foods")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="sidebar__icon">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" />
          </svg>
          Add food
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
          {SIDEBAR_NAV.map((t, i) => (
            <button
              key={t.id}
              className="sidebar__link"
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => go(t.id)}
              title={`${t.label} (${MOD}${i + 1})`}
            >
              <span className="sidebar__rail" aria-hidden />
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="sidebar__icon">
                {NAV_ICON[t.id]}
              </svg>
              {t.label}
              {/* Shown on hover and on the current row — a hint, not a label,
                  so it must not compete with the destination's own name. */}
              <span className="sidebar__key" aria-hidden>{MOD}{i + 1}</span>
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
          onClick={() => go("you")}
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
        <header className="topbar">
          <div className="topbar__inner">
            {/* Mobile only — see `.menubtn`. On desktop the sidebar IS this
                drawer, permanently open, so a button to reveal it would be a
                control for something already on screen. */}
            <button className="menubtn" onClick={openMenu} aria-label="Open the menu"
              aria-expanded={route.menu}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <span className="brand">
              <Logo size={22} />
              <span className="brand__word">TrackIt</span>
            </span>
            {/* Desktop only. On a phone this row is hidden entirely and the
                drawer is the whole of the navigation — see `.nav` in the mobile
                block of styles.css. */}
            <nav className="nav" aria-label="Main">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  className="nav__link"
                  aria-current={tab === t.id ? "page" : undefined}
                  onClick={() => go(t.id)}
                >
                  <span className="nav__icon" aria-hidden>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                      {NAV_ICON[t.id]}
                    </svg>
                  </span>
                  <span className="nav__label">{t.label}</span>
                </button>
              ))}
            </nav>
          </div>
        </header>

        {/* The drawer and its scrim. Both stay mounted so opening and closing
            transition rather than cut, and both are inert when closed. */}
        <div
          className={route.menu ? "scrim scrim--on" : "scrim"}
          onClick={closeMenu}
          aria-hidden
        />
        <aside className={route.menu ? "drawer drawer--on" : "drawer"}
          aria-label="All destinations" aria-hidden={!route.menu}>
          <div className="drawer__brand">
            <Logo size={18} />
            <span className="drawer__word">TrackIt</span>
          </div>
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
                      const home = TABS.some((t) => t.id === tab) ? (tab as Tab) : undefined;
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
              onPrev={goPrevDay}
              onNext={goNextDay}
              onToday={goToday}
              onRemoved={() => refresh(date)}
              onSeeAll={() => go("nutrients")}
              onAddFood={() => go("foods")}
              onOpenProfile={() => go("profile", { from: "today" })}
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
              onManageVessels={() => go("vessels")}
              onEditCook={(id) => go("cook", { id, from: "foods" })}
              onManageCustomFoods={() => go("custom-foods", { from: "foods" })}
              onCreateCustomFood={() => go("custom-food", { from: "foods" })}
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
            onPickDate={(iso) => {
              setDate(iso);
              go("today");
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
            onBack={() => go(route.from ?? "library")}
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
            onBack={() => go(route.from ?? "recipes")}
            onSaved={() => go(route.from ?? "recipes")}
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
            onBack={() => go(route.from ?? "history")}
            onDone={() => go(route.from ?? "history")}
          />
        )}

        {/*
          Beside the importer, and reached the same way. There is deliberately
          no second action on History's own header for this: `ScreenHead`'s
          `action` prop takes ONE primary action and "Import data" is already
          it, so getting here from a period on History goes through the menu.
          This screen carries the same four presets, which makes that cheap.
        */}
        {tab === "export" && <ExportData onBack={() => go(route.from ?? "you")} />}

        {/*
          `onChanged` re-reads the day. Targets are the denominator of every
          percentage on it, so changing one has to move the dashboard behind
          this screen rather than waiting for the next navigation.
        */}
        {tab === "profile" && (
          <Profile
            onBack={() => go(route.from ?? "you")}
            onOpenSettings={() => go("settings", { from: "profile" })}
            onChanged={() => refresh(date)}
          />
        )}

        {tab === "settings" && (
          <Settings
            onBack={() => go(route.from ?? "you")}
            onOpenProfile={() => go("profile", { from: "settings" })}
            onChanged={() => refresh(date)}
          />
        )}

        {tab === "household" && <Household onBack={() => go(route.from ?? "you")} />}

        {/* Android only, and gated in the render as well as in the drawer:
            the route is reachable by typing a hash, and a desktop build has no
            keystore, no SQLCipher and no Auto Backup to describe. */}
        {tab === "backup" && isAndroid() && <Backup onBack={() => go(route.from ?? "you")} />}

        {/* No way back: this is where the app opens. */}
        {tab === "statistics" && <Statistics />}

        {/*
          No nav tab leads here, so the screen carries its own way out; it goes
          through the router rather than writing the hash itself. Android's Back
          gesture works too — `go` writes a hash, which is a history entry.
        */}
        {/* The id is carried back out as well as in. Every other caller ignores
            it, but the cook sheet is keyed on its own id — returning without
            one would land on a blank sheet rather than the pot being cooked. */}
        {tab === "vessels" && (
          <Vessels onBack={() => go(route.from ?? "foods", { id: route.id })} />
        )}

        {tab === "bottles" && (
          <Bottles onBack={() => go(route.from ?? "foods", { id: route.id })} />
        )}

        {tab === "custom-foods" && (
          <CustomFoods
            onBack={() => go(route.from ?? "foods")}
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
            onBack={() => go(route.from ?? "foods")}
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
            onDone={() => go(route.from ?? "supplements")}
            onCancel={() => go(route.from ?? "supplements")}
          />
        )}

        {tab === "custom-food" && (
          <CustomFoodEditor
            key={route.id ?? "new"}
            id={route.id}
            onDone={() => go(route.from ?? "custom-foods")}
            onCancel={() => go(route.from ?? "custom-foods")}
          />
        )}
        </main>

        {/* Mobile only — see `.fab` in styles.css. Desktop already has the
            sidebar's own "Add food" button, which needs no floating twin. */}
        {showFab && (
          <button className="fab" onClick={() => go("foods")} aria-label="Add food">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

function defaultMeal(): Meal {
  const h = new Date().getHours();
  if (h < 11) return "breakfast";
  if (h < 16) return "lunch";
  if (h < 21) return "dinner";
  return "snack";
}
