package sh.delo.holocene.auto

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale

/**
 * Eyes-free feedback for the steering-wheel control: short local TTS phrases and earcons, played as
 * USAGE_ASSISTANT with a transient may-duck focus request so the radio dips and comes back instead of being
 * stopped. Nothing here holds standing audio focus or a MediaSession.
 */
class DriveFeedback(context: Context) {
    private val app = context.applicationContext
    private val audio = app.getSystemService(AudioManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    private var ready = false
    private var failed = false
    private val queued = ArrayList<Pair<String, () -> Unit>>()
    private val callbacks = HashMap<String, () -> Unit>()
    private var focus: AudioFocusRequest? = null
    private var outstanding = 0
    private var seq = 0
    private var track: AudioTrack? = null

    private val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    /** Warm up the engine so the first phrase is not delayed by TTS initialisation. */
    fun prepare() {
        if (tts != null || failed) return
        tts = TextToSpeech(app) { status ->
            main.post {
                if (status != TextToSpeech.SUCCESS) {
                    failed = true
                    Log.w(TAG, "TTS init failed status=$status")
                    drain()
                    return@post
                }
                val t = tts ?: return@post
                t.language = Locale.US
                t.setAudioAttributes(attrs)
                t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) { main.post { finished(utteranceId) } }
                    // QUEUE_FLUSH drops the phrase being spoken: without this its continuation (the "Recording for X" ->
                    // beep -> open the mic chain) waited for the 4 s SPEECH_MAX_MS fallback, so a second wheel press while
                    // arming delayed the mic by ~3 s and clipped the first words of the note.
                    override fun onStop(utteranceId: String?, interrupted: Boolean) { main.post { finished(utteranceId) } }
                    @Deprecated("Required by UtteranceProgressListener")
                    override fun onError(utteranceId: String?) { main.post { finished(utteranceId) } }
                })
                ready = true
                drain()
            }
        }
    }

    /** Speak [text] now (drops what is being said); [then] runs when it finished or could not be spoken. */
    fun say(text: String, then: () -> Unit = {}) {
        Log.i(TAG, "say \"$text\"") // the only record of what the car was told; no TTS engine logs the words
        prepare()
        if (failed) { then(); return }
        if (!ready) { queued += text to then; guard(then); return }
        speakNow(text, then)
    }

    private fun speakNow(text: String, then: () -> Unit) {
        val t = tts
        if (t == null) { then(); return }
        val id = "wheel-${++seq}"
        callbacks[id] = then
        requestFocus()
        if (t.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) {
            finished(id)
            return
        }
        // A silent engine must never hold the recording start hostage.
        main.postDelayed({ finished(id) }, SPEECH_MAX_MS)
    }

    private fun guard(then: () -> Unit) {
        // If TTS never becomes ready, run the continuation anyway.
        main.postDelayed({
            val i = queued.indexOfFirst { it.second === then }
            if (i >= 0) { queued.removeAt(i); then() }
        }, INIT_MAX_MS)
    }

    private fun drain() {
        val pending = ArrayList(queued)
        queued.clear()
        for ((text, then) in pending) if (ready) speakNow(text, then) else then()
    }

    private fun finished(id: String?) {
        val cb = callbacks.remove(id ?: return) ?: return
        releaseFocus()
        cb()
    }

    /** Play an earcon; [then] runs after it ends. */
    fun tone(tone: DriveSpeech.Tone, then: () -> Unit = {}) {
        Log.i(TAG, "tone ${tone.name}")
        val pcm = Earcons.pcm(tone)
        try {
            track?.release()
            val format = AudioFormat.Builder().setSampleRate(Earcons.RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()
            val t = AudioTrack(
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
                format, pcm.size * 2, AudioTrack.MODE_STATIC, AudioManager.AUDIO_SESSION_ID_GENERATE,
            )
            t.write(pcm, 0, pcm.size)
            requestFocus()
            t.play()
            track = t
            main.postDelayed({
                if (track === t) { t.release(); track = null }
                releaseFocus()
                then()
            }, Earcons.durationMs(pcm) + 40)
        } catch (e: Exception) {
            Log.w(TAG, "tone failed: ${e.javaClass.simpleName}")
            then()
        }
    }

    private fun requestFocus() {
        outstanding++
        if (focus != null) return
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attrs).build()
        focus = request
        audio.requestAudioFocus(request)
    }

    private fun releaseFocus() {
        if (outstanding > 0) outstanding--
        if (outstanding > 0) return
        focus?.let { audio.abandonAudioFocusRequest(it) }
        focus = null
    }

    /** Stop talking and drop anything queued (activity going away). */
    fun stop() {
        queued.clear()
        callbacks.clear()
        tts?.stop()
        track?.let { try { it.release() } catch (_: RuntimeException) {} }
        track = null
        outstanding = 0
        focus?.let { audio.abandonAudioFocusRequest(it) }
        focus = null
        main.removeCallbacksAndMessages(null)
        // Continuations are intentionally NOT run: a recording start must not fire after teardown.
    }

    fun shutdown() {
        stop()
        tts?.shutdown()
        tts = null
        ready = false
    }

    private companion object {
        const val TAG = "HoloceneWheel"
        const val SPEECH_MAX_MS = 4000L
        const val INIT_MAX_MS = 2500L
    }
}
