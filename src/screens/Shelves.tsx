import { useEffect, useState } from "react";
import { getPantry } from "../api";
import Glyph from "../components/Glyph";
import KeptSheet from "../components/KeptSheet";
import { Rows, Thing } from "../components/KitchenArt";
import ScreenHead from "../components/ScreenHead";
import Unpack from "../components/Unpack";
import { faded, guess, nameOf, SHELVES, shelvesOf, usedLine } from "../lib/kitchen";
import { useHashSheet, useHashSheetValue } from "../lib/hashSheet";
import { lastLine, pantryPeriod } from "../lib/pantry";
import { keyOf, useKitchen } from "../lib/useKitchen";
import type { ContainerSummary, FoodRef, KitchenFood, Pantry } from "../types";

interface Props {
  onBack?: () => void;
  /** A jar opens on its figures, the screen chosen for jars on 3 October. */
  onOpenJar: (containerId: string) => void;
}

type Jar = { jar: ContainerSummary; food: FoodRef; description: string };

const NONE: Pantry = { foods: [], finished: [] };

/**
 * The pantry's shelves. Things drop onto them as the screen opens, named on a
 * label along the shelf's edge, with the day each was last used. The jars you
 * weigh stand among them with their last reading. Nothing to keep up: cooking
 * fills the shelves, and what goes unused greys back on its own.
 */
export default function Shelves(p: Props) {
  const k = useKitchen();
  const [pantry, setPantry] = useState<Pantry | null>(null);
  const put = useHashSheet("put", "away");
  const kept = useHashSheetValue("kept");

  useEffect(() => {
    const { from, to } = pantryPeriod();
    getPantry(from, to).then(setPantry, () => setPantry(NONE));
  }, []);

  if (!k.foods || !pantry) {
    return (
      <div className="screen">
        <ScreenHead title="Pantry" onBack={p.onBack} />
        {k.error && <p className="alert" role="alert">{k.error}</p>}
        <div aria-busy="true" aria-label="Loading the pantry">
          {[0, 1, 2].map((i) => <div className="skel skel--row" key={i} style={{ width: `${80 - i * 12}%` }} />)}
        </div>
      </div>
    );
  }

  const jars: Jar[] = pantry.foods.flatMap((f) => f.containers.map((jar) => ({ jar, food: f.food, description: f.description })));
  const shelves = shelvesOf(k.foods, "pantry", k.today);
  const jarShelf = (j: Jar) => {
    const g = guess(j.description);
    return g.place === "pantry" ? g.shelf : "Oils and spices";
  };
  const all = SHELVES.pantry
    .map((shelf) => ({
      shelf,
      jars: jars.filter((j) => jarShelf(j) === shelf),
      items: shelves.find((s) => s.shelf === shelf)?.items ?? [],
    }))
    .filter((s) => s.jars.length + s.items.length > 0);
  const open = kept.value ? k.foods.find((f) => keyOf(f) === kept.value) ?? null : null;
  let j = 0;

  return (
    <div className="screen">
      <ScreenHead title="Pantry" onBack={p.onBack} action={<button className="btn btn--quiet" onClick={put.show}>Put away</button>} />
      {k.error && <p className="alert" role="alert">{k.error}</p>}

      {all.length === 0 ? (
        <div className="empty">
          <h3>Nothing on the shelves yet</h3>
          <p>Cooking fills them. So does putting a shop away.</p>
          <button className="btn" onClick={put.show}>Put away</button>
        </div>
      ) : (
        <div className="shelves">
          {all.map((s) => {
            type Cell = { kind: "jar"; v: Jar } | { kind: "food"; v: KitchenFood };
            const cells: Cell[] = [...s.jars.map((v) => ({ kind: "jar" as const, v })), ...s.items.map((v) => ({ kind: "food" as const, v }))];
            const start = j;
            j += cells.length;
            return (
              <section key={s.shelf} className="shelf">
                <h2 className="shelf__name">{s.shelf}<span>{cells.length}</span></h2>
                <Rows
                  items={cells}
                  per={4}
                  start={start}
                  render={(c, n) =>
                    c.kind === "jar" ? (
                      <Thing
                        key={c.v.jar.id}
                        j={n}
                        art={guess(c.v.description).art}
                        name={c.v.jar.name}
                        line={<><Glyph name="jar" size={11} />{lastLine(c.v.jar.last)?.value ?? "No reading yet"}</>}
                        onClick={() => p.onOpenJar(c.v.jar.id)}
                      />
                    ) : (
                      <Thing
                        key={keyOf(c.v)}
                        j={n}
                        art={guess(nameOf(c.v)).art}
                        name={nameOf(c.v)}
                        line={usedLine(c.v, k.today)}
                        old={faded(c.v, k.today)}
                        onClick={() => kept.show(keyOf(c.v))}
                      />
                    )
                  }
                />
              </section>
            );
          })}
        </div>
      )}

      <KeptSheet food={open} today={k.today} onClose={kept.hide} onChanged={k.load} />
      <Unpack
        open={put.open}
        onClose={put.hide}
        foods={k.foods}
        today={k.today}
        counts={k.counts}
        onChanged={k.load}
      />
    </div>
  );
}
