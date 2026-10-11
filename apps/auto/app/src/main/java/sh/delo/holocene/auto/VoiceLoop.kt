package sh.delo.holocene.auto

import java.security.MessageDigest

/**
 * Pure state machine + pure helpers for the HOLOC-14 voice loop
 * (record -> upload -> transcribe -> dispatch -> answer -> play).
 * No Android imports; unit-testable on the JVM.
 */
internal enum class LoopPhase {
    IDLE, RECORDING, UPLOADING, TRANSCRIBING, DISPATCHING,
    AWAITING_ANSWER, PLAYING, FAILED, CANCELLED, DONE,
}

internal data class LoopError(val phase: LoopPhase, val reason: String)

/** One voice-loop run against one agent square. */
internal class VoiceLoop(
    val agentName: String,
    private val now: () -> Long = System::currentTimeMillis,
) {
    var phase = LoopPhase.IDLE
        private set
    var threadId: String? = null
        private set
    var itemId: String? = null
        private set
    var lastError: LoopError? = null
        private set
    var attempt = 0
        private set

    val active: Boolean get() = phase !in TERMINAL_PHASES

    fun statusText(): String = when (phase) {
        LoopPhase.IDLE -> "Voice loop idle"
        LoopPhase.RECORDING -> "Recording…"
        LoopPhase.UPLOADING -> "Uploading…"
        LoopPhase.TRANSCRIBING -> "Transcribing…"
        LoopPhase.DISPATCHING -> "Dispatching…"
        LoopPhase.AWAITING_ANSWER -> "Thinking…"
        LoopPhase.PLAYING -> "Playing answer…"
        LoopPhase.FAILED -> "Loop failed: ${lastError?.reason ?: "unknown"}"
        LoopPhase.CANCELLED -> "Loop cancelled"
        LoopPhase.DONE -> "Answer complete"
    }

    /** A new run: allocate thread + go straight to RECORDING. */
    fun begin(): Boolean {
        if (active) return false
        attempt += 1
        threadId = "holocene-auto-${now()}"
        lastError = null
        itemId = null
        phase = LoopPhase.RECORDING
        return true
    }

    fun transition(next: LoopPhase) {
        require(allowed(phase, next)) { "illegal voice-loop transition $phase -> $next" }
        phase = next
    }

    fun fail(reason: String) {
        if (active) {
            lastError = LoopError(phase, reason)
            phase = LoopPhase.FAILED
        }
    }

    fun cancel() {
        if (active) phase = LoopPhase.CANCELLED
    }

    fun complete() {
        if (phase == LoopPhase.PLAYING) phase = LoopPhase.DONE
    }

    /** Record which upload item we are waiting on for this run. */
    fun awaitItem(id: String) {
        itemId = id
    }

    val targetProfile: String get() = VoiceLoopContract.profileFor(agentName)

    companion object {
        val TERMINAL_PHASES = setOf(
            LoopPhase.IDLE, LoopPhase.FAILED, LoopPhase.CANCELLED, LoopPhase.DONE,
        )
        val RUNNING_PHASES = setOf(
            LoopPhase.RECORDING, LoopPhase.UPLOADING, LoopPhase.TRANSCRIBING,
            LoopPhase.DISPATCHING, LoopPhase.AWAITING_ANSWER, LoopPhase.PLAYING,
        )

        fun allowed(from: LoopPhase, to: LoopPhase): Boolean = when (to) {
            LoopPhase.IDLE -> false // never re-enter idle by transition
            LoopPhase.RECORDING -> from == LoopPhase.IDLE
            LoopPhase.UPLOADING -> from == LoopPhase.RECORDING
            LoopPhase.TRANSCRIBING -> from == LoopPhase.UPLOADING
            LoopPhase.DISPATCHING -> from == LoopPhase.TRANSCRIBING
            LoopPhase.AWAITING_ANSWER -> from == LoopPhase.DISPATCHING
            LoopPhase.PLAYING -> from == LoopPhase.AWAITING_ANSWER
            LoopPhase.FAILED, LoopPhase.CANCELLED -> from in RUNNING_PHASES
            LoopPhase.DONE -> from == LoopPhase.PLAYING
        }
    }
}

/** Wire contract constants + pure builders shared by app and tests. */
internal object VoiceLoopContract {
    const val NATS_SUBJECT_TRANSCRIPT = "bloodbank.evt.audio.transcription.completed"
    const val NATS_SUBJECT_DISPATCH = "bloodbank.cmd.agent.invocation.start"
    const val NATS_SUBJECT_ANSWER = "bloodbank.evt.conversation.message.appended"
    const val SOURCE_URN = "urn:33god:cli:holocene-auto"
    const val EVENT_TYPE_DISPATCH = "bloodbank.agent.invocation.start"
    const val DATASCHEMA = "apicurio://holyfields/bloodbank.agent.invocation.start/versions/1"
    const val SCHEMAREF = "bloodbank.agent.invocation.start.v1"
    const val DEFAULT_NATS_HOST = "192.168.1.12"
    const val DEFAULT_NATS_PORT = 4222
    const val DEFAULT_INTAKE_URL = "http://192.168.1.12:8765"
    const val DEFAULT_INTAKE_TOKEN = "wax-local"
    const val FILE_STEM = "holocene-auto"

