package sh.delo.holocene.auto

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject

/**
 * The Android side of [SpeechArbiter]: the only thing in the app that makes the car speak. Words and earcons go to
 * [DriveFeedback] (local TTS), clips (replies, progress narration) to [ReplyPlayer]. Both are driven only from
 * [play]/[halt], so the arbiter's "one at a time, never while recording" holds for every sound the app makes.
 */
class SpeechHost(context: Context) : SpeechArbiter.Output {
    private val main = Handler(Looper.getMainLooper())
    val feedback = DriveFeedback(context)
    private val player = ReplyPlayer(context)
    val arbiter = SpeechArbiter({ SystemClock.elapsedRealtime() }, this)
    private var step = 0
    /** Seconds of the chunked reply played so far (its chunks' durations), reported with its end. */
    private var streamSeconds = 0.0
    /** A chunk of the current chunked reply actually started (all of them failing is a failure, not "played"). */
    private var streamStarted = false
    /** Which arm() is the live one: a delayed mic open or watchdog from an earlier one does nothing. */
    private var armSeq = 0
    /** The emulator's host audio path adds latency its HAL does not report (SpeechTail.micSettleMs). */
    private val emulator = Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish"

    /** Reply playback phases for the page (started | ended | error | deferred), keyed by the page's reply id. */
    var onReplyPhase: ((id: String, phase: String, detail: String) -> Unit)? = null

    /** Every arbiter decision as compact JSON (the page posts it as a client event). */
    var onDecision: ((String) -> Unit)? = null

    /** Held from arm() until the mic closes: the car pauses other media (the phone's Bluetooth audio, the radio). */
    private val recordingFocus = RecordingFocus(context, main)

    init {
        player.onPhase = { id, phase, detail -> onClip(id, phase, detail) }
        // A call (or the car's own assistant) took the focus a phrase was spoken under: that utterance ends now, through
        // the queue, instead of talking over it.
        feedback.onFocusLost = { change ->
            val c = arbiter.current
            if (c != null && c.kind != SpeechKind.ARMING && c.chunks == 0 && c.parts.none { it is SpeechPart.Clip }) {
                arbiter.cancel(c.id, "focus_lost:$change")
            }
        }
    }

    private fun onClip(id: String, phase: String, detail: String) {
        val u = arbiter.current
        if (u != null && u.chunks > 0) {
            // A chunk's player id is "<reply id>#<index>": only the chunk that is playing now counts.
            val cut = id.lastIndexOf('#')
            val index = id.substring(cut + 1).toIntOrNull() ?: return
            if (cut <= 0 || id.substring(0, cut) != u.id) return
            when (phase) {
                "started" -> if (!streamStarted) { streamStarted = true; onReplyPhase?.invoke(u.id, "started", "") }
                "ended" -> { streamSeconds += detail.toDoubleOrNull() ?: 0.0; arbiter.chunkEnded(u.id, index) }
                // No audio focus (another app took it for good, or a call refused it): the whole reply fails, and the page's
                // retry limit decides what next. Any other error skips that one chunk.
                "error" -> if (detail.startsWith("focus_")) arbiter.abandon(u.id, detail) else arbiter.chunkEnded(u.id, index, "error:$detail")
            }
            return
        }
        if (u == null || u.id != id) return
        if (u.kind == SpeechKind.REPLY) onReplyPhase?.invoke(id, phase, detail)
        if (phase == "ended" || phase == "error") arbiter.finished(id, if (phase == "error") "error:$detail" else "")
    }

    override fun play(u: Utterance) {
        val token = ++step
        runParts(u, token, 0)
    }

    private fun runParts(u: Utterance, token: Int, i: Int) {
        if (token != step || arbiter.current?.id != u.id) return
        if (i >= u.parts.size) { arbiter.finished(u.id); return }
        // The arming prompt plays under the recording's own exclusive focus (taken in arm()); everything else asks for
        // its own transient focus, and is not said at all when that is refused (a call, the car's assistant listening).
        val own = u.kind != SpeechKind.ARMING || !recordingFocus.held
        val next: (Boolean) -> Unit = { ok ->
            main.post { if (ok) runParts(u, token, i + 1) else if (token == step && arbiter.current?.id == u.id) arbiter.finished(u.id, "error:focus_denied") }
        }
        when (val p = u.parts[i]) {
            is SpeechPart.Say -> feedback.say(p.text, own, next)
            is SpeechPart.Tone -> feedback.tone(p.tone, own, next)
            // A clip is always the last part: the player's phase callback ends the utterance.
            is SpeechPart.Clip -> player.play(u.id, p.bytes, p.ext)
        }
    }

