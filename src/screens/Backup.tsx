import { useCallback, useEffect, useState } from "react";
import {
  backupStatus,
  changeBackupPassphrase,
  disableLogEncryption,
  enableLogEncryption,
  removeSealedBackup,
  restoreBackup,
  sealBackupNow,
  setAutoReseal,
} from "../api";
import type { BackupStatus, RestoreOutcome } from "../types";
import ScreenHead from "../components/ScreenHead";

interface Props {
  onBack?: () => void;
}

/**
 * A file size in the units a person reads, with no rounding that flatters it.
 *
 * One decimal place from a megabyte upward, because the figure sits beside a
 * 25 MB limit and "4 MB" against "25 MB" hides the difference between 4.1 and
 * 4.9 that decides whether the next month of meals still fits.
 */
function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A stored ISO instant as a date somebody would say out loud. */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * What the phone's keystore is holding the key in, said rather than claimed.
 *
 * Four sentences and no fifth. The temptation here is to reassure — "your key
 * is safe in secure hardware" — on a phone that quietly handed back a software
 * key, and a screen that does that once cannot be trusted about anything else
 * on it.
 */
function keystoreLine(s: BackupStatus): string {
  if (!s.keystore.available || !s.keystore_holds_key) {
    return (
      s.keystore.note ??
      "this phone's keystore is not holding the key, so you will be asked for the passphrase each time"
    );
  }
  switch (s.keystore.hardware) {
    case "strongbox":
      return "The key that lets this app open the log without asking you is held by Android's keystore, in a separate security chip.";
    case "tee":
      return "The key that lets this app open the log without asking you is held by Android's keystore, in secure hardware.";
    case "software":
      return "The key that lets this app open the log without asking you is held by Android's keystore, in software on this device.";
    default:
      return "The key that lets this app open the log without asking you is held by Android's keystore. This phone did not say what is holding it.";
  }
}

/**
 * Encryption, and the one file that may leave this phone.
 *
 * A screen of its own rather than a section of Settings, because Settings is
 * about what a nutrient figure is read against and this is about nothing of the
 * kind. Android only: SQLCipher is compiled into the Android build alone and
 * Google's Auto Backup exists nowhere else, so on a desktop this screen is not
 * in the drawer at all.
 *
 * The whole design brief for the copy on this page is: be truthful rather than
 * reassuring. Every card says what the app does NOT do alongside what it does,
 * and the two consents — setting a passphrase, and making a file eligible to
 * leave — are two separate buttons because they are two separate decisions.
 *
 * No bar, no ring, no percentage, no streak. The one quantity is a file size
 * printed as an amount with its named published limit beside it, in the app's
 * canonical `.nval` shape. Over the limit it does NOT take `.is-over`: that ink
 * is reserved for a nutrient past a real ceiling such as sodium above its CDRR,
 * and spending it on a file size would teach the reader to discount it where it
 * matters.
 */
