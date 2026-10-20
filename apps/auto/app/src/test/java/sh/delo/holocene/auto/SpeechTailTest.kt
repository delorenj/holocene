package sh.delo.holocene.auto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechTailTest {
    private val frames = 5_401 // START: 244 ms at 22050 Hz
    private val ms = 244L

    private fun end() = SpeechTail.ToneEnd(ms, frames)

    @Test fun toneIsNotOverWhenItsLengthHasPassed() {
        // The old rule (length + 40 ms) ended it here, while ~0.3 s of it was still on its way to the speaker.
        assertFalse(end().over(ms + 40, 0))
        assertFalse(end().over(ms + 40, null))
    }

    @Test fun toneIsOverWhenItsLastFrameWasReportedPresented() {
        val e = end()
        assertFalse(e.over(400, frames - 1L))
        assertTrue(e.over(420, frames.toLong()))
        assertEquals("presented", e.reason)
    }

    @Test fun withoutTimestampsAToneWaitsOutTheOutputPath() {
        val e = end()
        assertFalse(e.over(ms + SpeechTail.TONE_TAIL_MS - 1, null))
        assertTrue(e.over(ms + SpeechTail.TONE_TAIL_MS, null))
        assertEquals("no_timestamp", e.reason)
        // On the sim the beep's last sound came 566-657 ms after play(): the fallback waits past it.
        assertTrue(ms + SpeechTail.TONE_TAIL_MS >= 657 + 100)
    }

    @Test fun stalledTimestampsGetTheSameFallbackNeverALongerOne() {
        val e = end()
        assertFalse(e.over(ms + SpeechTail.TONE_TAIL_MS - 1, 1_000L))
        assertTrue(e.over(ms + SpeechTail.TONE_TAIL_MS, 1_000L))
        assertEquals("stalled", e.reason)
    }

    @Test fun theMicWaitsForWhatThePlatformDoesNotReport() {
        // Sim: presented ran up to 263 ms ahead of the speakers and the mic opens >= ~20 ms after; hardware stays short so
        // the beep is not followed by a deaf mic while the driver starts to talk.
        assertTrue(SpeechTail.micSettleMs(emulator = true) + 20 >= 263 + 30)
        assertTrue(SpeechTail.micSettleMs(emulator = false) <= 200)
        assertTrue(SpeechTail.DRAIN_MS >= SpeechTail.micSettleMs(emulator = true))
    }

    @Test fun anIdleEngineNeverHoldsTheQueue() {
        assertEquals(SpeechTail.Guard.DONE, SpeechTail.speechGuard(SpeechTail.SPEECH_CHECK_MS, speaking = false))
    }

    @Test fun aPhraseStillBeingSpokenIsWaitedForNotTalkedOver() {
        assertEquals(SpeechTail.Guard.WAIT, SpeechTail.speechGuard(SpeechTail.SPEECH_CHECK_MS, speaking = true))
        assertEquals(SpeechTail.Guard.WAIT, SpeechTail.speechGuard(SpeechTail.SPEECH_MAX_MS - 1, speaking = true))
    }

    @Test fun aStuckEngineIsCutBeforeTheArmingWatchdogGivesUp() {
        assertEquals(SpeechTail.Guard.CUT, SpeechTail.speechGuard(SpeechTail.SPEECH_MAX_MS, speaking = true))
        assertTrue(SpeechTail.SPEECH_MAX_MS < 15_000L) // SpeechHost.ARM_MAX_MS: a lost prompt end still opens the mic
    }

    @Test fun startToneFrameCountMatchesTheEarcon() {
        assertEquals(frames, Earcons.pcm(DriveSpeech.Tone.START).size)
    }
}
