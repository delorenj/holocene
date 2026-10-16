package sh.delo.holocene.auto

import kotlin.math.PI
import kotlin.math.sin

/** Short synthesised tones for eyes-free feedback; pure PCM so the shape is testable. */
object Earcons {
    const val RATE = 22050

    /** One sine beep with a 6 ms fade at each end (no click). */
    fun tone(freqHz: Double, ms: Int, volume: Double = 0.4): ShortArray {
        val n = RATE * ms / 1000
        val fade = (RATE * 6 / 1000).coerceAtLeast(1)
        return ShortArray(n) { i ->
            val edge = minOf(i, n - 1 - i)
            val env = if (edge < fade) edge.toDouble() / fade else 1.0
            (sin(2 * PI * freqHz * i / RATE) * env * volume * Short.MAX_VALUE).toInt().toShort()
        }
    }

    private fun silence(ms: Int) = ShortArray(RATE * ms / 1000)

    private fun seq(vararg parts: ShortArray): ShortArray = parts.fold(ShortArray(0)) { a, b -> a + b }

    fun pcm(tone: DriveSpeech.Tone): ShortArray = when (tone) {
        DriveSpeech.Tone.START -> seq(tone(660.0, 90), silence(25), tone(880.0, 130))
        DriveSpeech.Tone.STOP -> seq(tone(880.0, 90), silence(25), tone(550.0, 130))
        DriveSpeech.Tone.SENT -> seq(tone(660.0, 70), silence(20), tone(880.0, 70), silence(20), tone(1100.0, 110))
        DriveSpeech.Tone.ERROR -> seq(tone(300.0, 160), silence(40), tone(220.0, 260))
    }

    fun durationMs(samples: ShortArray): Long = samples.size * 1000L / RATE
}
