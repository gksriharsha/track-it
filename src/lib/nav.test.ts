/**
 * Where Back goes. Runs in a bare Node process, like the other tests here:
 *
 *     node src/lib/nav.test.ts
 *
 * What it guards: the history rule in nav.ts, played out against a model of
 * the browser's own history — a list of entries and a cursor, where a push
 * drops everything forward of the cursor, exactly as `pushState` does. Each
 * journey is one the user tried in the flow picker before choosing "Tabs, then
 * Trends", and the claim is what Back does after it.
 */
import { isBareRoot, planBack, planBackFrom, planLaunch, planReset, planTab, ROOT_HASH } from "./nav.ts";
import type { HistoryOp } from "./nav.ts";

let failed = 0;
let held = 0;
function is(claim: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    held += 1;
    console.log(`  ok   ${claim}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${claim}\n         got ${g}, want ${w}`);
  }
}

/** The browser's history, as far as these plans can see it. */
class History {
  entries: { d: number; hash: string }[];
  at = 0;
  constructor(hash = "") {
    this.entries = [{ d: 0, hash }];
  }
  get depth(): number { return this.entries[this.at].d; }
  get hash(): string { return this.entries[this.at].hash; }
  /** An ordinary tap in the app: a new entry one deeper. */
  push(hash: string): this {
    this.entries = this.entries.slice(0, this.at + 1);
    this.entries.push({ d: this.depth + 1, hash });
    this.at += 1;
    return this;
  }
  /** A drawer row or the + sheet's choice: written over the entry it came from. */
  replace(hash: string): this {
    this.entries[this.at] = { d: this.depth, hash };
    return this;
  }
  run(ops: HistoryOp[]): this {
    for (const op of ops) {
      if (op.kind === "walk") this.at += op.by;
      else if (op.kind === "replace") this.entries[this.at] = { d: op.d, hash: op.hash };
      else {
        this.entries = this.entries.slice(0, this.at + 1);
        this.entries.push({ d: op.d, hash: op.hash });
        this.at += 1;
      }
      if (this.at < 0) throw new Error("walked off the front of history");
    }
    return this;
  }
  /** The Android gesture: a step back while there is one, else the app closes. */
  back(): string {
    if (this.depth === 0) return "closes the app";
    this.at -= 1;
    return this.hash;
  }
  /**
   * Everything Back passes through from here, until the app closes. Trends is
   * reported as such whichever way its hash is spelled: a cold start leaves it
   * empty, and the app writes it out in full when it rewrites the root.
   */
  backs(): string[] {
    const out: string[] = [];
    const copy = Object.assign(new History(), { entries: [...this.entries], at: this.at });
    for (;;) {
      const next = copy.back();
      out.push(next !== "closes the app" && isBareRoot(next) ? "Trends" : next);
      if (next === "closes the app") return out;
    }
  }
  /** Every entry's depth matches its place in the list: the stamp is never stale. */
  get honest(): boolean {
    return this.entries.slice(0, this.at + 1).every((e, i) => e.d === i);
  }
}

const land = (h: History) => h.run(planReset(h.depth, ["#/today"]));
const tab = (h: History, t: string) => h.run(planTab(h.depth, h.hash, t));
const back = (h: History, steps = 1, fallback = ROOT_HASH) => h.run(planBack(h.depth, steps, fallback));

// A food, from the screen the app opens on.
{
  const h = new History("").push("#/?sheet=log").replace("#/foods").push("#/foods?sheet=amount");
  land(h);
  is("logging from Trends ends on Today", h.hash, "#/today");
  is("and Back goes to Trends, then out", h.backs(), ["Trends", "closes the app"]);
  is("every entry's depth is still its place", h.honest, true);
}

// A food, from a meal on Today.
{
  const h = new History("");
  tab(h, "today");
  h.push("#/foods").push("#/foods?sheet=amount");
  land(h);
  is("logging from a meal on Today ends on Today", h.hash, "#/today");
  is("with nothing of the search left behind it", h.backs(), ["Trends", "closes the app"]);
}

// A food, from Days: the walk back has more than one step to cover.
{
  const h = new History("");
  tab(h, "history");
  h.push("#/history?sheet=log").replace("#/foods").push("#/foods?sheet=amount");
  const ops = planReset(h.depth, ["#/today"]);
  is("from deeper, the root is reached by one walk first", ops[0], { kind: "walk", by: -3 });
  h.run(ops);
  is("and Days is not left under Today", h.backs(), ["Trends", "closes the app"]);
}

