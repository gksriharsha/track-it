package com.kgundu1.trackit

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.os.Process
import android.util.Base64
import androidx.appcompat.app.AppCompatActivity
import androidx.exifinterface.media.ExifInterface
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.ByteArrayInputStream
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** The payload sent by the Rust Android backend. Image data is bare RFC 4648
 * base64, with no data-URL prefix, just like the app's public scan commands. */
@InvokeArg
class VisionImageArgs {
    var dataBase64: String = ""

    /** Apple Vision has explicit fast and accurate modes. ML Kit does not; the
     * caller already makes its live probe cheaper by sending a 900 px frame and
     * its final reading more accurate by sending the retained 1600 px image. */
    var fast: Boolean = false
}

/** One OCR line in the platform-neutral coordinate convention consumed by
 * Rust: fractions of the oriented image, origin at top-left, y increasing down. */
internal data class VisionLineResult(
    val text: String,
    val x: Double,
    val y: Double,
    val w: Double,
    val h: Double,
    val confidence: Float,
)

/** One barcode exactly as ML Kit decoded it. The Rust core decides whether the
 * payload can be trusted by recomputing GS1 check digits. */
internal data class VisionBarcodeResult(
    val payload: String,
    val symbology: String,
    val confidence: Float,
)

internal data class NormalizedBox(
    val x: Double,
    val y: Double,
    val w: Double,
    val h: Double,
)

/** Normalize an axis-aligned Android/ML Kit rectangle into the same top-left
 * unit square Apple Vision is converted to on macOS. ML Kit can report a box a
 * few pixels outside the image after perspective correction, so both endpoints
 * are clamped before width and height are derived. */
internal fun normalizeBox(
    left: Int,
    top: Int,
    right: Int,
    bottom: Int,
    imageWidth: Int,
    imageHeight: Int,
): NormalizedBox? {
    if (imageWidth <= 0 || imageHeight <= 0) return null

    val x0 = minOf(left, right).coerceIn(0, imageWidth).toDouble() / imageWidth
    val x1 = maxOf(left, right).coerceIn(0, imageWidth).toDouble() / imageWidth
    val y0 = minOf(top, bottom).coerceIn(0, imageHeight).toDouble() / imageHeight
    val y1 = maxOf(top, bottom).coerceIn(0, imageHeight).toDouble() / imageHeight

    if (x1 <= x0 || y1 <= y0) return null
    return NormalizedBox(x = x0, y = y0, w = x1 - x0, h = y1 - y0)
}

/** ML Kit exposes integer format constants. Return engine-independent names
 * understood by the shared Rust barcode checker; especially, EAN/UPC must not
 * be returned as `FORMAT_EAN_13`, which would bypass GS1 check-digit handling. */
internal fun canonicalBarcodeFormat(format: Int): String = when (format) {
    Barcode.FORMAT_EAN_13 -> "EAN-13"
    Barcode.FORMAT_EAN_8 -> "EAN-8"
    Barcode.FORMAT_UPC_A -> "UPC-A"
    Barcode.FORMAT_UPC_E -> "UPC-E"
    Barcode.FORMAT_CODE_128 -> "Code 128"
    Barcode.FORMAT_CODE_39 -> "Code 39"
    Barcode.FORMAT_CODE_93 -> "Code 93"
    Barcode.FORMAT_CODABAR -> "Codabar"
    Barcode.FORMAT_DATA_MATRIX -> "Data Matrix"
    Barcode.FORMAT_ITF -> "Interleaved 2 of 5"
    Barcode.FORMAT_QR_CODE -> "QR"
    Barcode.FORMAT_PDF417 -> "PDF417"
    Barcode.FORMAT_AZTEC -> "Aztec"
    else -> "Unknown"
}

internal fun normalizedConfidence(confidence: Float): Float =
    if (confidence.isFinite()) confidence.coerceIn(0f, 1f) else 0f

/** Pick a power-of-two BitmapFactory sample that keeps the decoded allocation
 * under [maxPixels]. Returning null distinguishes corrupt bounds from a valid
 * image that merely needs downsampling. */
internal fun sampleSizeForPixelCeiling(
    width: Int,
    height: Int,
    maxPixels: Long,
): Int? {
    if (width <= 0 || height <= 0 || maxPixels <= 0) return null

    var sample = 1
    while (true) {
        val divisor = sample.toLong()
        val sampledWidth = (width.toLong() + divisor - 1) / divisor
        val sampledHeight = (height.toLong() + divisor - 1) / divisor
        if (sampledWidth * sampledHeight <= maxPixels) return sample
        if (sample > Int.MAX_VALUE / 2) return null
        sample *= 2
    }
}

