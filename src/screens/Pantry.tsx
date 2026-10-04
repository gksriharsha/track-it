import { useCallback, useEffect, useState } from "react";
import { getPantry } from "../api";
import { PlusGlyph } from "../components/DayWater";
import Glyph from "../components/Glyph";
import ReadingSheet from "../components/ReadingSheet";
import type { SheetTarget } from "../components/ReadingSheet";
import ScreenHead from "../components/ScreenHead";
import { useHashSheetValue } from "../lib/hashSheet";
import { amount, howRead, lastLine, pantryPeriod, waitingLine } from "../lib/pantry";
import type { Pantry as PantryData, PantryFood } from "../types";

interface Props {
  onBack?: () => void;
  onOpen: (containerId: string) => void;
  onAdd: () => void;
}

/**
 * The pantry: the jars and bottles salt, oil, ghee and ketchup live in.
 *
 * By food, figures first. Each food leads with what its containers have
 * shown over the last 90 days — how much the kitchen used a day, set wide as
 * every period's figure is, and what a written to-taste amount really comes
 * to — and its containers sit beneath it as tiles, each with its last reading
 * and a (+) beside it to record the next, the way water's row has one.
 *
 * The reading sheet a (+) opens is held in the hash as `reading=<container
 * id>` rather than in state, so the Android back gesture closes the sheet
 * instead of leaving the pantry from under it.
 */
export default function Pantry(p: Props) {
  const [data, setData] = useState<PantryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reading = useHashSheetValue("reading");

  const load = useCallback(async () => {
    try {
      const { from, to } = pantryPeriod();
      setData(await getPantry(from, to));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // The hash carries only the container's id, so what the sheet shows of it is
  // found again in what was loaded. Nothing until the pantry is in.
  const target = reading.value !== null && data ? targetOf(data, reading.value) : null;

  const empty = data !== null && data.foods.length === 0 && data.finished.length === 0;

  return (
    <div className="screen">
      <ScreenHead
        title="Pantry"
        onBack={p.onBack}
        action={data && !empty ? <button className="btn btn--quiet" onClick={p.onAdd}>Add a container</button> : undefined}
      />

      {error && <p className="alert" role="alert">{error}</p>}

      {data === null && !error && (
        <div aria-busy="true" aria-label="Loading the pantry">
          {[0, 1, 2].map((i) => <div className="skel skel--row" key={i} style={{ width: `${80 - i * 12}%` }} />)}
        </div>
      )}

      {empty && (
        <div className="empty">
          <h3>No containers yet</h3>
          <p>
            Add the jar or bottle you cook from most, like salt or oil. Read it now and then, and
            TrackIt learns how much you really add by feel.
          </p>
          <button className="btn" onClick={p.onAdd}>Add a container</button>
        </div>
      )}

      {data && !empty && (
        <div className="pantry__foods">
          {data.foods.map((f) => (
            <section className="pfood" key={f.food.fdc_id ?? f.food.custom_food_id}>
              <h2 className="pfood__name">{f.description}</h2>
              <Figures food={f} />
              <div className="tiles">
                {f.containers.map((c) => {
                  const last = lastLine(c.last);
                  return (
                    <div className="pantry__row" key={c.id}>
                      <button className="tile pantry__open" onClick={() => p.onOpen(c.id)}>
                        <span className="lead lead--own" aria-hidden><Glyph name="jar" size={20} /></span>
                        <span className="row__main">
                          <span className="row__title">{c.name}</span>
                          <span className="row__sub">{howRead(c.read_by)}</span>
                        </span>
                        <span className="pantry__fig">
                          <span className="tnum">{last ? last.value : "—"}</span>
                          <span className="pantry__when">{last ? last.when : "nothing yet"}</span>
                        </span>
                      </button>
                      <button
                        className="pantry__add"
                        onClick={() => reading.show(c.id)}
                        aria-label={`Record a reading of the ${c.name.toLowerCase()}`}
                      >
                        <PlusGlyph />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          {data.finished.length > 0 && (
            <section className="pfood">
              <h2 className="pfood__name">Finished</h2>
              <div className="tiles">
                {data.finished.map((c) => (
                  <button className="tile pantry__open" key={c.id} onClick={() => p.onOpen(c.id)}>
                    <span className="lead lead--bought" aria-hidden><Glyph name="jar" size={20} /></span>
                    <span className="row__main">
                      <span className="row__title">{c.name}</span>
                      <span className="row__sub">{howRead(c.read_by)}</span>
                    </span>
                    <span className="row__chev" aria-hidden>›</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Saving closes the sheet the way every other close does, a step back,
          then reads the pantry again so the tile shows the reading just made. */}
      {target && (
        <ReadingSheet
          key={target.id}
          target={target}
          onClose={reading.hide}
          onSaved={() => { reading.hide(); load(); }}
        />
      )}
    </div>
  );
}

/**
 * What the reading sheet needs to know about one container, with the food it
 * sits under. Only a container still in use has a (+), so the finished ones
 * are not looked through.
 */
function targetOf(data: PantryData, id: string): SheetTarget | null {
  for (const food of data.foods) {
    const c = food.containers.find((x) => x.id === id);
    if (c) return { id: c.id, name: c.name, description: food.description, read_by: c.read_by, cup_ml: c.cup_ml };
  }
  return null;
}

/**
 * What a food's containers have shown: the kitchen's use a day over the
 * period, then what a written amount comes to. A food read by its marks says
 * ml first, with grams beside it when its weight per ml is known.
 */
function Figures({ food }: { food: PantryFood }) {
  const u = food.usage;
  const byMarks = food.containers.some((c) => c.read_by === "marks");
  const ml = byMarks ? u.used_per_day_ml : null;
  const g = u.used_per_day_g;
  const counted = food.factor.stretches > 0;
  const first = food.containers[0];
  if (g === null && !(counted && food.typical_written_g !== null) && !food.waiting) return null;
  return (
    <div className="pfood__figs">
      {g !== null && (
        <>
          <p className="pfood__fig">
            <span className="fig pfood__n">{amount(ml ?? g)}</span>
            <span className="pfood__u">{ml !== null ? "ml" : "g"}</span>
            {ml !== null && <span className="pfood__alt">{amount(g)} g</span>}
          </p>
          <p className="pfood__k">a day in the kitchen, last 90 days</p>
        </>
      )}
      {counted && food.typical_written_g !== null && (
        <p className="pfood__t">
          Your {amount(food.typical_written_g)} g comes to about {amount(food.typical_written_g * food.factor.factor)} g.
        </p>
      )}
      {food.waiting && (
        <p className="pfood__wait">{waitingLine(food.waiting, first?.name ?? "container", food.description)}</p>
      )}
    </div>
  );
}
