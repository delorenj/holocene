package sh.delo.holocene.auto

import android.content.Context
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

    /** Reply playback phases for the page (started | ended | error | deferred), keyed by the page's reply id. */
    var onReplyPhase: ((id: String, phase: String, detail: String) -> Unit)? = null

    /** Every arbiter decision as compact JSON (the page posts it as a client event). */
    var onDecision: ((String) -> Unit)? = null

    init {
        player.onPhase = { id, phase, detail -> onClip(id, phase, detail) }
    }

    private fun onClip(id: String, phase: String, detail: String) {
        val u = arbiter.current
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
        when (val p = u.parts[i]) {
            is SpeechPart.Say -> feedback.say(p.text) { main.post { runParts(u, token, i + 1) } }
            is SpeechPart.Tone -> feedback.tone(p.tone) { main.post { runParts(u, token, i + 1) } }
            // A clip is always the last part: the player's phase callback ends the utterance.
            is SpeechPart.Clip -> player.play(u.id, p.bytes, p.ext)
        }
    }

    override fun halt(u: Utterance, reason: String) {
        step++
        if (u.parts.any { it is SpeechPart.Clip }) player.stop() else feedback.stop()
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

    /** Stop what plays, say [prompt] (if any), then [ready]: the mic opens after the last sound ended. */
    fun arm(prompt: List<SpeechPart>?, ready: () -> Unit) {
        val id = "arm:${SystemClock.elapsedRealtime()}"
        arbiter.arm(prompt?.let { Utterance(id, SpeechKind.ARMING, it) }, ready)
        // A prompt that never reports its end must not leave the queue frozen in "arming" forever.
        main.postDelayed({ if (arbiter.mic == SpeechArbiter.Mic.ARMING && (arbiter.current == null || arbiter.current?.id == id)) {
            Log.w(TAG, "arming never finished; releasing the queue")
            arbiter.recordingEnded()
        } }, ARM_MAX_MS)
    }

    fun recordingStarted() = arbiter.recordingStarted()
    fun recordingEnded() = arbiter.recordingEnded()
    fun dropFeedback() = arbiter.dropFeedback()

    fun reset() {
        arbiter.reset()
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
