package sh.delo.holocene.auto

import java.util.Locale
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Pure level math for a native recording. [android.media.MediaRecorder.getMaxAmplitude] returns the
 * peak 16-bit sample magnitude since the previous call, so one call every [SAMPLE_MS] gives a window
 * peak. No android.* here, so it is unit-testable.
 */
object CaptureLevel {
    const val SAMPLE_MS = 100L
    const val FULL_SCALE = 32768.0

    /** dBFS reported for digital silence (JSON cannot carry -Infinity). */
    const val FLOOR_DBFS = -96.0

    /** A whole recording whose peak stays below this heard nothing. Agent Pad and the watcher agree on it. */
    const val SILENCE_DBFS = -60.0

    fun dbfs(amplitude: Double): Double =
        if (amplitude <= 0.0) FLOOR_DBFS else max(FLOOR_DBFS, 20.0 * log10(min(amplitude, FULL_SCALE) / FULL_SCALE))

    fun dbfs(amplitude: Int): Double = dbfs(amplitude.toDouble())

    /** Meter position 0..1: [SILENCE_DBFS] (and below) is empty, 0 dBFS is full. */
    fun meter01(amplitude: Int): Double = min(1.0, max(0.0, (dbfs(amplitude) - SILENCE_DBFS) / -SILENCE_DBFS))
}

/** Accumulates the per-window peaks of one recording into the summary the page and the proxy report. */
class CaptureStats {
    var samples = 0
        private set
    private var peak = 0
    private var sumSquares = 0.0

    fun add(amplitude: Int) {
        val a = if (amplitude < 0) 0 else amplitude
        if (a > peak) peak = a
        sumSquares += a.toDouble() * a.toDouble()
        samples++
    }

    val peakDbfs: Double get() = CaptureLevel.dbfs(peak)

    /** RMS of the window peaks: an upper bound on the true RMS, exact for a steady tone. */
    val rmsDbfs: Double get() = if (samples == 0) CaptureLevel.FLOOR_DBFS else CaptureLevel.dbfs(sqrt(sumSquares / samples))

    val silent: Boolean get() = peakDbfs < CaptureLevel.SILENCE_DBFS

    fun toJson(): String = String.format(
        Locale.ROOT,
        """{"peak_dbfs":%.1f,"rms_dbfs":%.1f,"samples":%d,"source":"native"}""",
        peakDbfs, rmsDbfs, samples,
    )
}
