package com.kgundu1.trackit.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import com.kgundu1.trackit.MainActivity
import com.kgundu1.trackit.R

/**
 * A widget tap opens the app on a screen, and never logs anything.
 *
 * `FLAG_IMMUTABLE` — API 23, below this project's minSdk 24, so it needs no
 * version gate — stops another app filling in the blanks of an Intent we handed
 * out. `FLAG_UPDATE_CURRENT` with a request code that differs per destination is
 * the other half of the same care: without a distinct code the second
 * PendingIntent would be judged equal to the first, which compares everything
 * about an Intent EXCEPT its extras, and every row on the quick-add tile would
 * open the food from the first one.
 */
private fun openAt(context: Context, route: String, pick: String?): PendingIntent {
    val intent = Intent(context, MainActivity::class.java).apply {
        action = Intent.ACTION_MAIN
        addCategory(Intent.CATEGORY_LAUNCHER)
        // `launchMode` is `singleTask`, so these two bring the existing task
        // forward and deliver through `onNewIntent` rather than stacking a
        // second copy of the app on top of the one already running.
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        putExtra(WidgetLanding.EXTRA_ROUTE, route)
        if (pick != null) putExtra(WidgetLanding.EXTRA_PICK, pick)
    }
    return PendingIntent.getActivity(
        context,
        // The pair, not a concatenation: `route` is one of two whitelisted words
        // and never holds a separator, so hashing them together cannot collide the
        // way "foods" plus "water" and "foods water" plus nothing would.
        (route to pick).hashCode(),
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

/**
 * The aggregate tile: how the last thirty days went, in the idiom of the
 * Statistics screen.
 *
 * Every string on it was written in Rust. This class chooses which TextView each
 * one lands in and nothing else — no median, no rounding, no unit, and above all
 * no default for a figure that is missing. `updatePeriodMillis` is zero, so
 * nothing here runs on a timer: an `AppWidgetProvider` could not recompute an
 * aggregate anyway, because the aggregation lives behind a database it must not
 * open. What makes that honest rather than merely stale is the pair of strings at
 * the top and bottom — the moment the figures were written, with its year, and
 * the coverage sentence anchored to the date the period starts from. A snapshot
 * that has sat here for a fortnight says so.
 *
 * Absent from this file, and from the layout it inflates, on purpose: any
 * ProgressBar, ring or arc; any percentage; any run of days; and any word that
 * appraises what it found.
 */
class AggregateWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        val views = build(context)
        for (id in appWidgetIds) manager.updateAppWidget(id, views)
    }

    /**
     * A resize is a repaint. There is no size-dependent content — the tile is
     * one layout that ellipsises rather than two that swap — so this exists only
     * so a launcher that drops its cached RemoteViews on resize gets them back.
     */
    override fun onAppWidgetOptionsChanged(
        context: Context,
        manager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle,
    ) {
        manager.updateAppWidget(appWidgetId, build(context))
    }

    private fun build(context: Context): RemoteViews {
        val v = RemoteViews(context.packageName, R.layout.widget_aggregate)
        v.setOnClickPendingIntent(R.id.widget_agg_root, openAt(context, "statistics", null))

        val snapshot = WidgetSnapshot.aggregate(context)
        val rows = snapshot?.rows ?: emptyList()
        if (snapshot == null || rows.isEmpty()) {
            // Nothing published yet, or a period with nothing in it. Zeroes here
            // would be the same lie as a nutrient stored as 0 when it was merely
            // never measured, so the tile says what it has instead.
            v.setViewVisibility(R.id.widget_agg_figures, View.GONE)
            v.setViewVisibility(R.id.widget_agg_basis, View.GONE)
            v.setViewVisibility(R.id.widget_agg_empty, View.VISIBLE)
            v.setTextViewText(
                R.id.widget_agg_empty,
                snapshot?.note ?: context.getString(R.string.widget_unwritten),
            )
            v.setTextViewText(R.id.widget_agg_period, snapshot?.period ?: "")
            v.setTextViewText(R.id.widget_agg_asof, snapshot?.asOf ?: "")
            return v
        }

        v.setViewVisibility(R.id.widget_agg_empty, View.GONE)
        v.setViewVisibility(R.id.widget_agg_figures, View.VISIBLE)
        v.setTextViewText(R.id.widget_agg_period, snapshot.period)
        v.setTextViewText(R.id.widget_agg_asof, snapshot.asOf)
        v.setViewVisibility(R.id.widget_agg_basis, View.VISIBLE)
        v.setTextViewText(R.id.widget_agg_basis, snapshot.basis)

        val slots = listOf(
            Slot(R.id.widget_agg_col0, R.id.widget_agg_label0, R.id.widget_agg_value0, R.id.widget_agg_ref0, R.id.widget_agg_note0),
            Slot(R.id.widget_agg_col1, R.id.widget_agg_label1, R.id.widget_agg_value1, R.id.widget_agg_ref1, R.id.widget_agg_note1),
        )
        for ((i, slot) in slots.withIndex()) {
            val row = rows.getOrNull(i)
            if (row == null) {
                v.setViewVisibility(slot.column, View.GONE)
                continue
            }
            v.setViewVisibility(slot.column, View.VISIBLE)
            v.setTextViewText(slot.label, row.label)
            v.setTextViewText(slot.value, row.value)
            // A reference figure nothing publishes has no line at all, rather
            // than a blank one holding its place: an empty gap under an amount
            // reads as a figure that failed to load.
            text(v, slot.ref, row.ref)
            text(v, slot.note, row.note)
        }
        return v
    }

    private class Slot(val column: Int, val label: Int, val value: Int, val ref: Int, val note: Int)

    private fun text(v: RemoteViews, id: Int, s: String?) {
        if (s == null) {
            v.setViewVisibility(id, View.GONE)
        } else {
            v.setViewVisibility(id, View.VISIBLE)
            v.setTextViewText(id, s)
        }
    }
}