export default function Backup(p: Props) {
  const [s, setS] = useState<BackupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [current, setCurrent] = useState("");
  const [restorePass, setRestorePass] = useState("");
  const [restored, setRestored] = useState<RestoreOutcome | null>(null);

  const back = p.onBack ?? (() => { window.location.hash = "/you"; });

  const load = useCallback(async () => {
    try {
      setS(await backupStatus());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Every button on this page goes through here.
   *
   * Argon2id is roughly a second and a half of deliberate, memory-hard work, so
   * a busy state is not a nicety on this screen — without it the phone looks
   * frozen at the exact moment somebody is being asked to trust it with the
   * only copy of a year of meals. The passphrase fields are cleared on success
   * and only on success, so a refusal does not make somebody type it again.
   */
  async function run(name: string, f: () => Promise<BackupStatus>, clear?: () => void) {
    setBusy(name);
    setError(null);
    try {
      setS(await f());
      clear?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doRestore() {
    setBusy("restore");
    setError(null);
    try {
      setRestored(await restoreBackup(restorePass));
      setRestorePass("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  if (s !== null && !s.supported) {
    return (
      <div className="screen">
        <ScreenHead title="Backup" sub="an Android feature" onBack={back} />
        <section className="card">
          <p className="note">
            Encrypting the log and backing it up through Google are Android features. This
            build is running on the desktop, where the log is a file you can copy yourself.
          </p>
        </section>
      </div>
    );
  }

  const sealed = s?.sealed_bytes ?? null;

  return (
    <div className="screen">
      <ScreenHead
        title="Backup"
        sub="one sealed file, and what Google can and cannot do with it"
        onBack={back}
      />

      {error && <p className="alert" role="alert">{error}</p>}

      {/*
        The truthful card, first and unhedged.

        It is here rather than at the bottom because it is the thing somebody
        needs before they decide anything else on the page, and because a
        limitation moved to the end of a page is a limitation nobody read.
      */}
      <section className="card">
        <div className="card__head"><h2>What leaves this phone</h2></div>
        <p className="note">
          One file: an encrypted copy of your log. It is sealed on this phone, with a
          passphrase you choose, before anything can pick it up. Google carries that file
          into your own Google account and cannot read it. The passphrase is never sent
          anywhere, and is not kept on this phone either.
        </p>
        <p className="note">
          Your photographs of packs are not carried, and neither is the reference food
          database — that one is already inside the app.
        </p>
        {s?.sealed_dir && (
          <p className="note">The file lives at {s.sealed_dir}/trackit-backup.tkb, and nothing else in that folder travels.</p>
        )}
      </section>

      {/*
        Encryption of the database on the phone. Separate from the sealed copy,
        and the two are not the same guarantee — which is the distinction this
        card exists to make rather than let the word "encrypted" in a screen
        title stand in for both.
      */}
      <section className="card">
        <div className="card__head">
          <h2>The log on this phone</h2>
          <span className="card__note">
            {s === null ? "…" : s.encrypted ? "encrypted" : "not encrypted"}
          </span>
        </div>

        {s && !s.encrypted && (
          <>
            <p className="note">
              Right now the log is an ordinary database file. Anything that can already read
              this app's private storage can read it — which on a phone with a screen lock
              means the phone's own storage encryption is what protects it, not this app.
            </p>
            <p className="note">
              Encrypting it takes a recovery passphrase, and it takes one for a reason there
              is no way around: the key is held by this phone's keystore so the app can open
              the log without asking you, and if the phone ever loses that key the passphrase
              is the only thing left that can get the log back. There is nothing that can
              reset it. Choose something you will still have in a year.
            </p>
            <div className="formgrid">
              <label>
                <span className="group__name">Recovery passphrase</span>
                <input className="field" type="password" autoComplete="new-password"
                  value={pass} onChange={(e) => setPass(e.target.value)} />
              </label>
              <label>
                <span className="group__name">And again</span>
                <input className="field" type="password" autoComplete="new-password"
                  value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </label>
            </div>
            <div className="commit">
              {/* Says what it does, not "Save". This button rewrites the
                  database, and a button that rewrites the database should not
                  be indistinguishable from one that stores a preference. */}
              <button className="btn" disabled={busy !== null}
                onClick={() => run("enable", () => enableLogEncryption(pass, confirm), () => {
                  setPass("");
                  setConfirm("");
                })}>
                {busy === "enable" ? "Encrypting the log…" : "Set the passphrase and encrypt the log"}
              </button>
            </div>
            <p className="note">
              This does not upload anything. Making a copy Google may carry is a separate
              choice, below, and it is not made for you.
            </p>
          </>
        )}

        {s?.encrypted && (
          <>
            <p className="note">{keystoreLine(s)}</p>
            <p className="note">
              The log is encrypted with a key this app holds. Your recovery passphrase is
              wrapped around a copy of that key, in the sealed file and in a file beside the
              database — so a new phone with only the passphrase can still open a copy.
            </p>

            <div className="card__head" style={{ marginTop: "var(--s4)" }}>
              <h2>Change the passphrase</h2>
            </div>
            <div className="formgrid">
              <label>
                <span className="group__name">Current passphrase</span>
                <input className="field" type="password" autoComplete="current-password"
                  value={current} onChange={(e) => setCurrent(e.target.value)} />
              </label>
              <label>
                <span className="group__name">New passphrase</span>
                <input className="field" type="password" autoComplete="new-password"
                  value={pass} onChange={(e) => setPass(e.target.value)} />
              </label>
              <label>
                <span className="group__name">And again</span>
                <input className="field" type="password" autoComplete="new-password"
                  value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </label>
            </div>
            <div className="commit">
              <button className="btn" disabled={busy !== null}
                onClick={() => run("change",
                  () => changeBackupPassphrase(current, pass, confirm),
                  () => { setCurrent(""); setPass(""); setConfirm(""); })}>
                {busy === "change" ? "Changing…" : "Change the passphrase"}
              </button>
            </div>
            <p className="note">
              This changes what opens the log, straight away. It does not re-seal the copy on
              this phone: that copy still opens with the OLD passphrase until you seal a fresh
              one, and it will say so below. The same is true of any copy you have already
              carried somewhere else — the passphrase that sealed a file is recorded inside
              that file, and this app cannot reach a file it no longer has.
            </p>

            <div className="commit">
              <button className="btn btn--danger" disabled={busy !== null}
                onClick={() => run("disable", () => disableLogEncryption(current),
                  () => setCurrent(""))}>
                {busy === "disable" ? "Decrypting…" : "Stop encrypting the log"}
              </button>
            </div>
            <p className="note">
              Turning it off needs the current passphrase, above, and rewrites the log as an
              ordinary database file. The encrypted one it replaces is renamed and kept, not
              deleted.
            </p>
          </>
        )}
      </section>

      {/*
        The sealed copy. The amount over its named published limit, which is the
        app's one form for a figure — see `.nval` in styles.css. No bar: there
        is nothing here to fill toward.
      */}
      {s?.encrypted && (
        <section className="card">
          <div className="card__head">
            <h2>The sealed copy</h2>
            {sealed !== null && (
              <span className="nval">
                <span className="nval__amt">{bytes(sealed)}</span>
                <span className="nval__ref">Auto Backup limit {bytes(s.quota_bytes)}</span>
              </span>
            )}
          </div>

          {sealed === null ? (
            <div className="empty">
              <h3>Nothing sealed yet</h3>
              <p>
                Sealing writes one encrypted file into the folder Android is allowed to carry.
                Until you do, nothing about your log is eligible to leave this phone.
              </p>
              <button className="btn" disabled={busy !== null}
                onClick={() => run("seal", sealBackupNow)}>
                {busy === "seal" ? "Sealing…" : "Seal a copy Google may carry"}
              </button>
            </div>
          ) : (
            <>
              <p className="note">
                {s.sealed_at !== null ? `Sealed ${when(s.sealed_at)}.` : "Sealed."}
                {s.stale ? " The log has moved on since, or the passphrase has." : ""}
                {s.plain_bytes !== null
                  ? ` The log inside it was ${bytes(s.plain_bytes)} before compression.`
                  : ""}
              </p>
              {s.over_quota && (
                <p className="note">
                  This file is larger than the {bytes(s.quota_bytes)} Google's backup service
                  will carry, so it has stopped carrying it. Android does not say so — this is
                  the app checking. Nothing is lost, the log on this phone is untouched, but
                  there is no copy off it.
                </p>
              )}
              <div className="commit">
                <button className="btn" disabled={busy !== null}
                  onClick={() => run("seal", sealBackupNow)}>
                  {busy === "seal" ? "Sealing…" : "Seal a fresh copy"}
                </button>
                <button className="btn btn--quiet" disabled={busy !== null}
                  onClick={() => run("auto", () => setAutoReseal(!s.auto_reseal))}>
                  {s.auto_reseal ? "Stop re-sealing on its own" : "Re-seal on its own"}
                </button>
                <button className="btn btn--danger" disabled={busy !== null}
                  onClick={() => run("remove", removeSealedBackup)}>
                  Delete the sealed copy
                </button>
              </div>
              <p className="note">
                Sealing writes the file. It does not upload it — only Google's backup service
                does that. Deleting it removes the file from this phone; whatever Google has
                already taken is Google's to expire, and this app cannot reach it.
              </p>
            </>
          )}
        </section>
      )}

      {/*
        What Auto Backup actually does, verbatim, because over-promising here is
        the failure mode. Every one of these four sentences is a thing a person
        would otherwise discover by losing a phone.

        Rendered only once the status has loaded, so the quota figure is the
        app's own constant rather than a number written twice — once here and
        once in Rust — that would silently disagree the day one of them changed.
      */}
      {s !== null && (
        <section className="card">
          <div className="card__head"><h2>What Google's backup actually does</h2></div>
          <p className="note">
            It only runs if Backup by Google One is switched on in this phone's own settings.
            TrackIt cannot switch it on and cannot tell whether it is.
          </p>
          <p className="note">
            It runs on the system's schedule — roughly once a day, while the phone is charging,
            idle and on Wi-Fi. Not when you ask.
          </p>
          <p className="note">
            It carries at most {bytes(s.quota_bytes)} for one app. Over that, Android stops
            backing the app up and tells nobody.
          </p>
          <p className="note">
            On Android 9 and later Google encrypts the backup again with your device PIN. This
            app does not rely on that: the file is already sealed with your passphrase before
            Google sees it. And TrackIt is never told that an upload happened — nothing on
            this screen can confirm one.
          </p>
        </section>
      )}

      {/* Restore, shown whenever a sealed file is present rather than only on a
          fresh install: a phone that has been used since is exactly the phone
          somebody might want to put an older copy back onto, and hiding the
          option would mean deciding that for them. */}
      {sealed !== null && (
        <section className="card">
          <div className="card__head"><h2>Restore from the sealed copy</h2></div>
          {restored !== null ? (
            <>
              <p className="note">
                Restored {restored.entries} {restored.entries === 1 ? "entry" : "entries"} from
                the copy sealed {when(restored.sealed_at)}.
              </p>
              <p className="note">
                The log this replaced is kept at {restored.superseded_path}. It is not deleted.
                {restored.replaced_earlier_superseded
                  ? " The copy an earlier restore had kept has been removed to make room for it — only the most recent one is held."
                  : ""}
              </p>
              <p className="note">
                This phone now carries the identity of the phone the copy came from. If both
                phones still exist, unpair the old one on the Household screen before syncing.
              </p>
            </>
          ) : (
            <>
              <p className="note">
                This replaces the log on this phone with the sealed copy. The database being
                replaced is renamed and kept, not deleted, and this screen will say where it
                went.
              </p>
              <div className="formgrid">
                <label>
                  <span className="group__name">Recovery passphrase</span>
                  <input className="field" type="password" autoComplete="current-password"
                    value={restorePass} onChange={(e) => setRestorePass(e.target.value)} />
                </label>
              </div>
              <div className="commit">
                <button className="btn" disabled={busy !== null} onClick={doRestore}>
                  {busy === "restore" ? "Restoring…" : "Replace this log with the sealed copy"}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {s?.superseded_path && restored === null && (
        <section className="card">
          <div className="card__head"><h2>An earlier log is still here</h2></div>
          {/* Deliberately does not say what state that file is in. A restore
              supersedes whatever was live — which may have been an empty
              plaintext database on a phone four minutes old — and turning
              encryption off supersedes an encrypted one. Asserting either here
              would be right half the time. */}
          <p className="note">
            Something on this phone kept the log it replaced, at {s.superseded_path}. It is not
            deleted. Only the most recent one is held: the next thing that replaces the log
            removes it.
          </p>
        </section>
      )}
    </div>
  );
}
