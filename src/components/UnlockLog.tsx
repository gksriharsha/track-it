import { useEffect, useState } from "react";
import { backupStatus, restoreBackup, unlockLog } from "../api";
import type { BackupStatus } from "../types";
import { isAndroid } from "../lib/desktop";

interface Props {
  /** Called once the log is open, so the app can draw itself. */
  onOpened: () => void;
}

/**
 * The two things that have to happen before the app can be used at all, and
 * only when they have to.
 *
 * The first is a LOCKED log: the database is SQLCipher-encrypted and this
 * phone's keystore could not hand the key back. That is rare — the wrapping key
 * requires no user authentication precisely so that a new fingerprint or a
 * removed lock screen cannot invalidate it — but when it happens the recovery
 * passphrase is the way in, and the app must ask rather than refuse to start.
 *
 * The second is a FRESH INSTALL that Google has just delivered a sealed copy
 * to. Auto Backup restores the file and says nothing; without this the user
 * opens a new phone, sees an empty log, and reasonably concludes the backup
 * never worked. So the offer is made here, at the front, rather than left
 * behind a drawer item on a phone somebody has owned for four minutes.
 *
 * Everything else — and this is the point of it being a gate rather than a
 * screen — is not drawn. A locked session's database connection is an empty
 * in-memory one on purpose, so any command that reached it would fail rather
 * than quietly accept a meal into something that vanishes with the process.
 */
export default function UnlockLog(p: Props) {
  const [s, setS] = useState<BackupStatus | null>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /*
    Asked once, at mount, and only on Android.

    Off Android `backup_status` answers with `supported: false` and this
    component decides it has nothing to do — which is why it asks rather than
    branching on the platform twice.
  */
  useEffect(() => {
    if (!isAndroid()) {
      setDone(true);
      p.onOpened();
      return;
    }
    let live = true;
    backupStatus()
      .then((st) => {
        if (!live) return;
        setS(st);
        if (!st.supported || (!st.locked && !st.restore_available)) {
          setDone(true);
          p.onOpened();
        }
      })
      .catch(() => {
        // A status call that fails is not a reason to hold the app shut. The
        // ordinary path is far more likely to be right than this component is.
        if (!live) return;
        setDone(true);
        p.onOpened();
      });
    return () => { live = false; };
    // An empty dependency list on purpose, and `p.onOpened` is deliberately not
    // in it: this is a launch gate, asked once, and re-running it on a parent
    // re-render would put the passphrase field back over an app that is already
    // open. The `live` flag is what makes the single run safe to unmount.
  }, []);

  if (done || s === null) return null;

  const locked = s.locked;

  async function go() {
    setBusy(true);
    setError(null);
    try {
      if (locked) await unlockLog(pass);
      else await restoreBackup(pass);
      setPass("");
      setDone(true);
      p.onOpened();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Skip the offer. Only ever offered for a RESTORE — a locked log has nothing
   *  behind it to skip to. */
  function skip() {
    setDone(true);
    p.onOpened();
  }

  return (
    <div className="screen">
      <header className="head">
        <div className="head__row">
          <div className="head__text">
            <h1 className="head__title">{locked ? "The log is locked" : "There is a backup for this phone"}</h1>
            <p className="head__sub">
              {locked ? "your recovery passphrase opens it" : "sealed on a phone, carried here by Google"}
            </p>
          </div>
        </div>
      </header>

      {error && <p className="alert" role="alert">{error}</p>}

      <section className="card">
        {locked ? (
          <p className="note">
            {s.locked_note ??
              "This phone's keystore is no longer holding the key to the log. Your recovery passphrase still opens it."}
          </p>
        ) : (
          <p className="note">
            Nothing is logged on this phone yet, and there is a sealed copy of a log here that
            Google's backup service delivered. Your recovery passphrase opens it. Nothing is
            replaced until you ask.
          </p>
        )}

        <div className="formgrid">
          <label>
            <span className="group__name">Recovery passphrase</span>
            <input className="field" type="password" autoComplete="current-password"
              value={pass} onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !busy) go(); }} />
          </label>
        </div>

        <div className="commit">
          <button className="btn" disabled={busy} onClick={go}>
            {busy
              ? locked ? "Opening…" : "Restoring…"
              : locked ? "Open the log" : "Restore the log"}
          </button>
          {!locked && (
            <button className="btn btn--quiet" disabled={busy} onClick={skip}>
              Start fresh instead
            </button>
          )}
        </div>

        <p className="note">
          {locked
            ? "This takes a moment on purpose. The passphrase is run through a deliberately slow calculation, which is what makes guessing it expensive."
            : "Starting fresh leaves the sealed copy where it is. You can restore it later from the Backup screen."}
        </p>
      </section>
    </div>
  );
}
