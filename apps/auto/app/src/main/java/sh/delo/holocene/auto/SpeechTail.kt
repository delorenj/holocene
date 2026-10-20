package sh.delo.holocene.auto

/**
 * When a sound the app made has really left the speakers. Pure, so the rules are unit-tested.
 *
 * Measured on the Honda sim (2026-10-20, tools/sim_audio_tap.py against logcat): the output path is ~0.3 s long. An
 * earcon whose end was timed from `play()` (its length + 40 ms) was therefore still fully audible when the mic opened:
 * the START tone played 214-231 ms into every recording. A tone now ends when the platform reports its last frame
 * presented, and a halted sound gets the same drain time before a mic opens with no prompt to cover it.
 */
object SpeechTail {
    /** Re-check a playing tone this often. */
    const val POLL_MS = 20L
    /** No presentation timestamps on this device: how long after its last sample a tone may still be coming out. */
    const val TONE_TAIL_MS = 450L
    /** Timestamps that stop advancing: give up waiting this long after the tone's own length. */
    const val TONE_MAX_TAIL_MS = 1_500L
    /** A sound halted for a recording drains this long before a prompt-less mic opens. */
    const val DRAIN_MS = 450L

    /**
     * Is the tone over? [frames] is its length; [presented] the frames the platform reports as played out
     * (AudioTrack.getTimestamp), or null when it gave no timestamp this time; [sawTimestamp] whether it ever did.
     */
    fun toneDone(elapsedMs: Long, durationMs: Long, frames: Int, presented: Long?, sawTimestamp: Boolean): Boolean = when {
        presented != null && presented >= frames -> true
        elapsedMs >= durationMs + (if (sawTimestamp) TONE_MAX_TAIL_MS else TONE_TAIL_MS) -> true
        else -> false
    }

    /** First look at a spoken phrase that has not reported its end. */
    const val SPEECH_CHECK_MS = 4_000L
    /** Then look again this often while the engine still speaks. */
    const val SPEECH_RECHECK_MS = 250L
    /** A phrase still being spoken after this long is cut (nothing in the app is that long; the engine is stuck). */
    const val SPEECH_MAX_MS = 30_000L

    enum class Guard { WAIT, DONE, CUT }

    /**
     * A phrase whose end the TTS engine did not report. A silent or broken engine must never hold the queue (or a mic
     * start) hostage: DONE. One that is still speaking must never have the next sound started over it: WAIT, and past
     * [SPEECH_MAX_MS] CUT it (stop the engine first, then go on). The old rule moved on after 4 s whatever the engine
     * did, so a long echo ("Tower-Of-Lost-Things heard: ...") could still be talking when a progress clip started.
     */
    fun speechGuard(elapsedMs: Long, speaking: Boolean): Guard = when {
        !speaking -> Guard.DONE
        elapsedMs >= SPEECH_MAX_MS -> Guard.CUT
        else -> Guard.WAIT
    }
}
