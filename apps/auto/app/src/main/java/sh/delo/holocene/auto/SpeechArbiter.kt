package sh.delo.holocene.auto

/**
 * Everything the car says, in one queue: the agent's reply, the "heard" echo, progress narration, the instant
 * ack and the short wheel cues. Pure (no android.*), so every ordering rule is a JUnit test.
 *
 * The rules, all enforced here and nowhere else:
 * - One utterance at a time. Nothing is mixed, nothing is spoken over anything else.
 * - Nothing starts while a note is being armed or recorded; arming stops whatever is playing. The only thing that
 *   may play while arming is the arming prompt itself ("Recording for X" + the start tone), which ends before the
 *   mic opens.
 * - The next utterance is the highest [SpeechKind.rank], oldest first among equals.
 * - A playing reply is never cut by anything except a recording start (and an explicit stop).
 * - A reply for a memo makes that memo's progress and echo stale: queued ones are dropped and a playing progress
 *   clip for the same memo is cut.
 * - Progress is newest-wins per memo: an older or equal seq is dropped, a newer one replaces the queued one.
 * - The echo is said at most once per memo.
 * - Every queued item has a deadline ([Utterance.maxWaitMs]); an ack that could not be said within seconds is
 *   dropped instead of said late.
 *
 * Every decision goes to [Output.decision] (the host logs it to logcat tag HoloceneSpeech and as a client event,
 * so overlap can be audited from the server).
 */
enum class SpeechKind(val rank: Int, val wire: String) {
    ARMING(100, "arming"),
    REPLY(40, "reply"),
    ECHO(30, "echo"),
    PROGRESS(20, "progress"),
    CUE(15, "cue"),
    ACK(10, "ack"),
}

/** What the Android side renders: spoken words, an earcon, or an audio clip (reply / progress). */
sealed class SpeechPart {
    data class Say(val text: String) : SpeechPart()
    data class Tone(val tone: DriveSpeech.Tone) : SpeechPart()
    class Clip(val bytes: ByteArray, val ext: String) : SpeechPart()
}

data class Utterance(
    val id: String,
    val kind: SpeechKind,
    val parts: List<SpeechPart>,
    val memoId: String? = null,
    val seq: Int = 0,
    /** A newer utterance in the same group replaces a queued older one (agent selection names). */
    val group: String? = null,
    /** Dropped if it could not start within this long of being offered. */
    val maxWaitMs: Long = Long.MAX_VALUE,
    /** False: offered while the mic is busy, it is dropped instead of deferred (a "Stop first" refusal). */
    val deferrable: Boolean = true,
)

data class SpeechDecision(
    /** queued | deferred | start | end | halt | drop | ignored | mic */
    val action: String,
    val id: String,
    val kind: String,
    val memoId: String?,
    val seq: Int,
    val reason: String,
    val at: Long,
    val mic: String,
)

class SpeechArbiter(private val now: () -> Long, private val out: Output) {
    interface Output {
        fun play(u: Utterance)
        /** Stop [u] now, silently. [reason]: recording | after_reply | stopped | reset. */
        fun halt(u: Utterance, reason: String)
        fun decision(d: SpeechDecision)
    }

    enum class Mic { IDLE, ARMING, RECORDING }

    private class Entry(val u: Utterance, val at: Long)

    var mic = Mic.IDLE
        private set
    var current: Utterance? = null
        private set
    private var onArmed: (() -> Unit)? = null
    private val queue = ArrayList<Entry>()
    private val finalMemos = LinkedHashSet<String>()
    private val echoed = LinkedHashSet<String>()
    private val progressSeq = LinkedHashMap<String, Int>()

    val queued: List<Utterance> get() = queue.map { it.u }

    private fun log(action: String, u: Utterance, reason: String = "") =
        out.decision(SpeechDecision(action, u.id, u.kind.wire, u.memoId, u.seq, reason, now(), mic.name.lowercase()))

