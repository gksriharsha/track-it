import { useCallback, useEffect, useState } from "react";
import { deleteContainerEvent, getContainer, tasteFactors } from "../api";
import ReadingSheet from "../components/ReadingSheet";
import ScreenHead from "../components/ScreenHead";
import { useHashSheet } from "../lib/hashSheet";
import { amount, figure, howRead, shortDate, used } from "../lib/pantry";
import type { Container, ContainerEvent, ContainerStretch, FoodTasteFactor } from "../types";

interface Props {
  id: string;
  onBack?: () => void;
  onEdit: (id: string) => void;
}

/**
 * One container's history, as stretches: each span between two readings is
 * a tile with its dates, its length and what was used. A spill says so and
 * is left out; a stretch waiting for the container's empty weight or the
 * food's weight per ml says which. Newest first, under the figure they add
 * up to.
 *
 * "Record a reading" opens the same sheet the pantry's (+) does, held in the
 * hash the same way, as `reading=<this container's id>`, so the Android back
 * gesture closes the sheet rather than leaving the container's page.
 */
export default function ContainerHistory(p: Props) {
  const [c, setC] = useState<Container | null>(null);
  const [factor, setFactor] = useState<FoodTasteFactor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reading = useHashSheet("reading", p.id);
  const [showReadings, setShowReadings] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [got, factors] = await Promise.all([getContainer(p.id), tasteFactors()]);
      setC(got);
      setFactor(
        factors.find((f) => f.food.fdc_id === got.food.fdc_id && f.food.custom_food_id === got.food.custom_food_id) ?? null,
      );
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [p.id]);

  useEffect(() => { load(); }, [load]);

  async function remove(e: ContainerEvent) {
    try {
      await deleteContainerEvent(e.id);
      setConfirming(null);
      await load();
    } catch (err) {
      setError(String(err));
    }
  }

  if (!c) {
    return (
      <div className="screen screen--list">
        <ScreenHead title="Container" onBack={p.onBack} />
        {error ? <p className="alert" role="alert">{error}</p> : <div className="skel skel--row" />}
      </div>
    );
  }

  // The container's own figure, over its counted stretches only: said in ml
  // for a container read by its marks when every one of them can say it. No
  // rate over less than a day: two readings minutes apart close a real
  // stretch, and dividing it by a sliver of a day describes nothing.
  const counted = c.stretches.filter((s) => s.status === "counted");
  const days = counted.reduce((a, s) => a + (s.days ?? 0), 0);
  const unit = c.read_by === "marks" && counted.every((s) => s.used_ml !== null) ? "ml" : "g";
  const total = counted.reduce((a, s) => a + ((unit === "ml" ? s.used_ml : s.used_g) ?? 0), 0);
  const perDay = days >= 1 ? total / days : null;
  const f = factor && factor.factor.stretches > 0 && factor.typical_written_g !== null ? factor : null;

  return (
    <div className="screen screen--list">
      <ScreenHead
        title={c.name}
        onBack={p.onBack}
        action={<button className="btn btn--quiet" onClick={() => p.onEdit(c.id)}>Edit</button>}
      />

      {error && <p className="alert" role="alert">{error}</p>}

      <section className="pfood">
        <p className="pfood__k">{c.description}. {howRead(c.read_by)}.</p>
        {perDay !== null && (
          <div className="pfood__figs">
            <p className="pfood__fig">
              <span className="fig pfood__n">{amount(perDay)}</span>
              <span className="pfood__u">{unit}</span>
            </p>
            <p className="pfood__k">a day, over {Math.round(days)} counted {Math.round(days) === 1 ? "day" : "days"}</p>
          </div>
        )}
        {f && (
          <p className="pfood__t">
            Your {amount(f.typical_written_g!)} g comes to about {amount(f.typical_written_g! * f.factor.factor)} g.
          </p>
        )}
      </section>

      <section className="pfood">
        <h2 className="pfood__name">Between readings</h2>
        {c.stretches.length === 0 ? (
          <p className="pfood__wait">Nothing yet. Record the pack you poured in, then a reading now and then.</p>
        ) : (
          <div className="tiles">
            {[...c.stretches].reverse().map((s, i) => (
              <StretchTile key={`${s.from_on}-${i}`} s={s} c={c} />
            ))}
          </div>
        )}
      </section>

      <section className="pfood">
        <div className="tiles">
          <button className="tile pantry__toggle" onClick={() => setShowReadings((v) => !v)} aria-expanded={showReadings}>
            <span className="row__main">
              <span className="row__title">Readings</span>
              <span className="row__sub">{c.events.length} recorded</span>
            </span>
            <span className={`row__chev${showReadings ? " is-open" : ""}`} aria-hidden>›</span>
          </button>
          {showReadings && [...c.events].reverse().map((e) => (
            <div className="tile pantry__event" key={e.id}>
              <span className="row__main">
                <span className="row__title">{eventTitle(e)}</span>
                <span className="row__sub">{shortDate(e.happened_on)}{e.spilled ? ", after a spill" : ""}</span>
              </span>
              {confirming === e.id ? (
                <span className="pantry__confirm">
                  <button className="btn btn--danger" onClick={() => remove(e)}>Delete</button>
                  <button className="btn btn--quiet" onClick={() => setConfirming(null)}>Keep</button>
                </span>
              ) : (
                <button className="btn btn--quiet" onClick={() => setConfirming(e.id)}
                  aria-label={`Delete ${eventTitle(e).toLowerCase()} on ${shortDate(e.happened_on)}`}>
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <div className="pcta">
        <button className="btn pcta__btn" onClick={reading.show}>Record a reading</button>
      </div>

      {/* Saving closes the sheet the way every other close does, a step back.
          The container it hands back is shown at once, and the taste factor,
          which that reading may have moved, is read again behind it. */}
      {reading.open && (
        <ReadingSheet
          target={{ id: c.id, name: c.name, description: c.description, read_by: c.read_by, cup_ml: c.cup_ml }}
          onClose={reading.hide}
          onSaved={(next) => { setC(next); reading.hide(); load(); }}
        />
      )}
    </div>
  );
}

function StretchTile({ s, c }: { s: ContainerStretch; c: Container }) {
  const u = used(s, c.read_by);
  const dates = s.to_on ? `${shortDate(s.from_on)} to ${shortDate(s.to_on)}` : `Since ${shortDate(s.from_on)}`;
  const n = s.days !== null ? Math.round(s.days) : null;
  const length = n === null ? "" : n === 0 ? "same day" : `${n} ${n === 1 ? "day" : "days"}`;
  let sub: string;
  switch (s.status) {
    case "open": sub = `Open, ${openLine(c)}`; break;
    case "counted": sub = length; break;
    case "spilled": sub = "Spilled, not counted"; break;
    case "awaiting_tare": sub = "Waiting for the container's empty weight"; break;
    case "awaiting_density": sub = `Waiting for ${c.description.toLowerCase()}'s weight per ml`; break;
    case "inconsistent": sub = "More than was in it, not counted"; break;
  }
  const perDay = s.status === "counted" && u && s.days !== null && s.days >= 1
    ? `${amount(u.raw / s.days)} ${u.unit} a day`
    : null;
  return (
    <div className={`tile stretch stretch--${s.status}`}>
      <span className="stretch__mark" aria-hidden />
      <span className="row__main">
        <span className="row__title">{dates}</span>
        <span className="row__sub">{sub}</span>
      </span>
      <span className="pantry__fig">
        {u && s.status !== "open" && <span className="tnum stretch__used">{u.value} {u.unit}</span>}
        {perDay && <span className="pantry__when">{perDay}</span>}
      </span>
    </div>
  );
}

/** What the open stretch started from: the last reading, or the pack. */
function openLine(c: Container): string {
  const last = [...c.events].reverse().find((e) => e.kind !== "emptied" && e.amount !== null);
  if (!last || last.amount === null || last.unit === null) return "nothing read yet";
  const fig = figure(last.amount, last.unit);
  if (last.kind === "poured_in") return `${fig} poured in`;
  return last.unit === "g" ? `${fig} on the scale` : `${fig} by the marks`;
}

function eventTitle(e: ContainerEvent): string {
  const fig = e.amount !== null && e.unit !== null ? figure(e.amount, e.unit) : null;
  switch (e.kind) {
    case "poured_in": return `Poured in ${fig ?? ""}`.trim();
    case "reading": return e.unit === "ml" ? `Read ${fig} by the marks` : `Weighed ${fig}`;
    case "emptied": return fig ? `Finished, ${fig} left` : "Finished";
  }
}
