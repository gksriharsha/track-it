import { useCallback, useEffect, useRef, useState } from "react";
import {
  beginPairing,
  cancelPairing,
  confirmPairing,
  getHousehold,
  pairingState,
  renameDevice,
  syncNow,
  unpairDevice,
} from "../api";
import type { HouseholdView, PairingOffer, PairingState, Peer } from "../types";
import ScreenHead from "../components/ScreenHead";

interface Props {
  onBack?: () => void;
}

/**
 * The household: which devices share this kitchen, and how the last sync went.
 *
 * What is shared is the kitchen — the pots, the recipes behind them, the packs
 * on the shelf, the vessels on the scale. What is never shared is the eating.
 * Nobody else's device sees your day, your targets or your nutrition, and this
 * screen says so rather than leaving it to be assumed.
 */
export default function Household(p: Props) {
  const [view, setView] = useState<HouseholdView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [pair, setPair] = useState<PairingState | null>(null);

  const back = p.onBack ?? (() => { window.location.hash = "/you"; });

  const load = useCallback(async () => {
    try {
      const h = await getHousehold();
      setView(h);
      setName((n) => (n === "" ? h.device.name : n));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /*
    Leaving the screen has to withdraw the offer.

    On Android the way out of here is the system back gesture, which unmounts
    the screen without going near the cancel button — so without this the
    backend would keep listening for a device to pair, with the code no longer
    on any screen. A ref rather than the state value because the cleanup below
    runs once, on unmount, and closes over whatever `offer` was at mount.
  */
  const offerLive = useRef(false);
  useEffect(() => { offerLive.current = offer !== null; }, [offer]);
  useEffect(
    () => () => { if (offerLive.current) cancelPairing().catch(() => {}); },
    [],
  );

  // Poll only while a QR is on screen. The offer expires on its own, so a
  // forgotten screen stops asking rather than holding a socket open all day.
  const poll = useRef<number | null>(null);
  useEffect(() => {
    if (offer === null) return;
    const tick = async () => {
      try {
        const s = await pairingState();
        setPair(s);
        if (s.stage === "paired") {
          setOffer(null);
          await load();
        }
        if (s.stage === "expired" || s.stage === "failed") setOffer(null);
      } catch (e) {
        setError(String(e));
        setOffer(null);
      }
    };
    tick();
    poll.current = window.setInterval(tick, 1000);
    return () => { if (poll.current !== null) window.clearInterval(poll.current); };
  }, [offer, load]);

  async function rename() {
    const n = name.trim();
    if (n === "") return setError("Give this device a name the rest of the house will recognise.");
    setRenaming(true);
    try {
      await renameDevice(n);
      await load();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setRenaming(false);
    }
  }

  async function startPairing() {
    setError(null);
    setPair({ stage: "waiting" });
    try {
      setOffer(await beginPairing());
    } catch (e) {
      setError(String(e));
      setPair(null);
    }
  }

  async function stopPairing() {
    try { await cancelPairing(); } catch { /* nothing to stop is not an error */ }
    setOffer(null);
    setPair(null);
  }

  async function answer(matches: boolean) {
    try {
      await confirmPairing(matches);
      if (!matches) {
        setOffer(null);
        setPair(null);
        setError(
          "Pairing stopped. The device that answered is not the one showing those digits — " +
            "somebody else on this network tried to join.",
        );
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function forget(peer: Peer) {
    if (
      !window.confirm(
        `Forget “${peer.name}”?\n\nThis device stops syncing with it. The food and recipes ` +
          `that device already has stay on it — there is no server to reach back through. ` +
          `If you have a third device, tell it separately.`,
      )
    ) return;
    try {
      await unpairDevice(peer.device_id);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function runSync() {
    setSyncing(true);
    try {
      await syncNow();
      await load();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  const peers = view?.peers ?? [];
  const shared = view?.shared ?? null;
  const pairing = offer !== null;

  return (
    <div className="screen">
      <ScreenHead
        title="Household"
        sub={
          peers.length === 0
            ? "no other devices yet"
            : `${peers.length} other device${peers.length === 1 ? "" : "s"}`
        }
        onBack={back}
      />

      {error && <p className="alert" role="alert">{error}</p>}

      {/*
        Pairing takes the screen rather than sitting in a card among others.
        It is the one moment this app asks someone to compare what is on the
        glass against something in the room, and everything else on the page is
        beside the point while it is happening.
      */}
      {pairing ? (
        <Pairing
          offer={offer}
          state={pair}
          onAnswer={answer}
          onCancel={stopPairing}
        />
      ) : (
        <>
          {/*
            The boundary, first and unboxed.

            It is the whole idea of the feature and it was a footnote: the
            kitchen crosses, the diary does not. The rule down the middle is
            the content, not decoration — and the asymmetry is the argument.
            The left side counts this person's actual rows; the right side has
            no numbers at all, on purpose, and says why.
          */}
          {shared && (
            <section className="ledger" aria-label="What is shared with your household">
              <div className="ledger__side">
                <h2 className="ledger__head">Shared with your household</h2>
                <dl className="ledger__list">
                  <Count n={shared.pots} of="pots you have going" />
                  <Count n={shared.recipes} of="recipes" />
                  <Count n={shared.foods} of="foods off packs" />
                  <Count n={shared.supplements} of="supplements" />
                  <Count n={shared.vessels_and_bottles} of="vessels and bottles" />
                </dl>
              </div>

              <div className="ledger__side ledger__side--kept">
                <h2 className="ledger__head">Never leaves this device</h2>
                <ul className="ledger__kept">
                  <li>Every meal you have logged</li>
                  <li>Your profile</li>
                  <li>Your targets</li>
                </ul>
                <p className="ledger__why">
                  Not counted here either. Two people can eat from one pot and keep two
                  separate diaries.
                </p>
              </div>
            </section>
          )}

          <div className="hh">
            <section className="hh__main">
              <div className="card">
                <div className="card__head">
                  <h2>Devices</h2>
                  {peers.length > 0 && (
                    <button className="link card__note" onClick={runSync} disabled={syncing}>
                      {syncing ? "syncing…" : "sync now"}
                    </button>
                  )}
                </div>

                {peers.length === 0 ? (
                  <div className="empty">
                    <h3>Nothing else in the house yet</h3>
                    <p>
                      Pair a phone and you both see the same fridge: a pot cooked here shows up
                      there, and a helping taken there comes off it here.
                    </p>
                  </div>
                ) : (
                  <div className="rows">
                    {peers.map((peer) => (
                      <div className="row hh__peer" key={peer.device_id}>
                        {/*
                          Filled for a device that has been reached, hollow for one
                          that has not. Hollow is grey, not orange: a phone that has
                          been in a bag all day is information, not a fault — the same
                          rule that keeps an under-target nutrient neutral until the
                          day is actually over.
                        */}
                        <span
                          className={peer.last_seen_at === null ? "pip pip--cold" : "pip"}
                          aria-hidden="true"
                        />
                        <span className="row__main">
                          <span className="row__title">{peer.name}</span>
                          <span className="row__sub">{seenLine(peer)}</span>
                        </span>
                        <button className="btn btn--danger vrow__btn" onClick={() => forget(peer)}>
                          Forget
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="chips" style={{ marginTop: "var(--s4)" }}>
                  <button className="btn" onClick={startPairing}>Pair a device</button>
                </div>
              </div>

              {view && view.last.length > 0 && (
                <section className="card">
                  <div className="card__head">
                    <h2>Last sync</h2>
                    <span className="card__note">{when(view.last[0].at)}</span>
                  </div>
                  {/* One line per device tried, so a success with the tablet cannot
                      stand in for a failure with the phone. A device that could not
                      be reached is the half worth showing — it is the one leaving
                      this fridge disagreeing with that one. */}
                  {view.last.map((o) => (
                    <p
                      key={o.peer_name + o.at}
                      className={o.ok ? "rangenote" : "alert"}
                      role={o.ok ? undefined : "status"}
                    >
                      <strong>{o.peer_name}</strong> — {o.detail}
                    </p>
                  ))}
                  {view.queued > 0 && (
                    <p className="rangenote">
                      {view.queued} change{view.queued === 1 ? "" : "s"} here{" "}
                      {view.queued === 1 ? "has" : "have"} not reached every device yet.
                    </p>
                  )}
                </section>
              )}
            </section>

            <aside className="hh__rail">
              <div className="card">
                <div className="card__head">
                  <h2>This device</h2>
                </div>
                <label className="vform__cell">
                  <span className="group__name">Name</span>
                  <input
                    className="field"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && rename()}
                    placeholder="Mac in the kitchen"
                    aria-label="What the household calls this device"
                  />
                </label>
                <button
                  className="btn"
                  onClick={rename}
                  disabled={renaming}
                  style={{ marginTop: "var(--s3)", width: "100%" }}
                >
                  {renaming ? "Saving…" : "Rename"}
                </button>
                <p className="rangenote" style={{ marginTop: "var(--s3)" }}>
                  What the rest of the house sees when a pot goes down. Nothing reads your
                  computer’s own name for this — that is a fact about a network, and this is a
                  list of things in a kitchen.
                </p>
              </div>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One count, set the way every other metric in this app is: the numeral in the
 * serif, doing the work, with the thing it counts beside it in quiet sans.
 */
function Count({ n, of }: { n: number; of: string }) {
  return (
    <div className="ledger__row">
      <dt className="ledger__n num">{n}</dt>
      <dd className="ledger__of">{of}</dd>
    </div>
  );
}

/**
 * Pairing, given the whole screen.
 *
 * Two states and they are deliberately different in weight. Waiting is quiet —
 * a code to point a camera at. Confirming is the loudest thing in the app: six
 * digits at the size of the day's energy figure, because getting them wrong
 * lets a stranger into the kitchen.
 */
function Pairing(p: {
  offer: PairingOffer;
  state: PairingState | null;
  onAnswer: (matches: boolean) => void;
  onCancel: () => void;
}) {
  if (p.state?.stage === "confirming") {
    return (
      <section className="pair">
        <h2 className="pair__ask">Do these match?</h2>
        <p className="pair__digits num">{p.state.digits}</p>
        <p className="pair__say">
          <strong>{p.state.peer_name}</strong> answered. Both screens should show the same six
          digits. If they differ, the device that answered is not the one in your hand.
        </p>
        <div className="pair__acts">
          <button className="btn" onClick={() => p.onAnswer(true)}>They match</button>
          <button className="btn btn--danger" onClick={() => p.onAnswer(false)}>
            They do not
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="pair">
      <h2 className="pair__ask">Scan this on the other device</h2>
      <QrBlock payload={p.offer.payload} />
      <p className="pair__say">
        Open this screen on the other device and point its camera here. The code carries where
        to find this device and how to talk to it. Nothing goes over the internet, and no server
        is involved. It stops working in two minutes.
      </p>
      <div className="pair__acts">
        <button className="btn btn--quiet" onClick={p.onCancel}>Cancel</button>
      </div>
    </section>
  );
}

/**
 * The pairing payload as a QR code.
 *
 * A placeholder until the backend returns the module bitmap it will draw from —
 * the code is generated next to the key material rather than in the webview, so
 * the payload is never assembled twice in two languages. Showing the raw
 * payload meanwhile is deliberate: it is honest about what has been built, and
 * it is scannable by eye during development.
 */
function QrBlock({ payload }: { payload: string }) {
  return (
    <div className="qrblock">
      <div className="qrblock__box" aria-hidden="true">QR</div>
      <code className="qrblock__payload">{payload}</code>
    </div>
  );
}

/**
 * When a device was last heard from.
 *
 * "Paired, not yet synced" is its own line rather than an old date: it says the
 * pairing exists and nothing has come through it, which is a different problem
 * from a phone that has been in a bag since Tuesday.
 */
function seenLine(peer: Peer): string {
  if (peer.last_seen_at === null) return "paired, not synced yet";
  return `last synced ${when(peer.last_seen_at)}`;
}

function when(instant: string): string {
  const then = new Date(instant);
  if (Number.isNaN(then.getTime())) return "at an unknown time";
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return then.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