    /** Grolf->33god-pm mapping with default fallback. */
    val AGENT_PROFILES: Map<String, String> = mapOf("Grolf" to "33god-pm")
    const val FALLBACK_PROFILE = "33god-pm"

    fun profileFor(name: String): String = AGENT_PROFILES[name] ?: FALLBACK_PROFILE

    fun sourceTagFor(name: String): String = "HOLOCENE-AUTO:Agent:$name"

    /** holocene-auto-<epochMs>-<agentName>.m4a */
    fun fileName(epochMs: Long, agentName: String): String = "$FILE_STEM-$epochMs-$agentName.m4a"

    /** sha256(bytes) first 16 hex chars — Wax ledger.identify item_id. */
    fun itemId(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        val sb = StringBuilder(16)
        for (i in 0 until 8) {
            sb.append(((digest[i].toInt() ushr 4) and 0xF).toString(16))
            sb.append((digest[i].toInt() and 0xF).toString(16))
        }
        return sb.toString()
    }

    /**
     * Clean a wax transcript: drop leading '#' header and blank lines; if what
     * remains is blank, fall back to the text minus any header lines.
     */
    fun cleanTranscript(raw: String): String {
        val lines = raw.split('\n')
        var i = 0
        while (i < lines.size) {
            val t = lines[i].trim()
            if (t.isEmpty() || t.startsWith("#")) { i++; continue }
            break
        }
        val body = lines.drop(i).joinToString("\n").trim()
        if (body.isNotEmpty()) return body
        // Fallback: whole text minus header lines (handles all-headers input).
        return lines.filterNot { it.trim().startsWith("#") }.joinToString("\n").trim()
    }

    /** item_id at data.item_id of a transcription.completed envelope. */
    fun itemIdFromEvent(payloadJson: String): String? =
        JsonPath.string(payloadJson, "data", "item_id")

    /** Extract the cleaned utterance from a transcription.completed envelope (null if none). */
    fun transcriptFromEvent(payloadJson: String): String? {
        val text = JsonPath.string(payloadJson, "data", "transcript_text") ?: return null
        val cleaned = cleanTranscript(text)
        return cleaned.ifEmpty { null }
    }

    /** True when the message.appended event belongs to our thread and is a final answer. */
    fun matchesAnswerEvent(payloadJson: String, threadId: String): Boolean {
        val thread = JsonPath.string(payloadJson, "data", "thread_id") ?: return false
        if (thread != threadId) return false
        return JsonPath.boolean(payloadJson, "data", "final_answer") == true
    }

    /** answer audio url from a matched answer envelope; supports reply.audio as nested object or dotted key. */
    fun answerAudioUrl(payloadJson: String): String? {
        JsonPath.lookup(payloadJson, "data", "reply", "audio", "url")?.let { return it as? String }
        return JsonPath.string(payloadJson, "data", "reply.audio", "url")
    }

    /** Build the dispatch envelope JSON. [transcript] must be non-empty. */
    fun buildDispatchEnvelope(
        agentName: String,
        transcript: String,
        threadId: String,
        commandId: String,
        correlationId: String,
        idempotencyKey: String,
        nowIso8601: String,
    ): String {
        require(transcript.isNotBlank()) { "dispatch prompt must not be blank" }
        val profile = profileFor(agentName)
        val sb = StringBuilder(512)
        sb.append("{")
        sb.append("\"specversion\":\"1.0\",")
        sb.append("\"id\":").append(q(commandId)).append(',')
        sb.append("\"source\":\"").append(SOURCE_URN).append("\",")
        sb.append("\"type\":\"").append(EVENT_TYPE_DISPATCH).append("\",")
        sb.append("\"subject\":\"").append(NATS_SUBJECT_DISPATCH).append("\",")
        sb.append("\"time\":").append(q(nowIso8601)).append(',')
        sb.append("\"datacontenttype\":\"application/json\",")
        sb.append("\"kind\":\"command\",")
        sb.append("\"domain\":\"agent\",")
        sb.append("\"dataschema\":\"").append(DATASCHEMA).append("\",")
        sb.append("\"schemaref\":\"").append(SCHEMAREF).append("\",")
        sb.append("\"producer\":\"holocene-auto\",")
        sb.append("\"service\":\"holocene-auto\",")
        sb.append("\"actor\":{\"type\":\"agent_cli\",\"agent_id\":\"holocene-auto\",\"cli\":\"android\"},")
        sb.append("\"correlationid\":").append(q(correlationId)).append(',')
        sb.append("\"causationid\":").append(q(correlationId)).append(',')
        sb.append("\"ordering_key\":\"thread:").append(Json.escape(threadId)).append("\",")
        sb.append("\"idempotency_key\":").append(q(idempotencyKey)).append(',')
        sb.append("\"command_id\":").append(q(commandId)).append(',')
        sb.append("\"delivery\":\"single_consumer\",")
        sb.append("\"data\":{")
        sb.append("\"target_agent_id\":").append(q(profile)).append(',')
        sb.append("\"prompt\":").append(q(transcript)).append(',')
        sb.append("\"thread_id\":").append(q(threadId)).append(',')
        sb.append("\"turn_id\":").append(q(commandId)).append(',')
        sb.append("\"context\":{\"source\":\"").append(Json.escape(sourceTagFor(agentName))).append("\",\"test\":\"holoc-14\"}")
        sb.append("}}")
        return sb.toString()
    }