    override fun playChunk(u: Utterance, index: Int, clip: SpeechPart.Clip) {
        step++
        if (index == 1) { streamStarted = false; streamSeconds = 0.0 }
        // The reply keeps its audio focus from one chunk to the next: the radio stays ducked, no dip between sentences.
        player.play("${u.id}#$index", clip.bytes, clip.ext, keepFocus = index > 1)
    }

    override fun streamDone(u: Utterance, reason: String) {
        player.stop()
        when {
            reason.isNotEmpty() -> onReplyPhase?.invoke(u.id, "error", reason)
            !streamStarted -> onReplyPhase?.invoke(u.id, "error", "no_chunk_played")
            else -> onReplyPhase?.invoke(u.id, "ended", streamSeconds.toString())
        }
    }

    override fun waitChunk(u: Utterance, index: Int) {
        main.postDelayed({ arbiter.tick() }, SpeechArbiter.CHUNK_WAIT_MS + 100)
    }

    override fun wakeAfter(ms: Long) {
        main.postDelayed({ arbiter.tick() }, ms + 5)
    }

    override fun halt(u: Utterance, reason: String) {
        step++
        if (u.chunks > 0 || u.parts.any { it is SpeechPart.Clip }) player.stop() else feedback.stop()
        if (u.kind == SpeechKind.REPLY) onReplyPhase?.invoke(u.id, "deferred", reason)
    }

    override fun decision(d: SpeechDecision) {
        val wall = System.currentTimeMillis()
        Log.i(TAG, "${d.action} ${d.kind} id=${d.id} memo=${d.memoId ?: "-"} seq=${d.seq} mic=${d.mic} reason=${d.reason} at=$wall")
        val o = JSONObject()
            .put("action", d.action).put("kind", d.kind).put("id", d.id.take(200)).put("seq", d.seq)
            .put("reason", d.reason.take(80)).put("mic", d.mic).put("at", wall).put("mono_ms", d.at)
        d.memoId?.let { o.put("memo_id", it) }
        onDecision?.invoke(o.toString())
    }

    // ---- what the rest of the app asks for ----

    fun cue(id: String, kind: SpeechKind, parts: List<SpeechPart>, maxWaitMs: Long, group: String? = null, deferrable: Boolean = true) {
        if (parts.isEmpty()) return
        arbiter.offer(Utterance(id, kind, parts, group = group, maxWaitMs = maxWaitMs, deferrable = deferrable))
    }

    fun reply(id: String, bytes: ByteArray, ext: String) {
        arbiter.offer(Utterance(id, SpeechKind.REPLY, listOf(SpeechPart.Clip(bytes, ext)), memoId = SpeechArbiter.memoOfReply(id)))
    }

    /** Chunk [index] of [total] of the reply [id] (the page sends them in order as they arrive). */
    fun replyChunk(id: String, index: Int, total: Int, bytes: ByteArray, ext: String) {
        arbiter.offerChunk(id, SpeechArbiter.memoOfReply(id), index, total, SpeechPart.Clip(bytes, ext))
    }

    fun stopReply(id: String?) {
        val c = arbiter.current
        if (id == null) {
            if (c != null && c.kind == SpeechKind.REPLY) arbiter.cancel(c.id)
            arbiter.queued.filter { it.kind == SpeechKind.REPLY }.forEach { arbiter.cancel(it.id) }
        } else arbiter.cancel(id)
    }

    fun progress(memoId: String, seq: Int, bytes: ByteArray, ext: String) {
        arbiter.offer(Utterance("progress:$memoId:$seq", SpeechKind.PROGRESS, listOf(SpeechPart.Clip(bytes, ext)),
            memoId = memoId, seq = seq, maxWaitMs = SpeechArbiter.PROGRESS_WAIT_MS))
    }

    fun echo(memoId: String, text: String) {
        arbiter.offer(Utterance("echo:$memoId", SpeechKind.ECHO, listOf(SpeechPart.Say(text)), memoId = memoId,
            maxWaitMs = SpeechArbiter.ECHO_WAIT_MS))
    }

    fun memoFinal(memoId: String) = arbiter.memoFinal(memoId, "memo_final")

