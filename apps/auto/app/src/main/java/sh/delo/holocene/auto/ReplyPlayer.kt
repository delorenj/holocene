package sh.delo.holocene.auto

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.util.Log
import java.io.File

/** What a spoken reply should do when audio focus changes hands. Pure so it is unit-tested. */
object ReplyFocus {
    enum class Act { NONE, PAUSE, RESUME, STOP }

    /**
     * A reply asks for a transient may-duck focus, so a navigation prompt just ducks it (the system does that for
     * us: [Act.NONE]), a phone call pauses it until it ends, and another app taking focus for good ends it.
     */
    fun onChange(change: Int, pausedByFocus: Boolean): Act = when (change) {
        AudioManager.AUDIOFOCUS_LOSS -> Act.STOP
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> Act.PAUSE
        AudioManager.AUDIOFOCUS_GAIN -> if (pausedByFocus) Act.RESUME else Act.NONE
        else -> Act.NONE // AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK: the platform lowers our volume itself
    }

    /** Extension for the temp file, from what the page sent; anything odd becomes "bin" (the player sniffs content). */
    fun ext(raw: String): String = raw.lowercase().filter { it in 'a'..'z' || it in '0'..'9' }.take(5).ifEmpty { "bin" }
}

/** Which reply the player is on, so a late callback from a stopped or replaced reply is never forwarded. */
class ReplyTracker {
    var current: String? = null
        private set

    fun begin(id: String) { current = id }

    fun owns(id: String): Boolean = current == id

    /** True exactly once for the current reply; false for a stale or repeated end. */
    fun end(id: String): Boolean {
        if (current != id) return false
        current = null
        return true
    }

    fun clear() { current = null }
}

/**
 * Plays an agent's reply as USAGE_ASSISTANT speech holding only a transient may-duck audio focus request, so the
 * radio or a media app dips and comes back. The WebView `<audio>` element cannot do this: it asks for permanent
 * AUDIOFOCUS_GAIN with USAGE_MUSIC, which stops the radio and may never resume it.
 */
class ReplyPlayer(context: Context) {
    private val app = context.applicationContext
    private val audio = app.getSystemService(AudioManager::class.java)
    private val tracker = ReplyTracker()
    private var player: MediaPlayer? = null
    private var file: File? = null
    private var focus: AudioFocusRequest? = null
    private var pausedByFocus = false

    /** (id, phase = started | ended | error, detail); main thread. Never fired for a reply that [stop] ended. */
    var onPhase: ((String, String, String) -> Unit)? = null

    private val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    val playing: Boolean get() = tracker.current != null

    /**
     * [keepFocus]: the next chunk of the same reply. The transient focus the previous chunk held is kept (if it still
     * holds it), so the radio is not un-ducked and ducked again between two sentences.
     */
    fun play(id: String, bytes: ByteArray, ext: String, keepFocus: Boolean = false) {
        release(keepFocus = keepFocus)
        tracker.begin(id)
        val f = try {
            File.createTempFile("reply-", "." + ReplyFocus.ext(ext), app.cacheDir).also { it.writeBytes(bytes) }
        } catch (e: Exception) {
            fail(id, "write_${e.javaClass.simpleName}")
            return
        }
        file = f
        if (focus == null) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener { change -> onFocus(change) }
                .build()
            val granted = audio.requestAudioFocus(request)
            Log.i(TAG, "reply focus request gain=TRANSIENT_MAY_DUCK usage=ASSISTANT result=$granted")
            if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                fail(id, "focus_denied")
                return
            }
            focus = request
        }
        try {
            val p = MediaPlayer()
            player = p
            p.setAudioAttributes(attrs)
            p.setDataSource(f.path)
            p.setOnPreparedListener {
                if (!tracker.owns(id)) return@setOnPreparedListener
                it.start()
                onPhase?.invoke(id, "started", "")
            }
            p.setOnCompletionListener { finish(id, "ended", (it.duration / 1000.0).toString()) }
            p.setOnErrorListener { _, what, extra -> finish(id, "error", "media $what/$extra"); true }
            p.prepareAsync()
        } catch (e: Exception) {
            fail(id, "player_${e.javaClass.simpleName}")
        }
    }

    // The focus listener outlives one chunk (keepFocus), so it acts on whichever clip is current, never on a stale id.
    private fun onFocus(change: Int) {
        val id = tracker.current ?: return
        Log.i(TAG, "reply focus change=$change")
        when (ReplyFocus.onChange(change, pausedByFocus)) {
            ReplyFocus.Act.PAUSE -> { pausedByFocus = true; try { player?.pause() } catch (_: RuntimeException) {} }
            ReplyFocus.Act.RESUME -> { pausedByFocus = false; try { player?.start() } catch (_: RuntimeException) {} }
            ReplyFocus.Act.STOP -> finish(id, "error", "focus_lost")
            ReplyFocus.Act.NONE -> {}
        }
    }

    private fun fail(id: String, why: String) = finish(id, "error", why)

    private fun finish(id: String, phase: String, detail: String) {
        if (!tracker.end(id)) return
        // A clip that played out keeps the focus through its callback: the next chunk of the same reply starts from
        // inside it (keepFocus) without un-ducking the radio. If nothing started, the focus goes back right after.
        release(keepFocus = phase == "ended")
        onPhase?.invoke(id, phase, detail)
        if (tracker.current == null) abandonFocus()
    }

    /** End the current reply silently (the page decides what that means); no callback. */
    fun stop() {
        tracker.clear()
        release()
    }

    private fun release(keepFocus: Boolean = false) {
        // A chunk paused by a call keeps no focus worth keeping: the next one asks again.
        val keep = keepFocus && !pausedByFocus
        pausedByFocus = false
        player?.let {
            try { it.setOnCompletionListener(null); it.setOnErrorListener(null); it.setOnPreparedListener(null); it.reset(); it.release() } catch (_: RuntimeException) {}
        }
        player = null
        if (!keep) abandonFocus()
        file?.delete()
        file = null
    }

    private fun abandonFocus() {
        focus?.let { audio.abandonAudioFocusRequest(it) }
        focus = null
    }

    private companion object { const val TAG = "HoloceneReply" }
}
