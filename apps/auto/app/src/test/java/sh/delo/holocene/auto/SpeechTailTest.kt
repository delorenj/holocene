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

    @Test fun toneIsOverOnlyASettleAfterItsLastFrameWasReportedPresented() {
        val e = end()
        assertFalse(e.over(400, frames - 1L))
        assertFalse(e.over(420, frames.toLong())) // reported presented: still on its way to the speakers (sim: up to 263 ms)
        assertFalse(e.over(420 + SpeechTail.TONE_SETTLE_MS - 1, frames.toLong()))
        assertTrue(e.over(420 + SpeechTail.TONE_SETTLE_MS, frames.toLong()))
        assertEquals("presented", e.reason)
    }

    @Test fun theSettleCountsFromTheFirstReportOfTheLastFrame() {
        val e = end()
        assertFalse(e.over(420, frames.toLong()))
        // A later poll without a timestamp does not restart the settle.
        assertTrue(e.over(420 + SpeechTail.TONE_SETTLE_MS, null))
    }

    @Test fun withoutTimestampsAToneWaitsOutTheOutputPath() {
        val e = end()
        assertFalse(e.over(ms + SpeechTail.TONE_TAIL_MS - 1, null))
        assertTrue(e.over(ms + SpeechTail.TONE_TAIL_MS, null))
        assertEquals("no_timestamp", e.reason)
        // Without timestamps the beep's last sound on the sim came 570-657 ms after play(): the fallback waits past it.
        assertTrue(ms + SpeechTail.TONE_TAIL_MS >= 657 + 100)
    }

    @Test fun stalledTimestampsCannotHoldTheQueueForever() {
        val e = end()
        assertFalse(e.over(ms + SpeechTail.TONE_TAIL_MS, 1_000L))
        assertFalse(e.over(ms + SpeechTail.TONE_MAX_TAIL_MS - 1, null)) // a timestamp seen once: this device has them
        assertTrue(e.over(ms + SpeechTail.TONE_MAX_TAIL_MS, 1_000L))
        assertEquals("stalled", e.reason)
    }

    @Test fun anIdleEngineNeverHoldsTheQueue() {
        assertEquals(SpeechTail.Guard.DONE, SpeechTail.speechGuard(SpeechTail.SPEECH_CHECK_MS, speaking = false))
    }

    @Test fun aPhraseStillBeingSpokenIsWaitedForNotTalkedOver() {
        assertEquals(SpeechTail.Guard.WAIT, SpeechTail.speechGuard(SpeechTail.SPEECH_CHECK_MS, speaking = true))
        assertEquals(SpeechTail.Guard.WAIT, SpeechTail.speechGuard(SpeechTail.SPEECH_MAX_MS - 1, speaking = true))
    }

    @Test fun aStuckEngineIsCutBeforeAnythingElsePlays() {
        assertEquals(SpeechTail.Guard.CUT, SpeechTail.speechGuard(SpeechTail.SPEECH_MAX_MS, speaking = true))
    }

    @Test fun startToneFrameCountMatchesTheEarcon() {
        assertEquals(frames, Earcons.pcm(DriveSpeech.Tone.START).size)
    }
}
