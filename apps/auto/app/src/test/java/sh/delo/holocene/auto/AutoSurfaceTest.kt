package sh.delo.holocene.auto

import org.junit.Assert.*
import org.junit.Test

class AutoSurfaceTest {
    private val session = DiagnosticSession()
    private val releases = ArrayList<String>()
    private val surface = AutoSurface(session) { reason, _ -> releases += reason }

    private fun ready() {
        surface.resume()
        surface.updateHost(AutoHostState.UNRESTRICTED)
    }

    @Test fun completedResultSurvivesIdleNavigationPauseAndTeardown() {
        ready()
        surface.recordResult("Actual provider error; no acknowledgement")
        surface.navigate(AutoScreen.DIAGNOSTICS)
        assertEquals("Actual provider error; no acknowledgement", surface.lastResult)
        surface.pause()
        surface.resume()
        surface.back()
        surface.destroy()
        assertEquals("Actual provider error; no acknowledgement", surface.lastResult)
        assertEquals(4, releases.size) // Resources still release at every boundary.
    }

    @Test fun activeNavigationRecordsCancellationRatherThanAnOldResult() {
        ready()
        surface.recordResult("Previous run finished")
        session.begin(true)
        surface.navigate(AutoScreen.DIAGNOSTICS)
        assertEquals("Screen changed; diagnostic cancelled", surface.lastResult)
    }

    @Test fun homeIsDefaultAndUnknownHostFailsClosedEvenWithProviderAndPermission() {
        surface.resume()
        assertEquals(AutoScreen.HOME, surface.screen)
        assertFalse(surface.voiceAvailability(true, true).enabled)
        assertFalse(surface.canCapture(true))
        assertFalse(surface.canOpenPrivacy(true))
        assertTrue(surface.voiceAvailability(true, true).explanation.contains("safety status"))
    }

    @Test fun everyHostProviderPermissionCombinationHasExactlyOneTruthfulGate() {
        surface.resume()
        for (host in AutoHostState.entries) for (provider in listOf(false, true)) for (permission in listOf(false, true)) {
            surface.updateHost(host)
            val availability = surface.voiceAvailability(provider, permission)
            assertEquals("$host/$provider/$permission", host == AutoHostState.UNRESTRICTED && provider && permission, availability.enabled)
            assertTrue(availability.explanation.isNotBlank())
        }
    }

    @Test fun missingProviderExplainsDiagnosticAlternative() {
        ready()
        assertTrue(surface.voiceAvailability(false, true).explanation.contains("No Android speech service"))
        assertTrue(surface.canCapture(true)) // The separate PCM probe needs no ASR provider.
    }

    @Test fun missingPermissionExplainsExplicitOptInWithoutStartingCapture() {
        ready()
        assertFalse(surface.voiceAvailability(true, false).enabled)
        assertFalse(surface.canCapture(false))
        assertTrue(surface.voiceAvailability(true, false).explanation.contains("permission"))
        assertEquals(DiagnosticPhase.IDLE, session.phase)
    }

    @Test fun navigationDuringCaptureReleasesResourcesAndMakesResultsStale() {
        ready()
        val old = session.begin(surface.canCapture(true))!!
        assertTrue(surface.navigate(AutoScreen.DIAGNOSTICS))
        assertEquals(1, releases.size)
        assertFalse(session.isCapturing(old))
        assertNull(session.accept(old, "late capture"))
        assertEquals(DiagnosticPhase.CANCELLED, session.phase)
    }

    @Test fun backDuringPlaybackReleasesResourcesAndReturnsHome() {
        ready()
        surface.navigate(AutoScreen.DIAGNOSTICS)
        releases.clear()
        val old = session.begin(true)!!
        session.accept(old, "synthetic phrase")
        assertFalse(surface.voiceAvailability(true, true).enabled)
        assertTrue(surface.back())
        assertEquals(AutoScreen.HOME, surface.screen)
        assertEquals(1, releases.size)
        assertFalse(session.isAcknowledging(old))
        assertFalse(session.completeAcknowledgement(old))
        assertNull(session.preview.preview)
    }

