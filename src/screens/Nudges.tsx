import { useEffect, useState } from "react";
import { getNudges, setNudges, type Nudges as State } from "../api";
import Info from "../components/Info";
import ScreenHead from "../components/ScreenHead";

const ROW = { gridTemplateColumns: "1fr auto" } as const;

/** "13:00" in the phone's own clock style: "1:00 pm" or "13:00". */
const clock = (t: string) =>
  new Date(2000, 0, 1, Number(t.slice(0, 2)), Number(t.slice(3))).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

/** Times of day this phone sends a quiet reminder to log. Android only. */
export default function Nudges(p: { onBack: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getNudges().then(setState).catch((e) => setError(String(e)));
  }, []);

  async function save(times: string[]) {
    setError(null);
    try {
      setState(await setNudges(times));
    } catch (e) {
      setError(String(e));
    }
  }

  const times = state?.times ?? [];

  return (
    <div className="screen">
      <ScreenHead title="Nudges" onBack={p.onBack} />
      {error && <p className="alert" role="alert">{error}</p>}
      {state && !state.enabled && times.length > 0 && (
        <p className="alert" role="alert">Notifications are off for TrackIt. Turn them on in Android settings.</p>
      )}

      <section className="card">
        <div className="card__head">
          <h2>Reminders to log</h2>
          <Info title="How nudges work">
            <p>
              Every day at each time, the phone shows one notification. Tapping it opens the food
              search. A nudge you did not open is replaced by the next one, never stacked.
            </p>
            <p>Android may send one up to ten minutes late to save battery.</p>
          </Info>
          <span className="card__note">{times.length ? "every day" : "none set"}</span>
        </div>
        {times.length > 0 && (
          <div className="rows">
            {times.map((t) => (
              <div key={t} className="row" style={ROW}>
                <span className="row__title tnum">{clock(t)}</span>
                <button className="link" onClick={() => save(times.filter((x) => x !== t))} aria-label={`Remove ${clock(t)}`}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <form
          className="formgrid"
          style={{ marginTop: "var(--s4)", gridTemplateColumns: "1fr auto", alignItems: "end" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (typed && !times.includes(typed)) void save([...times, typed]);
            setTyped("");
          }}
        >
          <label>
            <span className="group__name">Add a time</span>
            {/* The native picker draws its clock dark on dark without this. */}
            <input className="field tnum" type="time" style={{ colorScheme: "light dark" }} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
          <button className="btn btn--quiet" type="submit" disabled={!typed}>Add</button>
        </form>
      </section>
    </div>
  );
}
