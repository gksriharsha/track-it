package com.kgundu1.trackit

import com.google.mlkit.vision.barcode.common.Barcode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VisionPluginTest {
    @Test
    fun normalizeBoxUsesTopLeftUnitCoordinates() {
        val box = normalizeBox(
            left = 20,
            top = 10,
            right = 120,
            bottom = 70,
            imageWidth = 200,
            imageHeight = 100,
        )!!

        assertEquals(0.10, box.x, 1e-12)
        assertEquals(0.10, box.y, 1e-12)
        assertEquals(0.50, box.w, 1e-12)
        assertEquals(0.60, box.h, 1e-12)
    }

    @Test
    fun normalizeBoxClampsDetectorOvershootBeforeSizing() {
        val box = normalizeBox(
            left = -8,
            top = -4,
            right = 212,
            bottom = 105,
            imageWidth = 200,
            imageHeight = 100,
        )!!

        assertEquals(0.0, box.x, 1e-12)
        assertEquals(0.0, box.y, 1e-12)
        assertEquals(1.0, box.w, 1e-12)
        assertEquals(1.0, box.h, 1e-12)
    }

    @Test
    fun normalizeBoxRejectsDimensionsOrBoxesThatCannotPlaceALine() {
        assertNull(normalizeBox(0, 0, 1, 1, 0, 100))
        assertNull(normalizeBox(10, 10, 10, 20, 100, 100))
        assertNull(normalizeBox(-20, 10, -10, 20, 100, 100))
    }

    @Test
    fun gs1FormatsUseNamesTheSharedChecksumCheckerUnderstands() {
        assertEquals("EAN-13", canonicalBarcodeFormat(Barcode.FORMAT_EAN_13))
        assertEquals("EAN-8", canonicalBarcodeFormat(Barcode.FORMAT_EAN_8))
        assertEquals("UPC-A", canonicalBarcodeFormat(Barcode.FORMAT_UPC_A))
        assertEquals("UPC-E", canonicalBarcodeFormat(Barcode.FORMAT_UPC_E))
    }

    @Test
    fun otherSupportedFormatsHaveStableHumanNames() {
        assertEquals("Code 128", canonicalBarcodeFormat(Barcode.FORMAT_CODE_128))
        assertEquals("Data Matrix", canonicalBarcodeFormat(Barcode.FORMAT_DATA_MATRIX))
        assertEquals("Interleaved 2 of 5", canonicalBarcodeFormat(Barcode.FORMAT_ITF))
        assertEquals("QR", canonicalBarcodeFormat(Barcode.FORMAT_QR_CODE))
        assertEquals("PDF417", canonicalBarcodeFormat(Barcode.FORMAT_PDF417))
        assertEquals("Unknown", canonicalBarcodeFormat(Barcode.FORMAT_UNKNOWN))
    }

    @Test
    fun confidenceIsAlwaysSafeForTheRustRanker() {
        assertEquals(0f, normalizedConfidence(Float.NaN), 0f)
        assertEquals(0f, normalizedConfidence(-0.4f), 0f)
        assertEquals(0.42f, normalizedConfidence(0.42f), 0f)
        assertEquals(1f, normalizedConfidence(4f), 0f)
    }

    @Test
    fun ordinaryCameraFrameNeedsNoPixelDownsampling() {
        assertEquals(1, sampleSizeForPixelCeiling(1600, 1200, 4L * 1024L * 1024L))
    }

    @Test
    fun oversizedImageUsesTheSmallestSafePowerOfTwoSample() {
        assertEquals(8, sampleSizeForPixelCeiling(20_000, 10_000, 4_000_000L))
        assertNull(sampleSizeForPixelCeiling(0, 10_000, 4_000_000L))
        assertNull(sampleSizeForPixelCeiling(100, 100, 0L))
    }
}
