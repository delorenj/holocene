package sh.delo.holocene.auto

/**
 * When a sound the app made has really left the speakers. Pure, so the rules are unit-tested.
 *
 * Measured on the Honda sim (2026-10-20, tools/sim_audio_tap.py against logcat): the output path is ~0.3 s long. An
 * earcon whose end was timed from `play()` (its length + 40 ms) was therefore still fully audible when the mic opened:
 * the START tone played 214-231 ms into every recording. Ending it when AudioTrack reported its last frame presented
 * was not enough either: that report ran 65-171 ms ahead of the speakers (7 recordings), so 4 of 7 still caught
 * 35-95 ms of the beep (and with a 200 ms settle, 2 of 6 still caught 32-44 ms). A tone now ends [TONE_SETTLE_MS]
 * after its last frame was reported presented, and a halted sound gets [DRAIN_MS] before a mic opens with no prompt
 * to cover it.
 */
object SpeechTail {
    /** Re-check a playing tone this often. */
    const val POLL_MS = 20L
    /**
     * After the platform reports a tone's last frame presented, it may still be on its way to the speakers: on the sim
     * 65-263 ms (13 recordings; the emulator's host audio path adds latency the HAL does not report, and it grew over a
     * 90-minute session). The mic opens 20-190 ms after the tone is declared over. 300 ms covers the worst measured
     * case with margin; on hardware whose timestamps are true it opens the mic ~0.3 s after the beep is heard.
     */
    const val TONE_SETTLE_MS = 300L
    /** No presentation timestamps on this device: how long after its own length a tone may still be coming out. */
    const val TONE_TAIL_MS = 600L
    /** Timestamps that stop advancing: give up waiting this long after the tone's own length. */
    const val TONE_MAX_TAIL_MS = 1_500L
    /** A sound halted for a recording drains this long before a prompt-less mic opens. */
    const val DRAIN_MS = 450L

    /**
     * When one playing tone is over. [over] is called every [POLL_MS] with the time since `play()` and the frames the
     * platform reports as presented (AudioTrack.getTimestamp), or null when it gave no timestamp this time.
     */
    class ToneEnd(private val durationMs: Long, private val frames: Int) {
        private var sawTimestamp = false
        private var allPresentedAt = -1L

        /** presented | no_timestamp | stalled, once [over] returned true. */
        var reason = ""
            private set

        fun over(elapsedMs: Long, presented: Long?): Boolean {
            if (presented != null) sawTimestamp = true
            if (presented != null && presented >= frames && allPresentedAt < 0) allPresentedAt = elapsedMs
            reason = when {
                allPresentedAt >= 0 && elapsedMs >= allPresentedAt + TONE_SETTLE_MS -> "presented"
                elapsedMs >= durationMs + (if (sawTimestamp) TONE_MAX_TAIL_MS else TONE_TAIL_MS) ->
                    if (sawTimestamp) "stalled" else "no_timestamp"
                else -> ""
            }
            return reason.isNotEmpty()
        }
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
