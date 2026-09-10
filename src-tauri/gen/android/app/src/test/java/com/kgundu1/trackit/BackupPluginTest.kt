package com.kgundu1.trackit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What can honestly be tested off a device.
 *
 * Robolectric is not in this project's dependencies, so `AndroidKeyStore`
 * itself is not exercised here — a wrap-and-unwrap round trip has to be an
 * on-device check and is listed as one rather than faked with a stub that would
 * prove nothing about the framework. What IS here is every decision the plugin
 * makes that is not the framework's: how a security level is named, and how a
 * stored blob is split back apart.
 */
class BackupPluginTest {
    /** The screen prints this word, so it must be what the key actually is. */
    @Test
    fun securityLevelIsReportedRatherThanAssumed() {
        assertEquals("strongbox", securityLevelName(2, false))
        assertEquals("tee", securityLevelName(1, false))
        assertEquals("software", securityLevelName(0, false))
    }

    /** Below API 31 there is no level, only a boolean, and a device that says
     * neither must not be described as secure hardware. */
    @Test
    fun anOlderDeviceIsDescribedFromWhatItActuallyReports() {
        assertEquals("tee", securityLevelName(-1, true))
        assertEquals("software", securityLevelName(-1, false))
    }

    @Test
    fun aStoredBlobSplitsIntoTheNonceAndTheSealedRemainder() {
        val bytes = ByteArray(IV_BYTES + TAG_BITS / 8 + 32) { it.toByte() }
        val split = splitWrapped(bytes)!!
        assertEquals(IV_BYTES, split.first.size)
        assertEquals(bytes.size - IV_BYTES, split.second.size)
        assertEquals(0.toByte(), split.first[0])
        assertEquals(IV_BYTES.toByte(), split.second[0])
    }

    /** A truncated write, or a file from a build that stored something else.
     * Refused rather than split into two arrays the Cipher would reject with a
     * less useful message. */
    @Test
    fun somethingTooShortToBeAKeyIsRefusedRatherThanSplit() {
        assertNull(splitWrapped(ByteArray(0)))
        assertNull(splitWrapped(ByteArray(IV_BYTES)))
        assertNull(splitWrapped(ByteArray(IV_BYTES + TAG_BITS / 8)))
        assertTrue(splitWrapped(ByteArray(IV_BYTES + TAG_BITS / 8 + 1)) != null)
    }
}
