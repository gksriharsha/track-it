import Glyph from "../components/Glyph";
import ScreenHead from "../components/ScreenHead";
import Unpack from "../components/Unpack";
import { useHashSheet } from "../lib/hashSheet";
import { shortDate } from "../lib/pantry";
import { useKitchen } from "../lib/useKitchen";

interface Props {
  onBack?: () => void;
  onOpenPantry: () => void;
  onOpenFridge: () => void;
  onOpenJars: () => void;
  onOpenPot: (cookId: string) => void;
}

const things = (n: number) => (n === 1 ? "1 thing" : `${n} things`);

/**
 * The kitchen: the cupboard and the fridge drawn side by side, each opening on
 * what is in it, and the pots underneath, since a pot is what a meal is most
 * often taken from. Everything here fills itself from cooking and logging.
 */
export default function Kitchen(p: Props) {
  const k = useKitchen();
  const { counts, pots } = k;
  const put = useHashSheet("put", "away");

  return (
    <div className="screen">
      <ScreenHead title="Kitchen" onBack={p.onBack} action={<button className="btn btn--quiet" onClick={put.show}>Put away</button>} />
      {k.error && <p className="alert" role="alert">{k.error}</p>}

      <section className="kit" aria-label="Your cupboard and fridge">
        <div className="kit__scene">
          <button className="kit__piece" style={{ ["--i" as string]: 0 }} onClick={p.onOpenPantry}>
            <CupboardArt />
            <span className="kit__name"><b>Pantry</b><span>{counts ? things(counts.pantry) : "…"}</span></span>
          </button>
          <button className="kit__piece kit__piece--fridge" style={{ ["--i" as string]: 1 }} onClick={p.onOpenFridge}>
            <FridgeArt />
            <span className="kit__name">
              <b>Fridge</b>
              <span>{counts ? (counts.freezer > 0 ? `${counts.fridge}, and ${counts.freezer} frozen` : things(counts.fridge)) : "…"}</span>
            </span>
          </button>
        </div>
      </section>

      {pots && pots.length > 0 && (
        <section>
          <h2 className="kit__h">Pots in the fridge</h2>
          <div className="tiles">
            {pots.map((c) => (
              <button key={c.id} className="tile kit__row" onClick={() => p.onOpenPot(c.id)}>
                <span className="lead lead--cook" aria-hidden><Glyph name="pot" size={20} /></span>
                <span className="row__main">
                  <span className="row__title">{c.name}</span>
                  <span className="row__sub">Cooked {shortDate(c.cooked_on)}</span>
                </span>
                <span className="kit__left tnum">{Math.round(c.remaining_g)} g left</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="tiles">
        <button className="tile kit__row" onClick={p.onOpenJars}>
          <span className="lead lead--own" aria-hidden><Glyph name="jar" size={20} /></span>
          <span className="row__main">
            <span className="row__title">Jars you weigh</span>
            <span className="row__sub">Salt, oil and the rest, read by the jar</span>
          </span>
          <span className="row__chev" aria-hidden>›</span>
        </button>
      </div>

      <Unpack open={put.open} onClose={put.hide} foods={k.foods ?? []} today={k.today} counts={counts} onChanged={k.load} />
    </div>
  );
}

function CupboardArt() {
  return (
    <svg className="kit__art" viewBox="0 0 140 196" width="140" height="196" aria-hidden>
      <rect x="2" y="2" width="136" height="180" rx="10" fill="var(--k-body)" stroke="var(--k-ink)" strokeWidth="1.6" />
      <rect x="10" y="10" width="57" height="164" rx="6" fill="var(--k-door)" stroke="var(--line)" strokeWidth="1.5" />
      <rect x="73" y="10" width="57" height="164" rx="6" fill="var(--k-door)" stroke="var(--line)" strokeWidth="1.5" />
      <circle cx="59" cy="92" r="4" fill="var(--k-plank)" />
      <circle cx="81" cy="92" r="4" fill="var(--k-plank)" />
      <rect x="16" y="182" width="16" height="12" rx="3" fill="var(--k-plank)" />
      <rect x="108" y="182" width="16" height="12" rx="3" fill="var(--k-plank)" />
    </svg>
  );
}

function FridgeArt() {
  return (
    <svg className="kit__art" viewBox="0 0 120 232" width="120" height="232" aria-hidden>
      <rect x="2" y="2" width="116" height="226" rx="14" fill="var(--k-body)" stroke="var(--k-ink)" strokeWidth="1.6" />
      <rect className="kit__slit" x="9" y="74" width="102" height="148" rx="8" fill="var(--k-glow)" />
      <g className="kit__door">
        <rect x="7" y="72" width="106" height="151" rx="9" fill="var(--k-door)" stroke="var(--line)" strokeWidth="1.5" />
        <rect x="15" y="86" width="6" height="56" rx="3" fill="var(--k-plank)" />
      </g>
      <rect x="7" y="7" width="106" height="60" rx="9" fill="var(--k-door)" stroke="var(--line)" strokeWidth="1.5" />
      <rect x="15" y="34" width="6" height="26" rx="3" fill="var(--k-plank)" />
    </svg>
  );
}