    @Test fun aboutNavigationStopsCaptureAndBackReturnsHome() {
        ready()
        val token = session.begin(true)!!
        assertTrue(surface.navigate(AutoScreen.ABOUT))
        assertFalse(session.isActive(token))
        assertTrue(surface.back())
        assertEquals(AutoScreen.HOME, surface.screen)
        assertFalse(surface.back()) // Activity delegates home Back to the OS after cancelling.
    }

    @Test fun repeatedCurrentDestinationDoesNotCancelAnActiveCheck() {
        ready()
        val token = session.begin(true)!!
        assertFalse(surface.navigate(AutoScreen.HOME))
        assertTrue(session.isCapturing(token))
        assertTrue(releases.isEmpty())
    }

    @Test fun halfDuplexDisablesNewCaptureThroughoutAcknowledgement() {
        ready()
        val token = session.begin(surface.canCapture(true))!!
        assertFalse(surface.canCapture(true))
        assertFalse(surface.voiceAvailability(true, true).enabled)
        session.accept(token, "synthetic phrase")
        assertFalse(surface.canCapture(true))
        assertTrue(surface.voiceAvailability(true, true).explanation.contains("acknowledgement"))
        assertTrue(session.completeAcknowledgement(token))
        assertTrue(surface.canCapture(true))
    }

    @Test fun pauseReleasesAndResumeCannotReviveOldCallbacks() {
        ready()
        val old = session.begin(true)!!
        surface.pause()
        assertEquals(1, releases.size)
        assertFalse(surface.canCapture(true))
        surface.resume()
        val current = session.begin(surface.canCapture(true))!!
        assertNull(session.accept(old, "stale"))
        assertTrue(session.isCapturing(current))
    }

    @Test fun destroyCancelsPlaybackInvalidatesRouteAndFailsClosed() {
        ready()
        val token = session.begin(true)!!
        session.accept(token, "synthetic phrase")
        surface.destroy()
        assertEquals(1, releases.size)
        assertFalse(surface.foreground)
        assertEquals(AutoHostState.UNKNOWN, surface.host)
        assertNull(session.preview.destination)
        assertFalse(session.completeAcknowledgement(token))
        assertFalse(surface.voiceAvailability(true, true).enabled)
    }

    @Test fun restrictedAndUnknownTransitionsStopBothCaptureAndPlayback() {
        for (host in listOf(AutoHostState.RESTRICTED, AutoHostState.UNKNOWN, AutoHostState.UNAVAILABLE)) {
            for (playback in listOf(false, true)) {
                ready()
                releases.clear()
                val token = session.begin(true)!!
                if (playback) session.accept(token, "synthetic phrase")
                surface.updateHost(host)
                assertEquals(1, releases.size)
                assertFalse(session.isActive(token))
                assertNull(session.preview.destination)
                assertFalse(surface.canCapture(true))
                assertFalse(surface.voiceAvailability(true, true).enabled)
            }
        }
    }

    @Test fun cannedPreviewSurvivesPermissionAbsenceButNeverNavigationOrRestriction() {
        ready()
        surface.navigate(AutoScreen.DIAGNOSTICS)
        session.preview.select("fixture-thread-1")
        session.preview.finalTranscript("Summarize recent work")
        assertNotNull(session.preview.preview)
        surface.navigate(AutoScreen.HOME)
        assertNull(session.preview.preview)
        surface.updateHost(AutoHostState.RESTRICTED)
        assertNull(session.preview.destination)
    }

    @Test fun privacyBrowserRespectsHostRestrictionsWithReadOnlyPhoneException() {
        surface.resume()
        for (host in AutoHostState.entries) {
            surface.updateHost(host)
            assertEquals(host == AutoHostState.UNRESTRICTED, surface.canOpenPrivacy(true))
            assertTrue(surface.canOpenPrivacy(false))
        }
        surface.pause()
        assertFalse(surface.canOpenPrivacy(false))
    }
}