    private fun q(value: String): String = "\"" + Json.escape(value) + "\""
}

/** Minimal JSON parse/escape helpers (no Android dependency). */
internal object Json {
    fun escape(value: String): String {
        val sb = StringBuilder(value.length + 8)
        for (c in value) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                else -> if (c.code < 0x20) sb.append("\\u%04x".format(c.code)) else sb.append(c)
            }
        }
        return sb.toString()
    }
}

/** String-path lookup in parsed JSON. */
internal object JsonPath {
    fun string(json: String, vararg path: String): String? = lookup(json, *path) as? String

    fun boolean(json: String, vararg path: String): Boolean? = lookup(json, *path) as? Boolean

    fun lookup(json: String, vararg path: String): Any? {
        var node: Any? = JsonParser(json).parseDocument()
        for (key in path) {
            node = when (node) {
                is Map<*, *> -> node[key]
                else -> return null
            }
        }
        return node
    }
}

/** Tiny recursive-descent JSON parser (objects, arrays, strings, numbers, bools, null). */
internal class JsonParser(private val text: String) {
    private var pos = 0

    fun parseDocument(): Any? {
        val value = parseValue()
        skipWs()
        if (pos < text.length) throw IllegalArgumentException("trailing content at $pos")
        return value
    }

    private fun parseValue(): Any? {
        skipWs()
        if (pos >= text.length) throw IllegalArgumentException("unexpected end")
        return when (text[pos]) {
            '{' -> parseObject()
            '[' -> parseArray()
            't' -> literal("true", true)
            'f' -> literal("false", false)
            'n' -> literal("null", null)
            '"' -> parseString()
            else -> parseNumber()
        }
    }

    private fun literal(word: String, value: Any?): Any? {
        if (!text.startsWith(word, pos)) throw IllegalArgumentException("bad literal at $pos")
        pos += word.length
        return value
    }

    private fun parseObject(): LinkedHashMap<String, Any?> {
        expect('{')
        val map = LinkedHashMap<String, Any?>()
        skipWs()
        if (peek() == '}') { pos++; return map }
        while (true) {
            skipWs()
            val key = parseString()
            skipWs()
            expect(':')
            map[key] = parseValue()
            skipWs()
            when (peek()) {
                ',' -> pos++
                '}' -> { pos++; return map }
                else -> throw IllegalArgumentException("expected , or } at $pos")
            }
        }
    }

    private fun parseArray(): ArrayList<Any?> {
        expect('[')
        val list = ArrayList<Any?>()
        skipWs()
        if (peek() == ']') { pos++; return list }
        while (true) {
            list.add(parseValue())
            skipWs()
            when (peek()) {
                ',' -> pos++
                ']' -> { pos++; return list }
                else -> throw IllegalArgumentException("expected , or ] at $pos")
            }
        }
    }

    private fun parseString(): String {
        expect('"')
        val sb = StringBuilder()
        while (true) {
            if (pos >= text.length) throw IllegalArgumentException("unterminated string")
            val c = text[pos]
            when {
                c == '"' -> { pos++; return sb.toString() }
                c == '\\' -> {
                    pos++
                    when (val esc = text[pos]) {
                        '"' -> sb.append('"')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000C')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> { pos++; sb.append(hex4()); continue }
                        else -> throw IllegalArgumentException("bad escape \\$esc at $pos")
                    }
                    pos++
                }
                else -> { sb.append(c); pos++ }
            }
        }
    }

    private fun hex4(): Char {
        val hex = text.substring(pos, pos + 4)
        pos += 4
        return hex.toInt(16).toChar()
    }

    private fun parseNumber(): Any {
        val start = pos
        if (peek() == '-') pos++
        while (pos < text.length && (text[pos].isDigit() || text[pos] in "+-.eE")) pos++
        val raw = text.substring(start, pos)
        return if (raw.contains('.') || raw.contains('e') || raw.contains('E')) raw.toDouble() else raw.toLong()
    }

    private fun expect(c: Char) {
        if (pos >= text.length || text[pos] != c) throw IllegalArgumentException("expected $c at $pos")
        pos++
    }

    private fun peek(): Char {
        if (pos >= text.length) throw IllegalArgumentException("unexpected end")
        return text[pos]
    }

    private fun skipWs() {
        while (pos < text.length && text[pos].isWhitespace()) pos++
    }
}
