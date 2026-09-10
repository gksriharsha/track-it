package com.kgundu1.trackit.widget

import android.content.Context
import android.os.FileObserver

/**
 * How a snapshot Rust has just written reaches the home screen.
 *
 * Rust writes the two files with plain `std::fs` and calls into no Kotlin at all,
 * which is the single most important thing about this feature's shape. Release
 * builds set `panic = "abort"`, and the mobile-plugin bridge ends in wry's
 * `MainPipe::send`, which panics when the last Activity has gone — so a JNI call
 * made from the thread that a logged helping scheduled would take the whole
 * process down in the one situation it is most likely to happen: log a dish, then
 * swipe the app out of recents. A failure to REDRAW A HOME SCREEN must never be
 * able to do that to somebody's log.
 *
 * So the file is the message, and this is the doorbell. The Activity owns the
 * observer, which means it is running only while there is an Activity to own it —
 * and an Activity, by definition, knows it is alive. When the app is closed
 * nothing needs to be told anything: the system re-sends its own update after a
 * reboot, on placement and on resize, and the providers re-read whatever is on
 * disk then.
 *
 * A word on why `startWatching` needs the directory to exist first. `FileObserver`
 * silently never fires on a path that is not there, and on a fresh install
 * nothing has written the snapshot directory when the Activity is created. So the
 * directory is made here, before watching begins, rather than being waited for.
 */
internal object WidgetWatch {
    /**
     * Both events, and both are needed. Rust replaces each snapshot by renaming a
     * temporary file over the old one, which arrives as `MOVED_TO` on the
     * directory; `CLOSE_WRITE` covers the landing file and anything a future
     * writer does in place. Watching `MODIFY` as well would fire once per write
     * call rather than once per finished file.
     */
    private const val EVENTS = FileObserver.MOVED_TO or FileObserver.CLOSE_WRITE

    private var observer: FileObserver? = null

    fun start(context: Context) {
        if (observer != null) return
        val dir = WidgetSnapshot.dir(context)
        // The application context, not the Activity: this outlives no Activity,
        // but holding one in an object that survives configuration changes is how
        // a leak of an entire view tree starts.
        val app = context.applicationContext
        try {
            if (!dir.isDirectory && !dir.mkdirs()) return
            // The `String` constructor rather than the `File` one, which is API
            // 29 and this project is minSdk 24. Deprecated, and the deprecation
            // is the only thing wrong with it.
            @Suppress("DEPRECATION")
            val watcher = object : FileObserver(dir.absolutePath, EVENTS) {
                override fun onEvent(event: Int, path: String?) {
                    // Only the two snapshots. The landing file is written by this
                    // process on its way INTO the app and has nothing to do with
                    // what a tile draws, and repainting for it would send a
                    // broadcast for every widget tap.
                    if (path == null || !path.endsWith(".json")) return
                    if (path == "landing.json") return
                    WidgetRefresh.all(app)
                }
            }
            watcher.startWatching()
            observer = watcher
        } catch (_: Exception) {
            // No doorbell. The tiles still repaint whenever the system updates
            // them, so the cost is a stale figure rather than a broken widget —
            // and the snapshot prints the moment it describes, so a stale figure
            // says so.
            observer = null
        }
    }

    fun stop() {
        observer?.stopWatching()
        observer = null
    }
}
