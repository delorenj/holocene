package sh.delo.holocene.auto

import android.content.Context
import android.media.MediaRecorder
import android.util.Log
import java.io.File

/** One bounded voice note captured natively (Ogg/Opus). Nothing is kept after [stop] or [cancel]. */
class NativeRecorder(private val context: Context) {
    private var rec: MediaRecorder? = null
    private var file: File? = null

    /** Fired when MediaRecorder ends the note by itself (max duration); the caller should [stop] and deliver it. */
    var onAutoStopped: (() -> Unit)? = null

    /** Returns null on success, else a short error name. */
    fun start(): String? {
        cancel()
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
