package sh.delo.holocene.auto

import android.content.Context
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.File

/** One bounded voice note captured natively (Ogg/Opus). Nothing is kept after [stop] or [cancel]. */
class NativeRecorder(private val context: Context) {
    private var rec: MediaRecorder? = null
    private var file: File? = null
    private val handler = Handler(Looper.getMainLooper())
    private var stats: CaptureStats? = null

    /** Level of the last [CaptureLevel.SAMPLE_MS] window, 0..1 (see [CaptureLevel.meter01]); main thread. */
    var onLevel: ((Double) -> Unit)? = null

    /** Peak/RMS of the most recent recording, set by [stop]/[cancel] and kept until the next [start]. */
    var lastSummary: CaptureStats? = null
        private set

    private val sampler = object : Runnable {
        override fun run() {
            if (rec == null) return
            sampleOnce()
            handler.postDelayed(this, CaptureLevel.SAMPLE_MS)
        }
    }

    private fun sampleOnce() {
        val r = rec ?: return
        val amplitude = try { r.maxAmplitude } catch (e: RuntimeException) { return }
        stats?.add(amplitude)
        onLevel?.invoke(CaptureLevel.meter01(amplitude))
    }

    /** True from a successful [start] until [stop] or [cancel]. */
    val active: Boolean get() = rec != null

    /** Fired when MediaRecorder ends the note by itself (max duration); the caller should [stop] and deliver it. */
    var onAutoStopped: (() -> Unit)? = null

    /** Returns null on success, else a short error name. */
    fun start(): String? {
        cancel()
        lastSummary = null
        var f: File? = null
        var r: MediaRecorder? = null
        return try {
            f = File.createTempFile("pad-", ".ogg", context.cacheDir)
            r = MediaRecorder(context)
            r.setOnInfoListener { _, what, _ ->
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) onAutoStopped?.invoke()
            }
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.OGG)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
            r.setAudioChannels(1)
            r.setAudioSamplingRate(48000)
            r.setAudioEncodingBitRate(32000)
            r.setMaxDuration(5 * 60 * 1000)
            r.setOutputFile(f.path)
            r.prepare()
            r.start()
            rec = r
            file = f
            r.maxAmplitude // the first call only resets the window; its value is meaningless
            stats = CaptureStats()
            handler.postDelayed(sampler, CaptureLevel.SAMPLE_MS)
            null
        } catch (e: Exception) {
            Log.w(TAG, "start failed: ${e.javaClass.simpleName}: ${e.message}")
            try { r?.release() } catch (_: RuntimeException) {}
            f?.delete()
            e.javaClass.simpleName
        }
    }

    /** Returns the recorded bytes, or null if nothing usable was captured. */
    fun stop(): ByteArray? {
        val r = rec ?: return null
        val f = file
        handler.removeCallbacks(sampler)
        sampleOnce() // the tail of the note since the last tick
        lastSummary = stats
        stats = null
        rec = null
        file = null
        return try {
            r.stop()
            f?.readBytes()?.takeIf { it.isNotEmpty() }
        } catch (e: RuntimeException) {
            Log.w(TAG, "stop failed: ${e.javaClass.simpleName}")
            null
        } finally {
            try { r.release() } catch (_: RuntimeException) {}
            f?.delete()
        }
    }

    fun cancel() {
        stop()
    }

    companion object { private const val TAG = "HoloceneNativeRec" }
}