// Tabs do not stack.
{
  const h = new History("");
  tab(h, "today");
  tab(h, "history");
  tab(h, "today");
  is("Today, Days, Today leaves only Trends under Today", h.backs(), ["Trends", "closes the app"]);
  is("one tab to the next writes over, rather than walking", planTab(1, "#/today", "history"),
    [{ kind: "replace", d: 1, hash: "#/history" }]);
  is("tapping the tab you are on writes nothing", planTab(1, "#/today", "today"), []);
  is("tapping Trends on Trends writes nothing", planTab(0, "", "statistics"), []);
  is("Trends from a tab walks back to the root", planTab(1, "#/today", "statistics"),
    [{ kind: "walk", by: -1 }, { kind: "replace", d: 0, hash: ROOT_HASH }]);
}

// A tab from deep inside another.
{
  const h = new History("");
  h.push("#/?menu=1").replace("#/recipes?from=statistics").push("#/cook?id=r%3A4&from=recipes");
  tab(h, "today");
  is("a tab from a cook sheet leaves Trends and the tab", h.backs(), ["Trends", "closes the app"]);
  tab(h, "today");
  is("Today's own tab while on Today's screen is still nothing", h.hash, "#/today");
}

// The drawer, a form, and finishing it.
{
  const h = new History("");
  h.push("#/statistics?menu=1").replace("#/recipes").push("#/cook?id=r%3A4&from=recipes");
  back(h);
  is("saving a pot returns to the recipes that opened it", h.hash, "#/recipes");
  is("and the pot is not behind it", h.backs(), ["Trends", "closes the app"]);
}

// A container deleted from its own editor.
{
  const h = new History("");
  h.push("#/statistics?menu=1").replace("#/pantry").push("#/container?id=salt").push("#/container-edit?id=salt&from=container");
  back(h, 2);
  is("deleting a container goes past its own page to the pantry", h.hash, "#/pantry");
}

// A Save that lands after the person has already pressed Back.
{
  is("a save that asked from depth 4 steps back to 3", planBackFrom(4, 4, 1, ROOT_HASH), [{ kind: "walk", by: -1 }]);
  is("Back pressed while it saved: nothing more to do", planBackFrom(3, 4, 1, ROOT_HASH), []);
  is("an overlay opened while it saved closes along with the form", planBackFrom(5, 4, 1, ROOT_HASH), [{ kind: "walk", by: -2 }]);
  is("two steps asked from 4, from 3, is one more", planBackFrom(3, 4, 2, ROOT_HASH), [{ kind: "walk", by: -1 }]);
}

// Back with nothing behind.
{
  is("on the root, back puts the fallback in its place", planBack(0, 1, "#/recipes"), [{ kind: "replace", d: 0, hash: "#/recipes" }]);
  is("two steps from one deep stops at the root", planBack(1, 2, ROOT_HASH), [{ kind: "walk", by: -1 }]);
}

// Water from the + sheet: Today, then its water sheet over it.
{
  const h = new History("");
  h.push("#/?sheet=log");
  h.run(planReset(h.depth, ["#/today", "#/today?sheet=water"]));
  is("the water sheet opens over Today", h.hash, "#/today?sheet=water");
  is("closing it shows Today, then Trends", h.backs(), ["#/today", "Trends", "closes the app"]);
}

// A launch somewhere other than Trends.
{
  const h = new History("#/today?sheet=nutrients");
  h.run(planLaunch(h.depth, h.hash));
  is("a reload on Today puts Trends under it", h.backs(), ["Trends", "closes the app"]);
  is("a cold start on Trends writes nothing", planLaunch(0, ""), []);
  is("nor does Trends written out in full", planLaunch(0, "#/statistics"), []);
  is("a page already deeper than the root was set up before", planLaunch(2, "#/today"), []);
  const menu = new History("#/statistics?menu=1");
  menu.run(planLaunch(menu.depth, menu.hash));
  const today = new History("#/today?menu=1");
  today.run(planLaunch(today.depth, today.hash));
  is("a reload on Today with the drawer open opens on Today, drawer shut", [today.hash, today.backs()],
    ["#/today", ["Trends", "closes the app"]]);
  is("a reload on Trends with the drawer open opens on Trends alone", [menu.hash, menu.backs()], [ROOT_HASH, ["closes the app"]]);
}

// A widget's food, then a log.
{
  const h = new History("");
  h.run(planReset(h.depth, ["#/foods?pick=food%3A171287"]));
  is("a widget tap lands on Add food with Trends behind it", h.backs(), ["Trends", "closes the app"]);
  h.push("#/foods?pick=food%3A171287&sheet=amount");
  land(h);
  is("and once logged, its pick is gone from history", h.backs(), ["Trends", "closes the app"]);
  is("every depth still matches", h.honest, true);
}

console.log(failed === 0 ? `\nall ${held} claims held` : `\n${failed} of ${held + failed} claims FAILED`);
if (failed > 0) throw new Error(`${failed} claim(s) failed`);
