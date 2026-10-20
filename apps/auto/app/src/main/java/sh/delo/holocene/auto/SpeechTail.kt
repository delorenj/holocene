package sh.delo.holocene.auto

/**
 * When a sound the app made has really left the speakers, and so when a mic may open. Pure, so the rules are tested.
 *
 * Measured on the Honda sim (2026-10-20, tools/sim_audio_tap.py against logcat): the output path is ~0.3 s long. An
 * earcon whose end was timed from `play()` (its length + 40 ms) was therefore still fully audible when the mic opened:
 * the START beep played 214-231 ms into every recording. AudioTrack's presentation timestamps are the better clock, but
 * on the sim they ran 65-263 ms ahead of the speakers (the emulator's host audio path adds latency the HAL does not
 * report; it grew over a 90-minute session), so 4 of 7 recordings still caught 35-95 ms of the beep.
 *
 * So: a tone is over when its last frame is reported presented ([ToneEnd]); that is enough between two sounds, which
 * leave one mixer in order. Only a mic waits longer: [micSettleMs] after the arming prompt ended, or, with no prompt,
 * until the speakers have been quiet for [DRAIN_MS] ([SpeechArbiter.quietLeftMs]).
 */
object SpeechTail {
    /** Re-check a playing tone this often. */
    const val POLL_MS = 20L
    /** No usable presentation timestamps: how long after its own length a tone may still be coming out. */
    const val TONE_TAIL_MS = 600L
    /** Without a prompt, the mic waits until nothing has sounded for this long (a halted clip drains its whole path). */
    const val DRAIN_MS = 450L
    /** Emulator: its host audio path adds up to 263 ms the HAL does not report (300 covers it with margin). */
    const val MIC_SETTLE_EMULATOR_MS = 300L
    /**
     * Hardware: timestamps should be close to the truth, but an amplifier or DSP after the HAL is not in them. Kept
     * short because the driver starts talking after the beep: the mic must not open much later than it is heard.
     */
    const val MIC_SETTLE_MS = 150L

    /**
     * No prompt, and other media was playing when the recording took its exclusive focus: the head unit needs a moment
     * to pause it (a Bluetooth stream goes through AVRCP to the phone). A judgment, not a measurement; with a prompt the
     * prompt itself (~1.5 s) is that moment.
     */
    const val MEDIA_PAUSE_MS = 400L

    /** How long the mic waits after the arming prompt (ending in the START beep) reported its end. */
    fun micSettleMs(emulator: Boolean): Long = if (emulator) MIC_SETTLE_EMULATOR_MS else MIC_SETTLE_MS

    /**
     * When one playing tone is over. [over] is called every [POLL_MS] with the time since `play()` and the frames the
     * platform reports as presented (AudioTrack.getTimestamp), or null when it gave no timestamp this time.
     */
    class ToneEnd(private val durationMs: Long, private val frames: Int) {
        private var sawTimestamp = false

        /** presented | no_timestamp | stalled, once [over] returned true. */
        var reason = ""
            private set

        fun over(elapsedMs: Long, presented: Long?): Boolean {
            if (presented != null) sawTimestamp = true
            reason = when {
                presented != null && presented >= frames -> "presented"
                // Timestamps that stop short of the last frame (a HAL that retires a finished static track early) get
                // the same fallback as none at all, never a longer one: a late mic loses the driver's first words.
                elapsedMs >= durationMs + TONE_TAIL_MS -> if (sawTimestamp) "stalled" else "no_timestamp"
                else -> ""
            }
            return reason.isNotEmpty()
        }
    }

    /** First look at a spoken phrase that has not reported its end. */
    const val SPEECH_CHECK_MS = 4_000L
    /** Then look again this often while the engine still speaks. */
    const val SPEECH_RECHECK_MS = 250L
    /**
     * A phrase still being spoken after this long is cut (nothing the app says is that long; the engine is stuck). Under
     * the 15 s arming watchdog, so a prompt whose end was lost still reaches the open mic instead of being disarmed.
     */
    const val SPEECH_MAX_MS = 10_000L

    enum class Guard { WAIT, DONE, CUT }

    /**
     * A phrase whose end the TTS engine did not report. A silent or broken engine must never hold the queue (or a mic
     * start) hostage: DONE. One that is still speaking must never have the next sound started over it: WAIT, and past
     * [SPEECH_MAX_MS] CUT it (stop the engine first, then go on). The old rule moved on after 4 s whatever the engine
     * did; on the sim a 4.45 s echo ("Holocene heard: Driving timing test, check the date with a") outlived it.
     */
    fun speechGuard(elapsedMs: Long, speaking: Boolean): Guard = when {
        !speaking -> Guard.DONE
        elapsedMs >= SPEECH_MAX_MS -> Guard.CUT
        else -> Guard.WAIT
    }
}
