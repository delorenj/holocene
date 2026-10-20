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
 * - The next utterance is the highest [SpeechKind.rank] (reply > cue > echo > progress > ack), oldest first among
 *   equals.
 * - A playing reply is never cut by anything except a recording start (and an explicit stop).
 * - A reply for a memo makes that memo's progress and echo stale: queued ones are dropped and a playing progress
 *   clip for the same memo is cut.
 * - Progress is newest-wins per memo: an older or equal seq is dropped, a newer one replaces the queued one.
 * - The echo is said at most once per memo.
 * - A sound cut off mid-play (halted) is let drain from the speakers for [HALT_DRAIN_MS] before anything else starts.
 * - Every queued item has a deadline ([Utterance.maxWaitMs]); an ack that could not be said within seconds is
 *   dropped instead of said late.
 * - A chunked reply ([offerChunk]: the watcher uploads the reply sentence by sentence while it renders the rest) is ONE
 *   reply: its chunks play in order, back to back, and while it waits for its next chunk it still holds the queue, so
 *   nothing of lower rank is said between two chunks. A recording start stops the whole reply (the page offers it again
 *   from chunk 1 after the note); a chunk that never comes ends it after [CHUNK_WAIT_MS].
 *
 * Every decision goes to [Output.decision] (the host logs it to logcat tag HoloceneSpeech and as a client event,
 * so overlap can be audited from the server).
 */
