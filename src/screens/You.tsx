import { useCallback, useEffect, useState } from "react";
import { getGoals } from "../api";
import type { GoalsView } from "../types";
import ScreenHead from "../components/ScreenHead";

interface Props {
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onOpenImport: () => void;
}

/**
 * The profile's home, and the one place it lives instead of a bare icon.
 *
 * An unlabelled avatar in the corner of the header used to be the only way in,
 * which told the user nothing about what it opened or why they would tap it.
 * This screen is a real destination: it states what a profile buys before
 * asking for one, the same "what this changes" framing Profile itself opens
 * with, so arriving here from the nav and arriving here mid-onboarding read
 * the same way.
 */
export default function You(p: Props) {
  const [view, setView] = useState<GoalsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await getGoals());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const profile = view?.profile ?? null;
  const placed = view?.group_label ?? null;
  const inForce = view?.energy_target ?? null;

  const identity = placed
    ? placed
    : profile?.sex || profile?.birth_year
      ? "Profile started"
      : "No profile yet";

  const identitySub = [
    profile?.birth_year ? `Born ${profile.birth_year}` : null,
    profile?.height_cm ? `${profile.height_cm} cm` : null,
    profile?.weight_kg ? `${profile.weight_kg} kg` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="screen screen--list">
      <ScreenHead title="You" sub="who the targets are for" />

      {error && <p className="alert" role="alert">{error}</p>}

      {/* Identity, stated plainly rather than as an icon standing for it. */}
      <button
        className="row"
        style={{ gridTemplateColumns: "auto 1fr auto", padding: "var(--s3) var(--s2)" }}
        onClick={p.onOpenProfile}
      >
        <span
          aria-hidden
          style={{
            width: 48, height: 48, borderRadius: "var(--r-pill)",
            background: "var(--accent-wash)", display: "grid", placeItems: "center", flex: "none",
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent-ink)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8.5" r="3.4" />
            <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
          </svg>
        </span>
        <span className="row__main">
          <span className="row__title" style={{ fontSize: 17, fontWeight: 600 }}>{identity}</span>
          {identitySub && <span className="row__sub">{identitySub}</span>}
        </span>
        <span className="row__chev" aria-hidden>›</span>
      </button>

      {/* What the profile currently buys — the same framing Profile opens
          with, so this reads as one continuous story rather than two. */}
      <section className="card">
        <div className="card__head">
          <h2>What this changes</h2>
        </div>
        <div className="rows">
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <span className="row__main">
              <span className="row__title">Nutrient targets</span>
              <span className="row__sub">
                {placed
                  ? `Read against the DRIs for ${placed.toLowerCase()}`
                  : "Falling back to FDA Daily Values — one adult column, the figure on a food label"}
              </span>
            </span>
            <span className={`pill${placed ? " is-on" : ""}`}>
              {placed ? "personalised" : "generic"}
            </span>
          </div>
          <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
            <span className="row__main">
              <span className="row__title">Energy target</span>
              <span className="row__sub">
                {inForce === null
                  ? "No target. The day shows what you ate and draws no progress bar"
                  : inForce.basis === "user_set"
                    ? `${Math.round(inForce.kcal).toLocaleString()} kcal, the figure you set`
                    : `About ${Math.round(inForce.kcal).toLocaleString()} kcal, estimated from your body`}
              </span>
            </span>
            <span className={`pill${inForce ? " is-on" : ""}`}>
              {inForce === null ? "none" : inForce.basis === "user_set" ? "yours" : "estimated"}
            </span>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card__head">
          <h2>Settings</h2>
        </div>
        <div className="rows">
          <button className="row" style={{ gridTemplateColumns: "1fr auto" }} onClick={p.onOpenProfile}>
            <span className="row__main">
              <span className="row__title">Profile</span>
              <span className="row__sub">Age, body, life stage</span>
            </span>
            <span className="row__chev" aria-hidden>›</span>
          </button>
          <button className="row" style={{ gridTemplateColumns: "1fr auto" }} onClick={p.onOpenSettings}>
            <span className="row__main">
              <span className="row__title">Targets &amp; goals</span>
              <span className="row__sub">What every percentage is measured against</span>
            </span>
            <span className="row__chev" aria-hidden>›</span>
          </button>
          <button className="row" style={{ gridTemplateColumns: "1fr auto" }} onClick={p.onOpenImport}>
            <span className="row__main">
              <span className="row__title">Import a spreadsheet</span>
              <span className="row__sub">Bring in a log you kept elsewhere</span>
            </span>
            <span className="row__chev" aria-hidden>›</span>
          </button>
        </div>
      </section>

      <p style={{ color: "var(--ink-3)", fontSize: 12, textAlign: "center", margin: "var(--s2) 0" }}>
        Everything stays on this device, in the same file as your food log.
      </p>
    </div>
  );
}
