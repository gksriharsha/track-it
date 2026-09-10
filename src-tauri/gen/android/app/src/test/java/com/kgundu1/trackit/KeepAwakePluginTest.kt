package com.kgundu1.trackit

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeepAwakePluginTest {
    @Test
    fun onlyTheJsonBooleanTrueHoldsTheScreen() {
        assertTrue(wantsScreenHeld("true"))
    }

    @Test
    fun anythingElseLetsTheScreenSleep() {
        // Every one of these is reachable. `null` is a WebView that has not
        // booted or has been destroyed; "false" is a page with nothing on
        // screen asking; "null" and "undefined" are a fresh document that has
        // never set the property; and the quoted form is what a JavaScript
        // STRING reading "true" comes back as — a bug on the page's side that
        // must not read as consent to burn the screen.
        assertFalse(wantsScreenHeld(null))
        assertFalse(wantsScreenHeld("false"))
        assertFalse(wantsScreenHeld("null"))
        assertFalse(wantsScreenHeld("undefined"))
        assertFalse(wantsScreenHeld("\"true\""))
        assertFalse(wantsScreenHeld(""))
        assertFalse(wantsScreenHeld("TRUE"))
    }
}
