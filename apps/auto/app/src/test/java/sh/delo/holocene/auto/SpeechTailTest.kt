package sh.delo.holocene.auto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechTailTest {
    private val frames = 5_401 // START: 244 ms at 22050 Hz
    private val ms = 244L

    @Test fun toneIsNotOverWhenItsLengthHasPassed() {
        // The old rule (length + 40 ms) ended it here, while ~0.3 s of it was still on its way to the speaker.
        assertFalse(SpeechTail.toneDone(ms + 40, ms, frames, presented = 0, sawTimestamp = true))
        assertFalse(SpeechTail.toneDone(ms + 40, ms, frames, presented = null, sawTimestamp = false))
    }

    @Test fun toneIsOverWhenItsLastFrameWasPresented() {
        assertFalse(SpeechTail.toneDone(400, ms, frames, presented = frames - 1L, sawTimestamp = true))
        assertTrue(SpeechTail.toneDone(400, ms, frames, presented = frames.toLong(), sawTimestamp = true))
    }

    @Test fun withoutTimestampsAToneWaitsOutTheOutputPath() {
        assertFalse(SpeechTail.toneDone(ms + SpeechTail.TONE_TAIL_MS - 1, ms, frames, null, sawTimestamp = false))
        assertTrue(SpeechTail.toneDone(ms + SpeechTail.TONE_TAIL_MS, ms, frames, null, sawTimestamp = false))
    }

    @Test fun stalledTimestampsCannotHoldTheQueueForever() {
        assertFalse(SpeechTail.toneDone(ms + SpeechTail.TONE_TAIL_MS, ms, frames, 1_000L, sawTimestamp = true))
        assertTrue(SpeechTail.toneDone(ms + SpeechTail.TONE_MAX_TAIL_MS, ms, frames, 1_000L, sawTimestamp = true))
        // A timestamp seen once and then not again still counts as "this device has them".
        assertTrue(SpeechTail.toneDone(ms + SpeechTail.TONE_MAX_TAIL_MS, ms, frames, null, sawTimestamp = true))
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