/**
 * The quick-add tile: a few names and a tap each.
 *
 * A tap opens Add food with that food chosen and its last portion in the weight
 * field, and stops there. Nothing is logged without a second, deliberate tap
 * inside the app, and the tile carries no weight, no dose and no way to send
 * one — the widget knows WHICH food and nothing more.
 *
 * What it also does not carry is any figure: not how often the food was logged,
 * not where it ranks, not how many days in a row. Those are figures about the
 * person, and this is a shortcut rather than a report on them. The frequency that
 * ordered the rows stays in the database that computed it.
 */
class QuickAddWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        val views = build(context)
        for (id in appWidgetIds) manager.updateAppWidget(id, views)
    }

    override fun onAppWidgetOptionsChanged(
        context: Context,
        manager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle,
    ) {
        manager.updateAppWidget(appWidgetId, build(context))
    }

    private fun build(context: Context): RemoteViews {
        val v = RemoteViews(context.packageName, R.layout.widget_quickadd)

        // The action bar is drawn before the snapshot is even opened, and it is
        // what makes the tile useful on the day it is installed and after a data
        // wipe. Water goes to the Foods screen's own water tab, not to the bottle
        // library — that screen records what a jug weighs full, which is not the
        // same act as drinking from one.
        v.setTextViewText(R.id.widget_quick_add, context.getString(R.string.widget_add_food))
        v.setTextViewText(R.id.widget_quick_water, context.getString(R.string.widget_log_water))
        v.setOnClickPendingIntent(R.id.widget_quick_add, openAt(context, "foods", null))
        v.setOnClickPendingIntent(R.id.widget_quick_water, openAt(context, "foods", "water"))

        val snapshot = WidgetSnapshot.quickAdd(context)
        val foods = snapshot?.foods ?: emptyList()
        val ids = intArrayOf(R.id.widget_quick_row0, R.id.widget_quick_row1, R.id.widget_quick_row2)

        if (foods.isEmpty()) {
            // Describes the record, not the person. "Nothing logged yet" over two
            // buttons on a home screen reads as a report card; this says what the
            // file holds, which is nothing yet.
            v.setViewVisibility(R.id.widget_quick_rows, View.GONE)
            v.setViewVisibility(R.id.widget_quick_empty, View.VISIBLE)
            v.setTextViewText(
                R.id.widget_quick_empty,
                snapshot?.note ?: context.getString(R.string.widget_quick_empty),
            )
            return v
        }

        v.setViewVisibility(R.id.widget_quick_empty, View.GONE)
        v.setViewVisibility(R.id.widget_quick_rows, View.VISIBLE)
        for ((i, id) in ids.withIndex()) {
            val food = foods.getOrNull(i)
            if (food == null) {
                v.setViewVisibility(id, View.GONE)
                continue
            }
            v.setViewVisibility(id, View.VISIBLE)
            v.setTextViewText(id, food.label)
            v.setOnClickPendingIntent(id, openAt(context, "foods", "${food.kind}:${food.id}"))
        }
        return v
    }
}

/**
 * One repaint path for both tiles.
 *
 * An EXPLICIT broadcast to our own components, which matters twice: explicit plus
 * same UID means Android 8's restrictions on implicit broadcasts do not apply,
 * and routing through `onUpdate` leaves exactly ONE rendering path — the system's
 * first update after placement, a resize, and a repaint the app asked for all run
 * the same code.
 *
 * Nothing here reads the snapshot. Deciding what to draw belongs to the providers
 * above, which will be re-entered a moment later with a live Context.
 */
internal object WidgetRefresh {
    private val PROVIDERS = listOf(
        AggregateWidgetProvider::class.java,
        QuickAddWidgetProvider::class.java,
    )

    fun all(context: Context) {
        val manager = AppWidgetManager.getInstance(context) ?: return
        for (cls in PROVIDERS) {
            // Named `target` rather than `component`: inside the `apply` below,
            // `component` is `Intent`'s own property, so a local of that name
            // would silently assign the receiver's null to itself.
            val target = ComponentName(context, cls)
            val ids = try {
                manager.getAppWidgetIds(target)
            } catch (_: Exception) {
                // A launcher that has not registered our providers yet, or a
                // profile where widgets are unavailable. Nothing to repaint is
                // not a failure worth propagating into a log write.
                continue
            }
            if (ids.isEmpty()) continue
            context.sendBroadcast(
                Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE).apply {
                    setComponent(target)
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
                }
            )
        }
    }
}
