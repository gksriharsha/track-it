package com.kgundu1.trackit

import com.kgundu1.trackit.widget.WidgetLanding
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two whitelists a forged Intent has to get past.
 *
 * `MainActivity` is `android:exported="true"` because it carries LAUNCHER, so
 * any installed app can start it with extras of its choosing — which is why these
 * are pure functions with no Android in them at all, and why they are checked
 * here rather than only on a device.
 *
 * Nothing in this file may touch `android.*` or `org.json`.
 * `testOptions { unitTests.isReturnDefaultValues }` is NOT set in
 * app/build.gradle.kts, so the stubbed `android.jar` throws on any real call and
 * a test that reached for one would fail for a reason that has nothing to do with
 * what it was checking.
 */
class WidgetLandingTest {
    @Test
    fun onlyTheTwoWidgetDestinationsAreHonoured() {
        assertTrue(WidgetLanding.routeIsAllowed("statistics"))
        assertTrue(WidgetLanding.routeIsAllowed("foods"))
        for (forged in listOf(
            "settings",
            "profile",
            "household",
            "import",
            "",
            "Foods",
            "foods/../settings",
            "statistics?menu=1",
            "javascript:alert(1)",
        )) {
            assertFalse(forged, WidgetLanding.routeIsAllowed(forged))
        }
    }

    @Test
    fun aPickTokenIsOneOfExactlyThreeShapes() {
        assertTrue(WidgetLanding.pickIsAllowed("water"))
        assertTrue(WidgetLanding.pickIsAllowed("food:167763"))
        assertTrue(WidgetLanding.pickIsAllowed("custom:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"))
    }

    @Test
    fun aTokenWithAnythingElseInItIsThrownAwayWhole() {
        for (forged in listOf(
            "food:1; DROP",
            "food:",
            "food:-1",
            "food:1.5",
            "food:9999999999999",
            // The uppercase spelling of a uuid this app cannot have written:
            // every id comes from SQLite's lower(hex(randomblob(…))).
            "custom:AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
            "custom:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeeeZ",
            "custom:../../etc/passwd",
            // Shelves the quick-add list does not admit, so a token naming one
            // could only have come from somewhere else.
            "recipe:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "supplement:1",
            "cook:1",
            "Water",
            ":167763",
            "",
        )) {
            assertFalse(forged, WidgetLanding.pickIsAllowed(forged))
        }
    }
}
