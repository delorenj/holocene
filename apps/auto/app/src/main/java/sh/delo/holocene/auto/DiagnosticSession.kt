package sh.delo.holocene.auto

import java.util.Locale
import kotlin.math.sqrt

enum class DiagnosticPhase { IDLE, CAPTURING, ACKNOWLEDGING, DONE, CANCELLED }

data class Acknowledgement(val spoken: String, val label: String)

object AckPolicy {
    const val LABEL = "Platform-local diagnostic acknowledgement - NOT Vox - NOT an agent reply"
    const val MAX_ECHO_WORDS = 8

    fun derive(transcript: String): Acknowledgement {
        val words = transcript.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.take(MAX_ECHO_WORDS)
        return Acknowledgement("Diagnostic acknowledgement. Heard: ${words.joinToString(" ")}", LABEL)
    }
}

class PcmStats {
    var samples = 0L
        private set
    var peak = 0
        private set
    var nonZero = 0L
        private set
    private var sumSquares = 0.0
    private var windowSquares = 0.0
    private var windowCount = 0
    private val windows = ArrayList<Int>()
    val envelope: List<Int> get() = windows

    fun add(buffer: ShortArray, count: Int) {
        for (i in 0 until count) {
            val value = buffer[i].toInt()
            val magnitude = if (value < 0) -value else value
            if (magnitude > peak) peak = magnitude
            if (value != 0) nonZero++
            val square = value.toDouble() * value.toDouble()
            sumSquares += square
            windowSquares += square
            if (++windowCount == WINDOW) {
                windows.add(sqrt(windowSquares / WINDOW).toInt())
                windowSquares = 0.0
                windowCount = 0
            }
        }
        samples += count
    }

    val rms: Double get() = if (samples == 0L) 0.0 else sqrt(sumSquares / samples)

    fun summary(): String = String.format(Locale.ROOT, "samples=%d rms=%.1f peak=%d nonzero=%d", samples, rms, peak, nonZero)

    companion object {
        const val WINDOW = 1600
    }
}

class DiagnosticSession {
    val preview = VoicePreview()
    var phase = DiagnosticPhase.IDLE
        private set
    var generation = 0
        private set
    var transcript: String? = null
        private set
    var acknowledgement: Acknowledgement? = null
        private set
    var ignoredLate = 0
        private set
    fun begin(unrestricted: Boolean, route: String = "diagnostic-fixture"): Int? {
        if (!unrestricted) return null
        if (phase == DiagnosticPhase.CAPTURING || phase == DiagnosticPhase.ACKNOWLEDGING) return null
        generation++
        phase = DiagnosticPhase.CAPTURING
        transcript = null
        acknowledgement = null
        preview.select(route)
        return generation
    }

    fun isActive(token: Int): Boolean =
        token == generation && (phase == DiagnosticPhase.CAPTURING || phase == DiagnosticPhase.ACKNOWLEDGING)

    fun isCapturing(token: Int): Boolean = token == generation && phase == DiagnosticPhase.CAPTURING

    fun isAcknowledging(token: Int): Boolean = token == generation && phase == DiagnosticPhase.ACKNOWLEDGING

    fun accept(token: Int, text: String): Acknowledgement? {
        if (!isCapturing(token)) {
            ignoredLate++
            return null
        }
        if (!preview.finalTranscript(text)) {
            preview.cancel()
            phase = DiagnosticPhase.DONE
            return null
        }
        transcript = text.trim()
        phase = DiagnosticPhase.ACKNOWLEDGING
        val ack = AckPolicy.derive(text)
        acknowledgement = ack
        return ack
    }

    fun endCapture(token: Int): Boolean {
        if (!isCapturing(token)) {
            ignoredLate++
            return false
        }
        preview.cancel()
        phase = DiagnosticPhase.DONE
        return true
    }

    fun completeAcknowledgement(token: Int): Boolean {
        if (!isAcknowledging(token)) {
            ignoredLate++
            return false
        }
        preview.cancel()
        phase = DiagnosticPhase.DONE
        return true
    }

    fun cancel(): Boolean {
        val wasActive = phase == DiagnosticPhase.CAPTURING || phase == DiagnosticPhase.ACKNOWLEDGING
        generation++
        phase = DiagnosticPhase.CANCELLED
        transcript = null
        acknowledgement = null
        preview.cancel()
        return wasActive
    }

    fun restricted() {
        cancel()
        preview.invalidateRoute()
    }
}

object StopKeys {
    const val MEDIA_STOP = 86
    const val ESCAPE = 111
    val all = setOf(MEDIA_STOP, ESCAPE)

    fun isStop(keyCode: Int): Boolean = keyCode in all
}