private data class DecodedImage(val bitmap: Bitmap)

private const val MAX_DECODED_PIXELS = 4L * 1024L * 1024L
private const val IMAGE_PREPARATION_QUEUE_CAPACITY = 2
private const val STOPPED_DETAIL = "scanner is shutting down"
private const val BUSY_DETAIL = "image preparation queue is busy"

/** An Invoke itself permits repeated replies. Every asynchronous path for one
 * request therefore converges here, including teardown and ML Kit callbacks. */
private class InvocationCompletion(
    private val invoke: Invoke,
    private val onFinished: (InvocationCompletion) -> Unit,
) {
    private val finished = AtomicBoolean(false)

    fun resolve(value: Any) {
        finish { invoke.resolveObject(value) }
    }

    fun reject(detail: String, error: Exception? = null) {
        finish {
            if (error == null) invoke.reject(detail) else invoke.reject(detail, error)
        }
    }

    private inline fun finish(send: () -> Unit) {
        if (!finished.compareAndSet(false, true)) return
        try {
            send()
        } finally {
            onFinished(this)
        }
    }
}

/** Android's on-device equivalent of the macOS Vision binding.
 *
 * This class deliberately stops at text lines and raw barcode payloads. Panel,
 * ingredient, supplement and checksum interpretation remains in the shared Rust
 * core, so both platforms make the same decisions after recognition.
 */
@TauriPlugin
class VisionPlugin(activity: Activity) : Plugin(activity) {
    private val lifecycleLock = Any()
    private val destroyed = AtomicBoolean(false)
    private val activeCalls = ConcurrentHashMap.newKeySet<InvocationCompletion>()