    private fun drop(u: Utterance, reason: String): Boolean { log("drop", u, reason); return false }

    /** Offer an utterance. Returns true if it was queued or started, false if dropped. */
    fun offer(u: Utterance): Boolean {
        if (u.kind == SpeechKind.ARMING) return drop(u, "use_arm")
        if (current?.id == u.id || queue.any { it.u.id == u.id }) return drop(u, "duplicate")
        val memo = u.memoId
        when (u.kind) {
            SpeechKind.PROGRESS -> {
                if (memo != null && memo in finalMemos) return drop(u, "after_reply")
                if (memo != null && u.seq <= (progressSeq[memo] ?: 0)) return drop(u, "stale")
                if (memo != null) remember(progressSeq, memo, u.seq)
                removeQueued("superseded") { it.kind == SpeechKind.PROGRESS && it.memoId == memo }
            }
            SpeechKind.ECHO -> {
                if (memo != null && memo in finalMemos) return drop(u, "after_reply")
                if (memo != null && memo in echoed) return drop(u, "duplicate")
                if (memo != null) remember(echoed, memo)
            }
            SpeechKind.REPLY -> if (memo != null) memoFinal(memo, "after_reply")
            else -> {}
        }
        if (mic != Mic.IDLE && !u.deferrable) return drop(u, "recording")
        if (u.group != null) removeQueued("superseded") { it.group == u.group }
        queue += Entry(u, now())
        if (mic != Mic.IDLE) log("deferred", u, "recording")
        else log("queued", u, current?.let { "behind_${it.kind.wire}" } ?: "")
        pump()
        return true
    }

    /**
     * The memo has its final reply (or failed): nothing more about its progress is said. Queued progress and echo
     * for it are dropped and a progress clip for it that is playing is cut.
     */
    fun memoFinal(memoId: String, reason: String = "after_reply") {
        remember(finalMemos, memoId)
        removeQueued(reason) { it.memoId == memoId && (it.kind == SpeechKind.PROGRESS || it.kind == SpeechKind.ECHO) }
        val c = current
        if (c != null && c.memoId == memoId && c.kind == SpeechKind.PROGRESS) {
            current = null
            log("halt", c, reason)
            out.halt(c, reason)
            pump()
        }
    }

    /** The output finished [id] (played out, or failed). A stale or unknown id is ignored. */
    fun finished(id: String, detail: String = "") {
        val c = current
        if (c == null || c.id != id) {
            out.decision(SpeechDecision("ignored", id, "", null, 0, "not_current", now(), mic.name.lowercase()))
            return
        }
        current = null
        log("end", c, detail)
        if (c.kind == SpeechKind.ARMING) {
            val go = onArmed
            onArmed = null
            go?.invoke()
            return
        }
        pump()
    }

    /** Stop or unqueue one utterance by id (the page stopped its reply). */
    fun cancel(id: String, reason: String = "stopped") {
        val c = current
        if (c != null && c.id == id) {
            current = null
            log("halt", c, reason)
            out.halt(c, reason)
            pump()
            return
        }
        removeQueued(reason) { it.id == id }
    }

    /**
     * A note is about to be recorded. Whatever plays is stopped now (a halted echo or progress clip goes back in the
     * queue if still wanted; a reply is handed back to the page, which re-queues it). Then [prompt] (if any) plays,
     * and [ready] runs when it ended, so the prompt is never recorded. With no prompt [ready] runs at once.
     */
    fun arm(prompt: Utterance?, ready: () -> Unit) {
        preempt("recording")
        mic = Mic.ARMING
        onArmed = null
        out.decision(SpeechDecision("mic", prompt?.id ?: "", "", null, 0, "arming", now(), mic.name.lowercase()))
        if (prompt == null) { ready(); return }
        val p = prompt.copy(kind = SpeechKind.ARMING)
        onArmed = ready
        current = p
        log("start", p, "arming")
        out.play(p)
    }

