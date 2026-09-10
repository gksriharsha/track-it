package com.kgundu1.trackit.widget

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * The one thing the widgets are allowed to read.
 *
 * Not the log database. An `AppWidgetProvider` is a `BroadcastReceiver`, and
 * when the system sends it an update with the app closed the process starts with
 * no Activity, no Tauri runtime and none of Rust's managed state — and once the
 * database is encrypted the key may not even be available while the phone is
 * locked. So Rust computes and formats, and these two files hold nothing but the
 * finished strings.
 *
 * They live under `no_backup/` because Android documents that directory as never
 * automatically backed up. `SharedPreferences` would have been the obvious home
 * and is exactly wrong: it IS swept into Auto Backup by default, which would put
 * a person's figures on a Google server because their phone was set up with
 * backup on.
 *
 * Nothing in this file parses a number. That is deliberate and it is the same
 * rule that keeps nutrient arithmetic out of JavaScript: a figure Rust could not
 * measure arrives as the words "not recorded", and there is no code path here
 * that could turn it into a zero on the way to the screen.
 */
internal object WidgetSnapshot {
    /** Must match `widgets::dir_in` in src-tauri/src/widgets.rs. */
    private const val DIR = "widget"
    private const val AGGREGATE = "aggregate.json"
    private const val QUICKADD = "quickadd.json"

    /**
     * The version each file's reader understands.
     *
     * A file stamped with anything else is treated as absent rather than read
     * optimistically. An APK downgraded by a sideload, or an upgrade that has
     * written the new shape before the old receiver was replaced, would
     * otherwise render half-understood fields — and a widget showing a figure
     * against the wrong label is worse than one saying "Open TrackIt".
     */
    private const val VERSION = 1

    fun dir(context: Context): File = File(context.noBackupFilesDir, DIR)

    /** One line of the aggregate widget, exactly as Rust wrote it. */
    internal data class Row(
        val label: String,
        val value: String,
        /** The reference figure with its basis named, or null where none is published. */
        val ref: String?,
        /** The range most days fell in, or null when there were too few days. */
        val note: String?,
    )

    internal data class Aggregate(
        val period: String,
        /** The coverage sentence, anchored to a date. Empty when nothing is logged. */
        val basis: String,
        val asOf: String,
        val rows: List<Row>,
        /** What to say where the rows would be, when there are none. */
        val note: String?,
    )

    internal data class Food(val label: String, val kind: String, val id: String)

    internal data class QuickAdd(
        val foods: List<Food>,
        val note: String?,
    )

    /**
     * Null means "nothing published yet", which every caller renders as an
     * invitation to open the app. Never as zeroes: a figure that was never
     * measured and a figure that is zero are different facts, and the whole app
     * is built on not confusing them.
     */
    fun aggregate(context: Context): Aggregate? {
        val o = document(context, AGGREGATE) ?: return null
        val arr = o.optJSONArray("rows")
        val rows = ArrayList<Row>(arr?.length() ?: 0)
        for (i in 0 until (arr?.length() ?: 0)) {
            val r = arr?.optJSONObject(i) ?: continue
            rows.add(
                Row(
                    label = r.optString("label", ""),
                    value = r.optString("value", ""),
                    ref = text(r, "ref"),
                    note = text(r, "note"),
                )
            )
        }
        return Aggregate(
            period = o.optString("period", ""),
            basis = o.optString("basis", ""),
            asOf = o.optString("as_of", ""),
            rows = rows,
            note = text(o, "note"),
        )
    }

    fun quickAdd(context: Context): QuickAdd? {
        val o = document(context, QUICKADD) ?: return null
        val arr = o.optJSONArray("foods")
        val foods = ArrayList<Food>(arr?.length() ?: 0)
        for (i in 0 until (arr?.length() ?: 0)) {
            val f = arr?.optJSONObject(i) ?: continue
            val label = f.optString("label", "")
            val kind = f.optString("kind", "")
            val id = f.optString("id", "")
            // A row nobody can act on is not a row. Dropping it here rather than
            // drawing a name with no destination is what stops a tap opening the
            // app on nothing at all.
            if (label.isEmpty() || !WidgetLanding.pickIsAllowed("$kind:$id")) continue
            foods.add(Food(label, kind, id))
        }
        return QuickAdd(foods = foods, note = text(o, "note"))
    }

    /**
     * Read one file, or nothing.
     *
     * Every failure lands in the same place on purpose. A missing file is the
     * ordinary state of a fresh install; a half-written one cannot happen,
     * because Rust renames its temporary file over the old one; and a corrupt one
     * is a bug somewhere else. All three are "nothing to show", because the
     * alternative is an uncaught exception inside a broadcast receiver, which
     * Android reports to the user as the app having stopped.
     */
    private fun document(context: Context, name: String): JSONObject? {
        val f = File(dir(context), name)
        if (!f.isFile) return null
        return try {
            val o = JSONObject(f.readText(Charsets.UTF_8))
            if (o.optInt("v", 0) != VERSION) null else o
        } catch (_: Exception) {
            null
        }
    }

    /**
     * A field that is allowed to be absent.
     *
     * `optString` returns the four characters `null` for a JSON null, which would
     * then be drawn on somebody's home screen. Asking `isNull` first is the only
     * way to tell "no reference figure is published" from a reference figure
     * whose text happens to read like one.
     */
    private fun text(o: JSONObject, key: String): String? =
        if (!o.has(key) || o.isNull(key)) null else o.optString(key).ifEmpty { null }
}
