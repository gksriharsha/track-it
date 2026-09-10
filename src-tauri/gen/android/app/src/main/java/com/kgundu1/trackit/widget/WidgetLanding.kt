package com.kgundu1.trackit.widget

import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.io.File

/**
 * Where a widget tap is parked between the Intent arriving and the web app being
 * ready to act on it.
 *
 * A FILE, not a field on an object. That looks like the long way round and it is
 * the only shape that survives the two ways this can go wrong. The Activity's
 * `android:configChanges` lists neither `density` nor `fontScale`, so changing
 * the system font size destroys and rebuilds the Activity; `onCreate` then
 * re-reads `getIntent()`, which is the widget's Intent precisely because
 * `MainActivity.onNewIntent` calls `setIntent` — and an in-memory offer would be
 * handed over a second time, navigating the user away from wherever they had got
 * to. Rust DELETES this file as it reads it, so the tap is honoured exactly once
 * however many times the Activity is rebuilt. The second reason is quieter: a
 * cold start's Intent exists long before React has mounted, and a file waits
 * patiently where a callback into an unloaded page would be dropped.
 *
 * Everything in here treats the Intent as hostile. `MainActivity` is
 * `android:exported="true"` because it carries LAUNCHER, so any installed app can
 * start it with extras of its choosing.
 */
internal object WidgetLanding {
    const val EXTRA_ROUTE = "com.kgundu1.trackit.WIDGET_ROUTE"
    const val EXTRA_PICK = "com.kgundu1.trackit.WIDGET_PICK"

    private const val NAME = "landing.json"

    /**
     * The only screens a widget may ask for.
     *
     * Two, and both are places the widget genuinely goes: the aggregate tile
     * opens the screen it transcribes, and every quick-add tap opens Add food.
     * The list is checked here, again in Rust against `WIDGET_ROUTES`, and a
     * third time in TypeScript against the router's own table — because a
     * whitelist on one side of a bridge is not a whitelist.
     */
    private val ROUTES = setOf("statistics", "foods")

    /**
     * Whether a pick token is one this app could have written.
     *
     * Three shapes and nothing else: the literal `water`, `food:` and decimal
     * digits, `custom:` and the lowercase hex-and-hyphen of a uuid. Lowercase
     * only, because the app's ids come from SQLite's `lower(hex(randomblob(…)))`
     * and nothing else in it ever writes one — accepting the other spelling would
     * widen the list to tokens this app cannot have produced. A token that fails
     * is thrown away WHOLE rather than trimmed into something that looks valid.
     */
    fun pickIsAllowed(pick: String): Boolean {
        if (pick == "water") return true
        val cut = pick.indexOf(':')
        if (cut <= 0) return false
        val kind = pick.substring(0, cut)
        val id = pick.substring(cut + 1)
        return when (kind) {
            "food" -> id.isNotEmpty() && id.length <= 12 && id.all { it in '0'..'9' }
            "custom" ->
                id.length == 36 &&
                    id.all { it in '0'..'9' || it in 'a'..'f' || it == '-' }
            else -> false
        }
    }

    fun routeIsAllowed(route: String): Boolean = route in ROUTES

    /**
     * Park what this Intent asked for, if it asked for anything a widget may ask
     * for. Returns whether anything was written, which is what tells the caller
     * whether it is worth waking the page.
     */
    fun park(context: Context, intent: Intent?): Boolean {
        val route = intent?.getStringExtra(EXTRA_ROUTE) ?: return false
        if (!routeIsAllowed(route)) return false
        val raw = intent.getStringExtra(EXTRA_PICK)
        // The route survives a bad pick and the pick does not. Landing on Add
        // food with nothing chosen is the right answer to a token this app did
        // not write; refusing the whole tap would be a worse one.
        val pick = if (raw != null && pickIsAllowed(raw)) raw else null

        val body = JSONObject()
        body.put("route", route)
        body.put("pick", pick ?: JSONObject.NULL)
        return write(context, body.toString())
    }

    /**
     * Replace the parked landing atomically.
     *
     * Written to a temporary name in the same directory and renamed over the old
     * one, because Rust may be reading it at this moment: the front end pulls on
     * every mount, and a warm relaunch writes this while the page is up. A reader
     * that arrives mid-write must see the old file whole or no file at all, never
     * half of the new one.
     *
     * A failure is swallowed. Everything this can lose is one navigation, and the
     * app opens on its usual front door instead — which is where it opens anyway.
     * Throwing from `onCreate` to report a failed hint would trade a missed
     * shortcut for a crash on launch.
     */
    private fun write(context: Context, json: String): Boolean {
        val dir = WidgetSnapshot.dir(context)
        return try {
            if (!dir.isDirectory && !dir.mkdirs()) return false
            val tmp = File(dir, "$NAME.writing")
            tmp.outputStream().use { out ->
                out.write(json.toByteArray(Charsets.UTF_8))
                out.fd.sync()
            }
            if (tmp.renameTo(File(dir, NAME))) {
                true
            } else {
                // Leaving it behind would have the next tap reuse a name it
                // thinks is free.
                tmp.delete()
                false
            }
        } catch (_: Exception) {
            false
        }
    }
}
