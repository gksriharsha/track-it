package com.kgundu1.trackit

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.kgundu1.trackit.widget.WidgetLanding
import java.util.Calendar

/**
 * The times of day the user asked to be nudged to log, and the alarms behind them.
 *
 * Kept in SharedPreferences rather than the log database: a boot receiver has
 * to re-arm them before anyone has unlocked the app, and a nudge is a setting
 * of this phone, not something a paired device or a backup should carry.
 */
object Nudges {
    private const val PREFS = "nudges"
    private const val KEY = "times"
    private const val CHANNEL = "nudges"
    private const val NOTIFICATION_ID = 7001
    private const val WINDOW = 10 * 60 * 1000L
    const val ACTION = "com.kgundu1.trackit.NUDGE"

    /** "HH:MM" to minutes past midnight, or null for anything else. */
    fun minutes(time: String): Int? {
        val parts = time.split(':')
        if (parts.size != 2 || parts[0].length != 2 || parts[1].length != 2) return null
        val h = parts[0].toIntOrNull() ?: return null
        val m = parts[1].toIntOrNull() ?: return null
        return if (h in 0..23 && m in 0..59) h * 60 + m else null
    }

    fun read(context: Context): List<String> =
        prefs(context).getString(KEY, "")!!.split(',').filter { minutes(it) != null }

    fun write(context: Context, times: List<String>) {
        val kept = times.filter { minutes(it) != null }.distinct().sorted()
        // Alarms for times that were dropped have to be cancelled by name;
        // re-arming only touches the ones still in the list.
        for (gone in read(context) - kept.toSet()) alarms(context).cancel(pending(context, gone))
        prefs(context).edit().putString(KEY, kept.joinToString(",")).apply()
        arm(context)
    }

    /** Set every alarm for its next occurrence. Re-setting the same PendingIntent replaces it. */
    fun arm(context: Context) {
        val now = Calendar.getInstance()
        for (time in read(context)) {
            val at = minutes(time)!!
            val next = (now.clone() as Calendar).apply {
                set(Calendar.HOUR_OF_DAY, at / 60)
                set(Calendar.MINUTE, at % 60)
                set(Calendar.SECOND, 0)
                set(Calendar.MILLISECOND, 0)
                if (!after(now)) add(Calendar.DAY_OF_YEAR, 1)
            }
            // A ten-minute window, the tightest Android allows without the exact-alarm
            // permission the user would have to grant in system settings.
            // `setAndAllowWhileIdle` was tried first and got a one-hour window.
            alarms(context).setWindow(AlarmManager.RTC_WAKEUP, next.timeInMillis, WINDOW, pending(context, time))
        }
    }

    fun enabled(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()

    fun post(context: Context) {
        if (!enabled(context)) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Reminders to log", NotificationManager.IMPORTANCE_DEFAULT)
            )
        }
        // Lands on the log search, the same door the quick-add widget opens.
        val open = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_MAIN
            addCategory(Intent.CATEGORY_LAUNCHER)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(WidgetLanding.EXTRA_ROUTE, "foods")
        }
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher_monochrome)
            .setContentTitle("Anything to log?")
            .setContentText("Tap to add what you ate.")
            .setAutoCancel(true)
            .setContentIntent(
                PendingIntent.getActivity(
                    context, NOTIFICATION_ID, open,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            )
            .build()
        // One id: a missed nudge is replaced by the next, never stacked.
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun alarms(context: Context) = context.getSystemService(AlarmManager::class.java)

    // One PendingIntent per time, told apart by its minute of the day.
    private fun pending(context: Context, time: String): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            minutes(time)!!,
            Intent(context, NudgeReceiver::class.java).setAction(ACTION),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
}

/** Posts a nudge when its alarm fires, and re-arms everything after a reboot or a clock change. */
class NudgeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Nudges.ACTION) Nudges.post(context)
        Nudges.arm(context)
    }
}

/** Public for R8's `-keep @app.tauri.annotation.InvokeArg public class *` rule. */
@InvokeArg
class NudgeArgs {
    var times: List<String> = emptyList()
}

@TauriPlugin(
    permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")]
)
class NudgePlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun getNudges(invoke: Invoke) = invoke.resolve(state())

    @Command
    fun setNudges(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(NudgeArgs::class.java)
        } catch (error: Exception) {
            invoke.reject("could not read the nudge times", error)
            return
        }
        Nudges.write(activity, args.times)
        // Android 13 and later ask once, the first time there is something to send.
        if (args.times.isNotEmpty() && !Nudges.enabled(activity) && Build.VERSION.SDK_INT >= 33) {
            requestPermissionForAlias("notifications", invoke, "asked")
        } else {
            invoke.resolve(state())
        }
    }

    @PermissionCallback
    fun asked(invoke: Invoke) = invoke.resolve(state())

    private fun state() = JSObject().apply {
        put("times", JSArray(Nudges.read(activity)))
        put("enabled", Nudges.enabled(activity))
    }
}
