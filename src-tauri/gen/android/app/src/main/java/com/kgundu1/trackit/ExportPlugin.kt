package com.kgundu1.trackit

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.IOException

/** The payload sent by the Rust export module. Bytes are bare RFC 4648 base64
 * with no data-URL prefix, exactly as [VisionPlugin] receives image data. */
@InvokeArg
class SaveDocumentArgs {
    /** What the picker pre-fills the name field with. Already swept of path
     * separators and control characters on the Rust side. */
    var name: String = ""

    /** A MIME type, never an extension. `MimeTypeMap` does not know `xlsx` on
     * most API levels, and a picker given a word it cannot resolve falls back
     * to accepting anything — which still saves the file but suggests nothing
     * about it, and offers no default extension. */
    var mime: String = ""

    var dataBase64: String = ""
}

/**
 * Saving an export where the person asks, through the Storage Access Framework.
 *
 * `ACTION_CREATE_DOCUMENT` rather than `ACTION_SEND`: they asked for a file they
 * keep, and a send hands away a copy while returning a result code that says
 * nothing about whether the receiving app kept it. The trade is that the picker
 * lists Drive, Dropbox and every other document provider installed on the
 * device alongside local storage, so a file can leave the phone in one tap —
 * which is the person's own choice to make and is why the export screen says
 * where the file goes rather than implying it stays here.
 *
 * Nothing about the log is read here. This class receives bytes that are already
 * a finished spreadsheet and puts them behind a URI; every decision about what
 * the file contains was made in Rust and in `src/lib/exportSheet.ts`.
 */
@TauriPlugin
class ExportPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun saveDocument(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(SaveDocumentArgs::class.java)
        } catch (error: Exception) {
            invoke.reject("that export request could not be read", error)
            return
        }
        if (args.dataBase64.isEmpty()) {
            invoke.reject("there were no bytes to write")
            return
        }

        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = args.mime.ifEmpty { "*/*" }
            putExtra(Intent.EXTRA_TITLE, args.name)
        }

        // The command itself arrives on whichever thread called into JNI — for
        // this plugin a Tokio worker, because the Rust command is `async` — and
        // an activity launcher belongs to the Activity. Posting it keeps the
        // launch on the main thread while the caller goes on waiting on its own.
        activity.runOnUiThread {
            try {
                startActivityForResult(invoke, intent, "documentCreated")
            } catch (error: Exception) {
                invoke.reject("no app on this device can save a file", error)
            }
        }
    }

    /**
     * Write the bytes behind the URI the picker minted, then answer with the
     * document's own display name.
     *
     * The name is read back rather than echoed: the framework silently turns a
     * second export of the same period into "… (1).xlsx", and telling the
     * person the name they were offered when the provider chose another one
     * would name a file that is not there.
     *
     * `null` means nothing was written. That covers a cancelled picker and a
     * picker that simply went away, and the two are not distinguished on
     * purpose — the screen says nothing was written rather than claiming the
     * person cancelled, which from here is not a claim that can be made.
     */
    @ActivityCallback
    fun documentCreated(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            invoke.resolveObject(mapOf<String, Any?>("name" to null))
            return
        }

        val args = try {
            // `Invoke` keeps the raw arguments it was built with, so the bytes
            // come back out here rather than living in a field of this class
            // between the two calls — which would hold a whole export in memory
            // for the life of the plugin and outlive the request that made it.
            invoke.parseArgs(SaveDocumentArgs::class.java)
        } catch (error: Exception) {
            invoke.reject("that export request could not be read", error)
            return
        }

        // This callback runs on the main thread and an export can be megabytes,
        // so the decode and the write go to a thread of their own. Doing them
        // here would freeze the app for as long as the file takes, which on a
        // cloud provider is a network round trip.
        Thread(
            {
                try {
                    val bytes = Base64.decode(args.dataBase64, Base64.DEFAULT)
                    // "wt" truncates. The picker will happily return a document
                    // the person chose to replace, and appending to it would
                    // leave a file with one export inside another.
                    val stream = activity.contentResolver.openOutputStream(uri, "wt")
                        ?: throw IOException("the chosen location did not open for writing")
                    stream.use { it.write(bytes) }
                    invoke.resolveObject(mapOf<String, Any?>("name" to displayName(uri, args.name)))
                } catch (error: Exception) {
                    invoke.reject(errorText(error), error)
                }
            },
            "TrackIt-Export",
        ).start()
    }

    /** The name the provider gives the document, or the suggested one when it
     * will not say — a missing display name is not a reason to fail a write
     * that already succeeded. */
    private fun displayName(uri: Uri, fallback: String): String {
        return try {
            activity.contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME),
                null,
                null,
                null,
            )?.use { cursor ->
                if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else fallback
            } ?: fallback
        } catch (_: Exception) {
            fallback
        }
    }
}

private fun errorText(error: Exception): String =
    error.localizedMessage?.trim()?.takeIf { it.isNotEmpty() }
        ?: error.javaClass.simpleName
