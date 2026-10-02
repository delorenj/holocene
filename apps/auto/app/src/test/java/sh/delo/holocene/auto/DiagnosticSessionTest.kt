package sh.delo.holocene.auto

import org.junit.Assert.*
import org.junit.Test

class DiagnosticSessionTest {
    @Test fun restrictedOrUnknownHostNeverStartsCapture() {
        val session = DiagnosticSession()
        assertNull(session.begin(false))
        assertEquals(DiagnosticPhase.IDLE, session.phase)
    }

    @Test fun acceptedFinalTranscriptAloneProducesDerivedAcknowledgement() {
        val session = DiagnosticSession()
        val token = session.begin(true)!!
        val ack = session.accept(token, "what time is it now")!!
        assertEquals("Diagnostic acknowledgement. Heard: what time is it now", ack.spoken)
        assertTrue(ack.label.contains("NOT Vox"))
        assertTrue(ack.label.contains("NOT an agent reply"))
        assertEquals(DiagnosticPhase.ACKNOWLEDGING, session.phase)
    }

    @Test fun blankOrOversizedTranscriptProducesNoAcknowledgement() {
        val blank = DiagnosticSession()
        val first = blank.begin(true)!!
        assertNull(blank.accept(first, "  "))
        assertEquals(DiagnosticPhase.DONE, blank.phase)
        assertNull(blank.acknowledgement)
        val oversized = DiagnosticSession()
        val second = oversized.begin(true)!!
        assertNull(oversized.accept(second, "x".repeat(241)))
        assertNull(oversized.acknowledgement)
    }

    @Test fun acknowledgementEchoIsBounded() {
        val ack = AckPolicy.derive((1..30).joinToString(" ") { "w$it" })
        assertEquals(AckPolicy.MAX_ECHO_WORDS, ack.spoken.removePrefix("Diagnostic acknowledgement. Heard: ").split(" ").size)
    }

    @Test fun halfDuplexRefusesOverlappingCaptureAndPlayback() {
        val session = DiagnosticSession()
        val token = session.begin(true)!!
        assertNull(session.begin(true))
        session.accept(token, "status")
        assertEquals(DiagnosticPhase.ACKNOWLEDGING, session.phase)
        assertNull(session.begin(true))
        assertTrue(session.completeAcknowledgement(token))
        assertNotNull(session.begin(true))
    }

    @Test fun cancelMakesEveryEarlierCallbackStale() {
        val session = DiagnosticSession()
        val token = session.begin(true)!!
        assertTrue(session.cancel())
        assertFalse(session.isActive(token))
        assertNull(session.accept(token, "late transcript"))
        assertFalse(session.endCapture(token))
        assertFalse(session.completeAcknowledgement(token))
        assertEquals(3, session.ignoredLate)
        assertNull(session.transcript)
        assertNull(session.acknowledgement)
        assertEquals(DiagnosticPhase.CANCELLED, session.phase)
    }

    @Test fun cancelDuringAcknowledgementDiscardsPreviewAndIgnoresCompletion() {
        val session = DiagnosticSession()
        val token = session.begin(true)!!
        session.accept(token, "status")
        assertNotNull(session.preview.preview)
        assertTrue(session.cancel())
        assertNull(session.preview.preview)
        assertFalse(session.completeAcknowledgement(token))
        assertTrue(session.preview.state.contains("Cancelled"))
    }

    @Test fun staleGenerationCannotAffectNewRun() {
        val session = DiagnosticSession()
        val old = session.begin(true)!!
        session.cancel()
        val fresh = session.begin(true)!!
        assertNotEquals(old, fresh)
        assertNull(session.accept(old, "stale"))
        assertTrue(session.isCapturing(fresh))
        assertNotNull(session.accept(fresh, "current"))
    }

    @Test fun hostRestrictionCancelsAndInvalidatesDestination() {
        val session = DiagnosticSession()
        val token = session.begin(true)!!
        session.accept(token, "status")
        session.restricted()
        assertNull(session.preview.preview)
        assertNull(session.preview.destination)
        assertFalse(session.isActive(token))
        assertNull(session.begin(false))
    }

    @Test fun cancelWhenIdleStillInvalidatesLaterCallbacks() {
        val session = DiagnosticSession()
        val before = session.generation
        assertFalse(session.cancel())
        assertTrue(session.generation > before)
    }

    @Test fun recognizerErrorEndsCaptureWithoutAcknowledgement() {
        val session = DiagnosticSession()
        val token = session.begin(true)!!
        assertTrue(session.endCapture(token))
        assertNull(session.acknowledgement)
        assertNull(session.preview.preview)
    }

    @Test fun pcmStatsMeasureSilenceAndSignal() {
        val silence = PcmStats()
        silence.add(ShortArray(1600), 1600)
        assertEquals(1600L, silence.samples)
        assertEquals(0, silence.peak)
        assertEquals(0L, silence.nonZero)
        assertEquals(0.0, silence.rms, 0.0)
        val signal = PcmStats()
        val data = ShortArray(4) { if (it % 2 == 0) 1000 else (-1000).toShort() }
        signal.add(data, 4)
        assertEquals(1000, signal.peak)
        assertEquals(1000.0, signal.rms, 1e-9)
        assertEquals(4L, signal.nonZero)
    }

    @Test fun pcmStatsPeakHandlesMostNegativeSample() {
        val stats = PcmStats()
        stats.add(shortArrayOf(Short.MIN_VALUE), 1)
        assertEquals(32768, stats.peak)
    }

    @Test fun pcmStatsIgnoresBufferTailBeyondCount() {
        val stats = PcmStats()
        stats.add(shortArrayOf(5, 7000), 1)
        assertEquals(5, stats.peak)
        assertEquals(1L, stats.samples)
    }

    @Test fun envelopeReportsOneRmsValuePerHundredMilliseconds() {
        val stats = PcmStats()
        val loud = ShortArray(PcmStats.WINDOW) { 2000 }
        stats.add(loud, loud.size)
        stats.add(ShortArray(PcmStats.WINDOW), PcmStats.WINDOW)
        assertEquals(listOf(2000, 0), stats.envelope)
    }

    @Test fun onlyPublicStopKeysCancel() {
        assertTrue(StopKeys.isStop(android.view.KeyEvent.KEYCODE_MEDIA_STOP))
        assertTrue(StopKeys.isStop(android.view.KeyEvent.KEYCODE_ESCAPE))
        assertFalse(StopKeys.isStop(android.view.KeyEvent.KEYCODE_VOICE_ASSIST))
        assertFalse(StopKeys.isStop(android.view.KeyEvent.KEYCODE_ENTER))
    }
}