enum class SpeechKind(val rank: Int, val wire: String) {
    ARMING(100, "arming"),
    REPLY(40, "reply"),
    // A cue answers something the driver just did (cancelled, not sent, the agent name on the wheel): it goes before
    // narration the driver did not ask for, never before (or over) a reply.
    CUE(35, "cue"),
    ECHO(30, "echo"),
    PROGRESS(20, "progress"),
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
    /** > 0: a chunked reply of this many chunks; its clips arrive through [SpeechArbiter.offerChunk], not [parts]. */
    val chunks: Int = 0,
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
        /** Play chunk [index] (1-based) of the chunked reply [u]; report its end through [chunkEnded]. */
        fun playChunk(u: Utterance, index: Int, clip: SpeechPart.Clip) {}
        /** The chunked reply [u] is over: [reason] "" = its last chunk ended, else why it was given up (chunk_timeout). */
        fun streamDone(u: Utterance, reason: String) {}
        /** [u] now waits for chunk [index]: call [tick] after [CHUNK_WAIT_MS] so a chunk that never comes ends it. */
        fun waitChunk(u: Utterance, index: Int) {}
        /** Call [tick] after [ms]: the queue waits for a halted sound to drain out of the speakers ([HALT_DRAIN_MS]). */
        fun wakeAfter(ms: Long) {}
        /** Stop [u] now, silently. [reason]: recording | after_reply | stopped | reset. */
        fun halt(u: Utterance, reason: String)
        fun decision(d: SpeechDecision)
    }

    enum class Mic { IDLE, ARMING, RECORDING }

    private class Entry(val u: Utterance, val at: Long)

    /** A chunked reply's clips by index, which one plays, and since when it waits for the next one (-1: not waiting). */
    private class Stream(val total: Int) {
        val clips = HashMap<Int, SpeechPart.Clip>()
        var playing = 0
        var waitingSince = -1L
    }

    var mic = Mic.IDLE
        private set
    var current: Utterance? = null
        private set
    private var onArmed: (() -> Unit)? = null
    private val queue = ArrayList<Entry>()
    private val finalMemos = LinkedHashSet<String>()
    private val echoed = LinkedHashSet<String>()
    private val progressSeq = LinkedHashMap<String, Int>()
    private val streams = HashMap<String, Stream>()

    val queued: List<Utterance> get() = queue.map { it.u }

    /** When the last utterance ended or was halted (its sound may still be on its way to the speakers). */
    private var lastSoundEndedAt = Long.MIN_VALUE / 2
    /** When the last utterance was cut off mid-sound: what it had already sent out still plays for a while. */
    private var lastHaltAt = Long.MIN_VALUE / 2
    /** The arming prompt, waiting for a sound it cut to drain ([arm]). */
    private var pendingPrompt: Utterance? = null

    private fun drainLeft(): Long = HALT_DRAIN_MS - (now() - lastHaltAt)

    /**
     * How much longer a mic must wait so that the speakers have been quiet for [needMs]: all of it while something is
     * current, the rest of it after a sound that just ended or was halted, 0 when nothing sounded for that long.
     */
    fun quietLeftMs(needMs: Long): Long = if (current != null) needMs else maxOf(0L, needMs - (now() - lastSoundEndedAt))

    private fun log(action: String, u: Utterance, reason: String = "", seq: Int = u.seq): Unit {
        if (action == "end" || action == "halt") lastSoundEndedAt = now()
        if (action == "halt") lastHaltAt = now()
        out.decision(SpeechDecision(action, u.id, u.kind.wire, u.memoId, seq, reason, now(), mic.name.lowercase()))
    }

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
     * Chunk [index] of [total] of the chunked reply [id]. The first chunk offered queues the reply like any reply (it
     * makes the memo final); later ones are buffered, or played at once when the reply is waiting for exactly that one.
     * Returns false when the chunk was dropped (bad numbers, a duplicate, a count that changed).
     */
    fun offerChunk(id: String, memoId: String?, index: Int, total: Int, clip: SpeechPart.Clip): Boolean {
        val s = streams[id]
        val known = s != null && (current?.id == id || queue.any { it.u.id == id })
        if (total < 2 || total > MAX_CHUNKS || index < 1 || index > total) {
            out.decision(SpeechDecision("drop", id, SpeechKind.REPLY.wire, memoId, index, "bad_chunk", now(), mic.name.lowercase()))
            return false
        }
        if (s != null && known) {
            val u = current?.takeIf { it.id == id } ?: queue.first { it.u.id == id }.u
            if (s.total != total) { log("drop", u, "chunk_count_changed", index); return false }
            if (index in s.clips || index <= s.playing) { log("drop", u, "duplicate_chunk", index); return false }
            s.clips[index] = clip
            if (current?.id == id && s.waitingSince >= 0 && index == s.playing + 1) {
                val waited = now() - s.waitingSince
                s.waitingSince = -1
                s.playing = index
                log("chunk", u, "waited_ms=$waited", index)
                out.playChunk(u, index, clip)
            } else log("chunk", u, "buffered", index)
            return true
        }
        streams[id] = Stream(total).also { it.clips[index] = clip }
        val ok = offer(Utterance(id, SpeechKind.REPLY, emptyList(), memoId = memoId, chunks = total))
        if (!ok) streams.remove(id)
        return ok
    }

    /** Chunk [index] of the playing chunked reply [id] ended (or failed: it is skipped). The next one plays, or the reply waits. */
    fun chunkEnded(id: String, index: Int, detail: String = "") {
        val c = current
        val s = streams[id]
        if (c == null || c.id != id || s == null || s.playing != index) {
            out.decision(SpeechDecision("ignored", id, "", null, index, "not_current", now(), mic.name.lowercase()))
            return
        }
        if (detail.isNotEmpty()) log("chunk", c, "skipped:$detail".take(80), index)
        if (index >= s.total) {
            streams.remove(id)
            current = null
            log("end", c, "chunks=${s.total}")
            out.streamDone(c, "")
            pump()
            return
        }
        playNextChunk(c, s)
    }

    /** A chunked reply that has waited longer than [CHUNK_WAIT_MS] for its next chunk is given up (and the queue moves on). */
    fun tick() {
        val c = current
        if (c == null) {
            if (pendingPrompt != null) startPrompt() else pump()
            return
        }
        val s = streams[c.id] ?: return
        if (s.waitingSince < 0 || now() - s.waitingSince < CHUNK_WAIT_MS) return
        abandon(c.id, "chunk_timeout")
    }

    /**
     * Give the playing chunked reply [id] up as a failure (a chunk that never came, audio focus lost or denied): the
     * output reports it as an error, so the page's own retry limit applies, and the queue moves on.
     */
    fun abandon(id: String, reason: String) {
        val c = current
        val s = streams[id]
        if (c == null || c.id != id || s == null) return
        streams.remove(id)
        current = null
        log("halt", c, reason.take(80), s.playing + (if (s.waitingSince >= 0) 1 else 0))
        out.streamDone(c, reason)
        pump()
    }

    private fun playNextChunk(u: Utterance, s: Stream) {
        val next = s.playing + 1
        val clip = s.clips[next]
        if (clip != null) {
            s.playing = next
            s.waitingSince = -1
            log("chunk", u, if (next == 1) "first" else "next", next)
            out.playChunk(u, next, clip)
        } else {
            s.waitingSince = now()
            log("wait", u, "chunk_$next", next)
            out.waitChunk(u, next)
        }
    }

    private fun begin(u: Utterance) {
        val s = if (u.chunks > 0) streams[u.id] else null
        if (s == null) { out.play(u); return }
        s.playing = 0
        playNextChunk(u, s)
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
            streams.remove(id)
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
        pendingPrompt = null
        out.decision(SpeechDecision("mic", prompt?.id ?: "", "", null, 0, "arming", now(), mic.name.lowercase()))
        if (prompt == null) { ready(); return }
        val p = prompt.copy(kind = SpeechKind.ARMING)
        onArmed = ready
        // What was cut is still coming out of the speakers: the prompt starts once that has drained. Not only a cut made
        // here: the page stops its reply (stopReply -> cancel) a few ms BEFORE it asks to record, so by now nothing is
        // current but the reply's tail is still playing (the sim: 16-55 ms between the halt and the arm).
        val left = drainLeft()
        if (left > 0) {
            pendingPrompt = p
            log("deferred", p, "drain")
            out.wakeAfter(left)
            return
        }
        current = p
        log("start", p, "arming")
        out.play(p)
    }

    private fun startPrompt() {
        val p = pendingPrompt ?: return
        if (mic != Mic.ARMING || current != null) return
        val left = drainLeft()
        if (left > 0) { out.wakeAfter(left); return }
        pendingPrompt = null
        current = p
        log("start", p, "arming")
        out.play(p)
    }

    /** The mic is open. Anything still playing (should be nothing) stops. */
    fun recordingStarted() {
        preempt("recording")
        onArmed = null
        pendingPrompt = null
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
        pendingPrompt?.let { log("drop", it, "disarmed") }
        pendingPrompt = null
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
        streams.clear()
        onArmed = null
        pendingPrompt = null
        if (c != null) { log("halt", c, "reset"); out.halt(c, "reset") }
        removeQueued("reset") { true }
        mic = Mic.IDLE
    }

    private fun preempt(reason: String) {
        val c = current ?: return
        current = null
        streams.remove(c.id) // a chunked reply goes back to the page whole: it offers it again from chunk 1
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
        if (queue.isEmpty()) return
        // A sound that was just cut off is still coming out of the speakers: nothing starts over its tail.
        val left = drainLeft()
        if (left > 0) { out.wakeAfter(left); return }
        val next = queue.withIndex().maxWithOrNull(compareBy<IndexedValue<Entry>> { it.value.u.kind.rank }.thenByDescending { it.index })
            ?: return
        queue.removeAt(next.index)
        val u = next.value.u
        current = u
        log("start", u, "waited_ms=${t - next.value.at}")
        begin(u)
    }

    private fun removeQueued(reason: String, match: (Utterance) -> Boolean) {
        val gone = queue.filter { match(it.u) }
        for (e in gone) { queue.remove(e); streams.remove(e.u.id); log("drop", e.u, reason) }
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
        /** How long a chunked reply waits for its next chunk before it is given up (the watcher renders one in ~3-7 s). */
        const val CHUNK_WAIT_MS = 45_000L
        const val MAX_CHUNKS = 99
        /**
         * After a sound is cut off mid-play, the next one waits this long: what it had already sent out keeps playing
         * (the sim: a halted ack still sounded 319-327 ms into the arming prompt that cut it, 20-50 ms before the
         * prompt's own speech). A sound that ends by itself needs no wait: it was played out.
         */
        const val HALT_DRAIN_MS = 350L

        private val REPLY_MEMO = Regex("""([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9]+$""")

        /** The memo uuid a reply key names (replies/YYYY/MM/DD/HHMMSSZ-<agent>-<uuid>.ogg), or null. */
        fun memoOfReply(key: String): String? = REPLY_MEMO.find(key)?.groupValues?.get(1)

        private val MEMO_ID = Regex("""^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$""")
        fun validMemoId(id: String): Boolean = MEMO_ID.matches(id)
    }
}