    /** The mic is open. Anything still playing (should be nothing) stops. */
    fun recordingStarted() {
        preempt("recording")
        onArmed = null
        mic = Mic.RECORDING
        out.decision(SpeechDecision("mic", "", "", null, 0, "recording", now(), mic.name.lowercase()))
    }

    /** The mic is closed (stopped, cancelled, failed to open, or arming was interrupted). Deferred speech resumes. */
    fun recordingEnded() {
        if (mic == Mic.IDLE) return
        val c = current
        if (c != null && c.kind == SpeechKind.ARMING) {
            current = null
            log("halt", c, "disarmed")
            out.halt(c, "disarmed")
        }
        onArmed = null
        mic = Mic.IDLE
        out.decision(SpeechDecision("mic", "", "", null, 0, "idle", now(), mic.name.lowercase()))
        pump()
    }

    /** Drop the local feedback (cues and acks), e.g. the activity left the screen; replies and progress stay. */
    fun dropFeedback(reason: String = "paused") {
        removeQueued(reason) { it.kind == SpeechKind.CUE || it.kind == SpeechKind.ACK }
        val c = current
        if (c != null && (c.kind == SpeechKind.CUE || c.kind == SpeechKind.ACK)) {
            current = null
            log("halt", c, reason)
            out.halt(c, reason)
            pump()
        }
    }

    /** Stop everything and forget the queue (page torn down). */
    fun reset() {
        val c = current
        current = null
        onArmed = null
        if (c != null) { log("halt", c, "reset"); out.halt(c, "reset") }
        removeQueued("reset") { true }
        mic = Mic.IDLE
    }

    private fun preempt(reason: String) {
        val c = current ?: return
        current = null
        log("halt", c, reason)
        out.halt(c, reason)
        // A short echo or a progress line that was cut is still news after the note; a reply goes back to its owner
        // (the page) and cues/acks/prompts are moot.
        if (c.kind == SpeechKind.ECHO || c.kind == SpeechKind.PROGRESS) {
            queue.add(0, Entry(c, now()))
            log("deferred", c, "requeued")
        }
    }

    private fun pump() {
        if (current != null || mic != Mic.IDLE) return
        val t = now()
        val expired = queue.filter { t - it.at > it.u.maxWaitMs }
        for (e in expired) { queue.remove(e); log("drop", e.u, "expired") }
        val next = queue.withIndex().maxWithOrNull(compareBy<IndexedValue<Entry>> { it.value.u.kind.rank }.thenByDescending { it.index })
            ?: return
        queue.removeAt(next.index)
        val u = next.value.u
        current = u
        log("start", u, "waited_ms=${t - next.value.at}")
        out.play(u)
    }

    private fun removeQueued(reason: String, match: (Utterance) -> Boolean) {
        val gone = queue.filter { match(it.u) }
        for (e in gone) { queue.remove(e); log("drop", e.u, reason) }
    }

    private fun remember(set: LinkedHashSet<String>, v: String) {
        set += v
        while (set.size > MEMORY) set.remove(set.first())
    }

    private fun remember(map: LinkedHashMap<String, Int>, k: String, v: Int) {
        map[k] = v
        while (map.size > MEMORY) map.remove(map.keys.first())
    }

    companion object {
        private const val MEMORY = 200
        const val ACK_WAIT_MS = 6_000L
        const val SELECT_WAIT_MS = 4_000L
        const val CUE_WAIT_MS = 30_000L
        const val ECHO_WAIT_MS = 90_000L
        const val PROGRESS_WAIT_MS = 30_000L

        private val REPLY_MEMO = Regex("""([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9]+$""")

        /** The memo uuid a reply key names (replies/YYYY/MM/DD/HHMMSSZ-<agent>-<uuid>.ogg), or null. */
        fun memoOfReply(key: String): String? = REPLY_MEMO.find(key)?.groupValues?.get(1)

        private val MEMO_ID = Regex("""^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$""")
        fun validMemoId(id: String): Boolean = MEMO_ID.matches(id)
    }
}