    // BitmapFactory and EXIF parsing can take long enough to visibly stall a
    // camera preview. One background worker keeps those allocations serialized;
    // the small bounded queue refuses stale probe work instead of building an
    // unbounded backlog while ML Kit is under load.
    private val imageExecutor = ThreadPoolExecutor(
        1,
        1,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(IMAGE_PREPARATION_QUEUE_CAPACITY),
        ThreadFactory { runnable ->
            Thread(
                {
                    try {
                        Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND)
                    } catch (_: SecurityException) {
                        // The dedicated thread is still preferable to doing this
                        // work on the command/UI thread if a vendor blocks niceness.
                    }
                    runnable.run()
                },
                "TrackIt-VisionImage",
            )
        },
        ThreadPoolExecutor.AbortPolicy(),
    )

    // One client of each kind for the plugin lifetime. Construct lazily so an
    // app session that never scans pays no model setup time; reuse is important
    // for the OCR probe that runs every 1.2 seconds while framing a panel.
    private val textRecognizer = lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    }
    private val barcodeScanner = lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        BarcodeScanning.getClient()
    }

    @Command
    fun recognize(invoke: Invoke) {
        submitImage(invoke, ::startTextRecognition)
    }

    @Command
    fun detectBarcodes(invoke: Invoke) {
        submitImage(invoke, ::startBarcodeDetection)
    }

    override fun onDestroy(activity: AppCompatActivity) {
        val cleanup = synchronized(lifecycleLock) {
            if (!destroyed.compareAndSet(false, true)) return

            // Interrupt a decode when the codec honors interruption and discard
            // anything still queued. A decode already inside native code checks
            // `destroyed` when it returns and recycles instead of starting ML Kit.
            imageExecutor.shutdownNow()
            Triple(
                activeCalls.toList(),
                if (textRecognizer.isInitialized()) textRecognizer.value else null,
                if (barcodeScanner.isInitialized()) barcodeScanner.value else null,
            )
        }

        // Resolve every outstanding native promise exactly once. Task listeners
        // may race this loop, but InvocationCompletion arbitrates the winner.
        cleanup.first.forEach { it.reject(STOPPED_DETAIL) }
        runCatching { cleanup.second?.close() }
        runCatching { cleanup.third?.close() }
    }

    /** Parse and decode on the owned worker. The only work left on the command
     * thread is allocating this tiny closure and offering it to a bounded queue. */
    private fun submitImage(
        invoke: Invoke,
        startDetector: (DecodedImage, InvocationCompletion) -> Unit,
    ) {
        val completion = InvocationCompletion(invoke) { activeCalls.remove(it) }
        val work = Runnable {
            if (destroyed.get()) {
                finishFailure(completion, STOPPED_DETAIL)
                return@Runnable
            }

            val args = try {
                invoke.parseArgs(VisionImageArgs::class.java)
            } catch (error: Exception) {
                finishFailure(completion, "invalid scanner request", error)
                return@Runnable
            }

            val image = try {
                decodeImage(args.dataBase64)
            } catch (error: Exception) {
                finishFailure(completion, error.message ?: "image preparation failed", error)
                return@Runnable
            }

            if (destroyed.get()) {
                image.bitmap.recycle()
                finishFailure(completion, STOPPED_DETAIL)
                return@Runnable
            }

            // Each detector owns the bitmap from this point and either recycles
            // it after a synchronous setup failure or from Task completion.
            startDetector(image, completion)
        }

        var immediateDetail: String? = null
        var immediateError: Exception? = null
        synchronized(lifecycleLock) {
            if (destroyed.get()) {
                immediateDetail = STOPPED_DETAIL
            } else {
                activeCalls.add(completion)
                try {
                    imageExecutor.execute(work)
                } catch (error: RejectedExecutionException) {
                    immediateDetail = if (destroyed.get()) STOPPED_DETAIL else BUSY_DETAIL
                    immediateError = error
                }
            }
        }
        immediateDetail?.let { finishFailure(completion, it, immediateError) }
    }

    private fun startTextRecognition(image: DecodedImage, completion: InvocationCompletion) {
        val width = image.bitmap.width
        val height = image.bitmap.height
        val task = try {
            val input = InputImage.fromBitmap(image.bitmap, 0)
            synchronized(lifecycleLock) {
                if (destroyed.get()) null else textRecognizer.value.process(input)
            }
        } catch (error: Exception) {
            image.bitmap.recycle()
            finishFailure(completion, errorText(error), error)
            return
        }

        if (task == null) {
            image.bitmap.recycle()
            finishFailure(completion, STOPPED_DETAIL)
            return
        }

        // Register cleanup first. It is safe for this to run before the success
        // listener because dimensions were copied above and results own their text.
        task.addOnCompleteListener { image.bitmap.recycle() }
        task.addOnSuccessListener { recognized ->
            try {
                // Serialize maps with literal keys. R8 may rename getters on
                // these internal result classes in a release build; map keys
                // keep the Rust wire contract stable without broad keep rules.
                val results = linesFrom(recognized, width, height).map { line ->
                    mapOf(
                        "text" to line.text,
                        "x" to line.x,
                        "y" to line.y,
                        "w" to line.w,
                        "h" to line.h,
                        "confidence" to line.confidence,
                    )
                }
                finishSuccess(completion, results)
            } catch (error: Exception) {
                finishFailure(completion, "could not return the recognition result", error)
            }
        }
        task.addOnFailureListener { error ->
            finishFailure(completion, errorText(error), error)
        }
    }

    private fun startBarcodeDetection(image: DecodedImage, completion: InvocationCompletion) {
        val task = try {
            val input = InputImage.fromBitmap(image.bitmap, 0)
            synchronized(lifecycleLock) {
                if (destroyed.get()) null else barcodeScanner.value.process(input)
            }
        } catch (error: Exception) {
            image.bitmap.recycle()
            finishFailure(completion, errorText(error), error)
            return
        }

        if (task == null) {
            image.bitmap.recycle()
            finishFailure(completion, STOPPED_DETAIL)
            return
        }

        task.addOnCompleteListener { image.bitmap.recycle() }
        task.addOnSuccessListener { found ->
            try {
                val results = found.mapNotNull { barcode ->
                    val payload = barcode.rawValue ?: return@mapNotNull null
                    if (payload.isBlank()) return@mapNotNull null
                    VisionBarcodeResult(
                        payload = payload,
                        symbology = canonicalBarcodeFormat(barcode.format),
                        // ML Kit does not expose a barcode confidence. The Rust
                        // rank first uses checksum trust and numeric payload.
                        confidence = 1f,
                    )
                }.map { barcode ->
                    mapOf(
                        "payload" to barcode.payload,
                        "symbology" to barcode.symbology,
                        "confidence" to barcode.confidence,
                    )
                }
                finishSuccess(completion, results)
            } catch (error: Exception) {
                finishFailure(completion, "could not return the barcode result", error)
            }
        }
        task.addOnFailureListener { error ->
            finishFailure(completion, errorText(error), error)
        }
    }

    /** Linearize response delivery with destruction. A callback that gets the
     * lock first completes normally; once teardown gets it, every path rejects
     * with the lifecycle detail and no success can leak out afterwards. */
    private fun finishSuccess(completion: InvocationCompletion, value: Any) {
        synchronized(lifecycleLock) {
            if (destroyed.get()) completion.reject(STOPPED_DETAIL) else completion.resolve(value)
        }
    }

    private fun finishFailure(
        completion: InvocationCompletion,
        detail: String,
        error: Exception? = null,
    ) {
        synchronized(lifecycleLock) {
            if (destroyed.get()) completion.reject(STOPPED_DETAIL) else completion.reject(detail, error)
        }
    }

    private fun linesFrom(text: Text, imageWidth: Int, imageHeight: Int): List<VisionLineResult> =
        text.textBlocks.flatMap { block ->
            block.lines.mapNotNull { line -> lineResult(line, imageWidth, imageHeight) }
        }

    private fun lineResult(
        line: Text.Line,
        imageWidth: Int,
        imageHeight: Int,
    ): VisionLineResult? {
        val value = line.text
        if (value.isBlank()) return null
        val bounds = line.boundingBox ?: return null
        val box = normalizeBox(
            bounds.left,
            bounds.top,
            bounds.right,
            bounds.bottom,
            imageWidth,
            imageHeight,
        ) ?: return null
        return VisionLineResult(
            text = value,
            x = box.x,
            y = box.y,
            w = box.w,
            h = box.h,
            confidence = normalizedConfidence(line.confidence),
        )
    }
}