    /** Stop what plays, say [prompt] (if any), then [ready]: the mic opens once the speakers are quiet (SpeechTail). */
    fun arm(prompt: List<SpeechPart>?, ready: () -> Unit) {
        val id = "arm:${SystemClock.elapsedRealtime()}"
        val seq = ++armSeq
        // Exclusive focus first, before anything of ours plays: the car pauses or mutes whatever else is playing (the
        // phone's Bluetooth audio - Earshot speaks the agents' replies there -, the radio) for the length of the note.
        // The queue below only knows the app's own sounds; this is what keeps everyone else's out of the memo.
        val media = recordingFocus.acquire()
        // What ended or was halted is still on its way to the speakers (~0.3 s on the sim), and must not be in the note.
        // After the prompt: its START beep was reported presented, so only the part the platform does not report is
        // left (micSettleMs). With no prompt: until nothing has sounded for DRAIN_MS, a clip just halted or just ended,
        // and, when other media was playing, until the car has had a moment to pause it.
        val go: () -> Unit = {
            val wait = if (prompt == null) maxOf(arbiter.quietLeftMs(SpeechTail.DRAIN_MS), if (media) SpeechTail.MEDIA_PAUSE_MS else 0L)
                else SpeechTail.micSettleMs(emulator)
            if (wait <= 0) ready()
            else main.postDelayed({ if (seq == armSeq && arbiter.mic == SpeechArbiter.Mic.ARMING) ready() }, wait)
        }
        arbiter.arm(prompt?.let { Utterance(id, SpeechKind.ARMING, it) }, go)
        // A prompt that never reports its end must not leave the queue frozen in "arming" forever.
        main.postDelayed({ if (seq == armSeq && arbiter.mic == SpeechArbiter.Mic.ARMING && (arbiter.current == null || arbiter.current?.id == id)) {
            Log.w(TAG, "arming never finished; releasing the queue")
            recordingEnded()
        } }, ARM_MAX_MS)
    }

    fun recordingStarted() {
        recordingFocus.acquire() // a no-op after arm(); the page's getUserMedia fallback opens a mic without arming
        arbiter.recordingStarted()
    }

    fun recordingEnded() {
        // The queue resumes first (an ack takes its own focus), then the recording's focus goes back: the paused media
        // comes back after what the car says next, not under it.
        arbiter.recordingEnded()
        recordingFocus.release()
    }

    fun dropFeedback() = arbiter.dropFeedback()

    fun reset() {
        arbiter.reset()
        recordingFocus.release()
        main.removeCallbacksAndMessages(null)
    }

    fun shutdown() {
        reset()
        feedback.shutdown()
    }

    private companion object {
        const val TAG = "HoloceneSpeech"
        const val ARM_MAX_MS = 15_000L
    }
}

/**
 * The audio focus a note holds while it is armed and recorded: AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE as assistant usage.
 * Media that holds focus (the phone's Bluetooth stream, which is where Earshot plays a reply when the phone is paired;
 * the radio) loses it transiently, so the head unit pauses or mutes it until the note is done (Earshot keeps a paused
 * item and replays it later). Nothing plays under it but the app's own arming prompt.
 */
private class RecordingFocus(context: Context, private val main: Handler) {
    private val audio = context.applicationContext.getSystemService(AudioManager::class.java)
    private var request: AudioFocusRequest? = null

    val held: Boolean get() = request != null

    /** Take the focus (once per note). True when other media was playing as it was taken (the mic gives it a moment). */
    fun acquire(): Boolean {
        if (request != null) return false
        val media = try { audio.isMusicActive } catch (e: RuntimeException) { false }
        val r = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setOnAudioFocusChangeListener({ change -> Log.i(TAG, "recording focus change=$change") }, main)
            .build()
        val result = try { audio.requestAudioFocus(r) } catch (e: RuntimeException) { AudioManager.AUDIOFOCUS_REQUEST_FAILED }
        Log.i(TAG, "recording focus request gain=TRANSIENT_EXCLUSIVE usage=ASSISTANT result=$result media_active=$media")
        // Held (and given back later) even when refused: abandoning a request that was never granted is harmless, and a
        // refusal (a call) must not stop the driver from recording.
        request = r
        return media && result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    fun release() {
        val r = request ?: return
        request = null
        try { audio.abandonAudioFocusRequest(r) } catch (_: RuntimeException) {}
        Log.i(TAG, "recording focus released")
    }

    private companion object { const val TAG = "HoloceneSpeech" }
}
