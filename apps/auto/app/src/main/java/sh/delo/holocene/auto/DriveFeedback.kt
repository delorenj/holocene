package sh.delo.holocene.auto

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTimestamp
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale

/**
 * Eyes-free feedback for the steering-wheel control: short local TTS phrases and earcons, played as
 * USAGE_ASSISTANT with a transient may-duck focus request so the radio dips and comes back instead of being
 * stopped. Nothing here holds standing audio focus or a MediaSession.
 *
 * Focus is honoured, not just asked for: a refused request (a phone call, the car's own voice assistant listening)
 * means the phrase is not said ([say]/[tone] report `false`), and losing the focus mid-phrase (a call starts) stops it
 * and is reported through [onFocusLost], so the speech queue ends that utterance instead of talking over the call.
 * `ownFocus = false`: the caller already holds focus for this sound (the arming prompt plays under the recording's
 * exclusive focus, see SpeechHost.arm), so no second request competes with it.
 */
class DriveFeedback(context: Context) {
    private val app = context.applicationContext
    private val audio = app.getSystemService(AudioManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    private var ready = false
    private var failed = false
    private val queued = ArrayList<Triple<String, Boolean, (Boolean) -> Unit>>()
    private val callbacks = HashMap<String, (Boolean) -> Unit>()
    private var focus: AudioFocusRequest? = null
    /** Phrases spoken under the caller's own focus (ownFocus = false): their end gives nothing back. */
    private val unfocused = HashSet<String>()
    private var outstanding = 0
    private var seq = 0
    private var track: AudioTrack? = null

    /** The focus this app was granted for the sound now playing was taken away (LOSS or LOSS_TRANSIENT); main thread. */
    var onFocusLost: ((change: Int) -> Unit)? = null

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

    /**
     * Speak [text] now (drops what is being said); [then] runs when it finished or could not be spoken: `false` when the
     * audio focus was refused and nothing was said.
     */
    fun say(text: String, ownFocus: Boolean = true, then: (Boolean) -> Unit = {}) {
        Log.i(TAG, "say \"$text\"") // the only record of what the car was told; no TTS engine logs the words
        prepare()
        if (failed) { then(true); return }
        if (!ready) { queued += Triple(text, ownFocus, then); guard(then); return }
        speakNow(text, ownFocus, then)
    }

    private fun speakNow(text: String, ownFocus: Boolean, then: (Boolean) -> Unit) {
        val t = tts
        if (t == null) { then(true); return }
        if (ownFocus && !requestFocus()) {
            Log.w(TAG, "focus refused; not saying \"$text\"")
            then(false)
            return
        }
        val id = "wheel-${++seq}"
        callbacks[id] = then
        if (!ownFocus) unfocused += id
        if (t.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) {
            finished(id)
            return
        }
        // A silent engine must never hold the recording start hostage, and one still talking must never have the next
        // sound started over it (SpeechTail.speechGuard).
        val began = SystemClock.uptimeMillis()
        val guard = object : Runnable {
            override fun run() {
                if (id !in callbacks) return
                val elapsed = SystemClock.uptimeMillis() - began
                val speaking = try { t.isSpeaking } catch (e: RuntimeException) { false }
                when (SpeechTail.speechGuard(elapsed, speaking)) {
                    SpeechTail.Guard.WAIT -> main.postDelayed(this, SpeechTail.SPEECH_RECHECK_MS)
                    SpeechTail.Guard.DONE -> { Log.w(TAG, "no end reported after $elapsed ms, engine idle; going on"); finished(id) }
                    SpeechTail.Guard.CUT -> {
                        Log.w(TAG, "still speaking after $elapsed ms; cut")
                        val cb = callbacks.remove(id)
                        t.stop()
                        if (!unfocused.remove(id)) releaseFocus()
                        cb?.invoke(true)
                    }
                }
            }
        }
        main.postDelayed(guard, SpeechTail.SPEECH_CHECK_MS)
    }

    private fun guard(then: (Boolean) -> Unit) {
        // If TTS never becomes ready, run the continuation anyway.
        main.postDelayed({
            val i = queued.indexOfFirst { it.third === then }
            if (i >= 0) { queued.removeAt(i); then(true) }
        }, INIT_MAX_MS)
    }

    private fun drain() {
        val pending = ArrayList(queued)
        queued.clear()
        for ((text, own, then) in pending) if (ready) speakNow(text, own, then) else then(true)
    }

    private fun finished(id: String?) {
        val cb = callbacks.remove(id ?: return) ?: return
        if (!unfocused.remove(id)) releaseFocus()
        cb(true)
    }

    /** Play an earcon; [then] runs after it ends (its last frame reported presented; see SpeechTail): `false` = focus refused. */
    fun tone(tone: DriveSpeech.Tone, ownFocus: Boolean = true, then: (Boolean) -> Unit = {}) {
        Log.i(TAG, "tone ${tone.name}")
        if (ownFocus && !requestFocus()) {
            Log.w(TAG, "focus refused; tone ${tone.name} not played")
            then(false)
            return
        }
        val pcm = Earcons.pcm(tone)
        var made: AudioTrack? = null
        val focused = ownFocus
        try {
            track?.release()
            track = null
            val format = AudioFormat.Builder().setSampleRate(Earcons.RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()
            val t = AudioTrack(
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
                format, pcm.size * 2, AudioTrack.MODE_STATIC, AudioManager.AUDIO_SESSION_ID_GENERATE,
            )
            made = t
            t.write(pcm, 0, pcm.size)
            t.play()
            track = t
            // Over once its last frame was reported presented, not when play() + its length has passed: the output path
            // is ~0.3 s long. (A mic waits a little more on top: SpeechHost.arm.)
            val began = SystemClock.uptimeMillis()
            val duration = Earcons.durationMs(pcm)
            val stamp = AudioTimestamp()
            val end = SpeechTail.ToneEnd(duration, pcm.size)
            val check = object : Runnable {
                override fun run() {
                    val presented = try { if (t.getTimestamp(stamp)) stamp.framePosition else null } catch (e: RuntimeException) { null }
                    val elapsed = SystemClock.uptimeMillis() - began
                    if (!end.over(elapsed, presented)) {
                        main.postDelayed(this, SpeechTail.POLL_MS)
                        return
                    }
                    val line = "tone ${tone.name} out after $elapsed ms (${duration} ms long, ${end.reason}, presented=${presented ?: "n/a"}/${pcm.size})"
                    if (end.reason == "presented") Log.i(TAG, line) else Log.w(TAG, line)
                    if (track === t) { t.release(); track = null }
                    if (ownFocus) releaseFocus()
                    then(true)
                }
            }
            main.postDelayed(check, duration)
        } catch (e: Exception) {
            Log.w(TAG, "tone failed: ${e.javaClass.simpleName}")
            // Nothing is playing: give the track and the focus back (the radio must not stay ducked).
            made?.let { try { it.release() } catch (_: RuntimeException) {} }
            if (track === made) track = null
            if (focused) releaseFocus()
            then(true)
        }
    }

    /** Ask for (or share the one already held) transient may-duck focus. False: refused, nothing may sound. */
    private fun requestFocus(): Boolean {
        if (focus != null) { outstanding++; return true }
        lateinit var request: AudioFocusRequest
        request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attrs)
            .setOnAudioFocusChangeListener({ change -> onFocusChange(request, change) }, main)
            .build()
        val granted = audio.requestAudioFocus(request)
        if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            Log.w(TAG, "focus request gain=TRANSIENT_MAY_DUCK usage=ASSISTANT result=$granted")
            return false
        }
        focus = request
        outstanding++
        return true
    }

    // Only the request that is still held counts: a late callback for one already given back (the sound was halted and
    // the next one asked again) says nothing about what plays now.
    private fun onFocusChange(request: AudioFocusRequest, change: Int) {
        if (focus !== request || outstanding <= 0) return
        if (change != AudioManager.AUDIOFOCUS_LOSS && change != AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) return
        Log.w(TAG, "focus lost change=$change while speaking: stopping")
        stop()
        onFocusLost?.invoke(change)
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
        unfocused.clear()
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
        const val INIT_MAX_MS = 2500L
    }
}