/** Decode once for either detector and orient before creating InputImage. The
 * frontend normally re-encodes an upright JPEG, but picked images and future
 * native callers can still carry EXIF orientation; normalizing boxes before
 * applying it would put rows on the wrong axis. */
private fun decodeImage(dataBase64: String): DecodedImage {
    if (dataBase64.isBlank()) {
        throw ImagePreparationException("no image bytes")
    }

    val bytes = try {
        Base64.decode(dataBase64, Base64.DEFAULT)
    } catch (error: IllegalArgumentException) {
        throw ImagePreparationException("invalid base64 image data", error)
    }
    if (bytes.isEmpty()) {
        throw ImagePreparationException("no image bytes")
    }

    // Read dimensions without allocating pixels, then ask the decoder for a
    // power-of-two downsample. Even a highly compressed image cannot turn into
    // an unbounded bitmap allocation on a low-memory phone.
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    try {
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    } catch (error: Exception) {
        throw ImagePreparationException("image bounds could not be read", error)
    }
    val sample = sampleSizeForPixelCeiling(
        bounds.outWidth,
        bounds.outHeight,
        MAX_DECODED_PIXELS,
    ) ?: throw ImagePreparationException("image dimensions are not readable")

    val decoded = try {
        BitmapFactory.decodeByteArray(
            bytes,
            0,
            bytes.size,
            BitmapFactory.Options().apply { inSampleSize = sample },
        )
    } catch (error: Exception) {
        throw ImagePreparationException("image pixels could not be decoded", error)
    } ?: throw ImagePreparationException("unsupported or corrupt image data")

    return try {
        DecodedImage(orient(decoded, exifOrientation(bytes)))
    } catch (error: Exception) {
        if (!decoded.isRecycled) decoded.recycle()
        throw ImagePreparationException("image orientation could not be applied", error)
    }
}

private class ImagePreparationException(message: String, cause: Exception? = null) :
    Exception(message, cause)

private fun exifOrientation(bytes: ByteArray): Int = try {
    ByteArrayInputStream(bytes).use { stream ->
        ExifInterface(stream).getAttributeInt(
            ExifInterface.TAG_ORIENTATION,
            ExifInterface.ORIENTATION_NORMAL,
        )
    }
} catch (_: Exception) {
    // Missing or unreadable EXIF is an untagged upright image, not a corrupt one.
    ExifInterface.ORIENTATION_NORMAL
}

/** Return `source` unchanged when no transform is required. Otherwise the new
 * bitmap owns its pixels and the source can be released immediately. */
private fun orient(source: Bitmap, orientation: Int): Bitmap {
    val matrix = Matrix()
    when (orientation) {
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
        ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL -> {
            matrix.setRotate(180f)
            matrix.postScale(-1f, 1f)
        }
        ExifInterface.ORIENTATION_TRANSPOSE -> {
            matrix.setRotate(90f)
            matrix.postScale(-1f, 1f)
        }
        ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
        ExifInterface.ORIENTATION_TRANSVERSE -> {
            matrix.setRotate(-90f)
            matrix.postScale(-1f, 1f)
        }
        ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
        else -> return source
    }

    val oriented = Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
    if (oriented !== source) source.recycle()
    return oriented
}

private fun errorText(error: Exception): String =
    error.localizedMessage?.trim()?.takeIf { it.isNotEmpty() }
        ?: error.javaClass.simpleName
