package sh.delo.holocene.auto

/** What a wheel button, rotary detent or media-session callback can ask Agent Pad to do. */
enum class DriveAction(val js: String) {
    SELECT_PREV("select_prev"),
    SELECT_NEXT("select_next"),
    TOGGLE_RECORD("toggle_record"),
    CANCEL("cancel"),
}

/** Android keycodes this feature cares about (plain ints so the logic stays JVM-testable). */
object Keys {
    const val HOME = 3
    const val BACK = 4
    const val CALL = 5
    const val ENDCALL = 6
    const val DPAD_LEFT = 21
    const val DPAD_RIGHT = 22
    const val DPAD_CENTER = 23
    const val VOLUME_UP = 24
    const val VOLUME_DOWN = 25
    const val POWER = 26
    const val ENTER = 66
    const val HEADSETHOOK = 79
    const val MEDIA_PLAY_PAUSE = 85
    const val MEDIA_STOP = 86
    const val MEDIA_NEXT = 87
    const val MEDIA_PREVIOUS = 88
    const val MEDIA_REWIND = 89
    const val MEDIA_FAST_FORWARD = 90
    const val ESCAPE = 111
    const val MEDIA_PLAY = 126
    const val MEDIA_PAUSE = 127
    const val MEDIA_RECORD = 130
    const val F7 = 137
    const val NUMPAD_ENTER = 160
    const val VOLUME_MUTE = 164
    const val ASSIST = 219
    const val VOICE_ASSIST = 231
    const val NAVIGATE_PREVIOUS = 260
    const val NAVIGATE_NEXT = 261

    /** Keys the system or the driver relies on; never mappable, never swallowed. */
    val PROTECTED = setOf(HOME, BACK, CALL, ENDCALL, VOLUME_UP, VOLUME_DOWN, POWER, VOLUME_MUTE, ASSIST, VOICE_ASSIST, 187, 223, 224)

    private val NAMES = mapOf(
        "HOME" to HOME, "BACK" to BACK, "DPAD_LEFT" to DPAD_LEFT, "DPAD_RIGHT" to DPAD_RIGHT, "DPAD_CENTER" to DPAD_CENTER,
        "ENTER" to ENTER, "HEADSETHOOK" to HEADSETHOOK, "MEDIA_PLAY_PAUSE" to MEDIA_PLAY_PAUSE, "MEDIA_STOP" to MEDIA_STOP,
        "MEDIA_NEXT" to MEDIA_NEXT, "MEDIA_PREVIOUS" to MEDIA_PREVIOUS, "MEDIA_REWIND" to MEDIA_REWIND,
        "MEDIA_FAST_FORWARD" to MEDIA_FAST_FORWARD, "ESCAPE" to ESCAPE, "MEDIA_PLAY" to MEDIA_PLAY, "MEDIA_PAUSE" to MEDIA_PAUSE,
        "MEDIA_RECORD" to MEDIA_RECORD, "F7" to F7, "NUMPAD_ENTER" to NUMPAD_ENTER, "NAVIGATE_PREVIOUS" to NAVIGATE_PREVIOUS,
        "NAVIGATE_NEXT" to NAVIGATE_NEXT, "VOLUME_UP" to VOLUME_UP, "VOLUME_DOWN" to VOLUME_DOWN,
        "VOICE_ASSIST" to VOICE_ASSIST, "CALL" to CALL, "ENDCALL" to ENDCALL,
    )
    private val BY_CODE = NAMES.entries.associate { it.value to it.key }

    /** `87`, `MEDIA_NEXT` or `KEYCODE_MEDIA_NEXT` to a keycode, else null. */
    fun parse(token: String): Int? {
        val t = token.trim().uppercase().removePrefix("KEYCODE_")
        return t.toIntOrNull()?.takeIf { it in 1..400 } ?: NAMES[t]
    }

    /** Pure, short name for the settings text (the inspector shows android's own name beside it). */
    fun name(code: Int): String = BY_CODE[code] ?: code.toString()
}

/**
 * Keycode to action, for a short press and for a hold of at least [DriveControls.LONG_MS]. Serialised as
 * `87=SELECT_NEXT;88=SELECT_PREV;L87=TOGGLE_RECORD` (an `L` prefix marks the hold); that text is what the
 * Diagnostics editor shows and SharedPreferences stores.
 */
class KeyMapping(shortMap: Map<Int, DriveAction>, longMap: Map<Int, DriveAction>) {
    private val short = shortMap.toSortedMap()
    private val long = longMap.toSortedMap()

    fun short(code: Int): DriveAction? = short[code]
    fun long(code: Int): DriveAction? = long[code]
    val shortEntries: Map<Int, DriveAction> get() = short
    val longEntries: Map<Int, DriveAction> get() = long

    /** Replaces every binding of [action] (of that press kind) with [code]; the learn flow. */
    fun bind(code: Int, action: DriveAction, hold: Boolean = false): KeyMapping {
        val s = short.toMutableMap()
        val l = long.toMutableMap()
        val target = if (hold) l else s
        target.entries.removeAll { it.value == action }
        target[code] = action
        return KeyMapping(s, l)
    }

    fun unbind(code: Int, hold: Boolean = false): KeyMapping {
        val s = short.toMutableMap()
        val l = long.toMutableMap()
        (if (hold) l else s).remove(code)
        return KeyMapping(s, l)
    }

    fun serialize(): String =
        (short.map { "${Keys.name(it.key)}=${it.value.name}" } + long.map { "L${Keys.name(it.key)}=${it.value.name}" }).joinToString(";")

    override fun equals(other: Any?) = other is KeyMapping && other.short == short && other.long == long
    override fun hashCode() = short.hashCode() * 31 + long.hashCode()

    data class Parsed(val mapping: KeyMapping, val errors: List<String>)

    companion object {
        val DEFAULT: KeyMapping = KeyMapping(
            mapOf(
                // Left wheel < > (Honda STEERING_TRACK_UP/DOWN) and anything that behaves like a d-pad or rotary.
                Keys.MEDIA_NEXT to DriveAction.SELECT_NEXT,
                Keys.MEDIA_PREVIOUS to DriveAction.SELECT_PREV,
                Keys.DPAD_RIGHT to DriveAction.SELECT_NEXT,
                Keys.DPAD_LEFT to DriveAction.SELECT_PREV,
                Keys.NAVIGATE_NEXT to DriveAction.SELECT_NEXT,
                Keys.NAVIGATE_PREVIOUS to DriveAction.SELECT_PREV,
                // Record toggles: play/pause family, headset hook, enter/centre, Honda source key (F7), seek-hold.
                Keys.MEDIA_PLAY_PAUSE to DriveAction.TOGGLE_RECORD,
                Keys.MEDIA_PLAY to DriveAction.TOGGLE_RECORD,
                Keys.MEDIA_PAUSE to DriveAction.TOGGLE_RECORD,
                Keys.HEADSETHOOK to DriveAction.TOGGLE_RECORD,
                Keys.MEDIA_RECORD to DriveAction.TOGGLE_RECORD,
                Keys.F7 to DriveAction.TOGGLE_RECORD,
                Keys.DPAD_CENTER to DriveAction.TOGGLE_RECORD,
                Keys.ENTER to DriveAction.TOGGLE_RECORD,
                Keys.NUMPAD_ENTER to DriveAction.TOGGLE_RECORD,
                Keys.MEDIA_FAST_FORWARD to DriveAction.TOGGLE_RECORD,
                // Stop is only swallowed while a note is being recorded.
                Keys.MEDIA_STOP to DriveAction.CANCEL,
                Keys.ESCAPE to DriveAction.CANCEL,
            ),
            mapOf(
                // The < > rocker is the only Android-visible wheel control on the Civic: hold > to record.
                Keys.MEDIA_NEXT to DriveAction.TOGGLE_RECORD,
                // Hold play/pause to throw the note away (a deliberate gesture; a tap just toggles).
                Keys.MEDIA_PLAY_PAUSE to DriveAction.CANCEL,
                Keys.HEADSETHOOK to DriveAction.CANCEL,
            ),
        )

        /** Lenient: bad entries are reported and skipped; a blank text yields [DEFAULT]. */
        fun parse(text: String?): Parsed {
            if (text.isNullOrBlank()) return Parsed(DEFAULT, emptyList())
            val s = mutableMapOf<Int, DriveAction>()
            val l = mutableMapOf<Int, DriveAction>()
            val errors = mutableListOf<String>()
            for (raw in text.split(';', '\n', ',')) {
                val entry = raw.trim()
                if (entry.isEmpty() || entry.startsWith("#")) continue
                val eq = entry.indexOf('=')
                if (eq < 0) { errors += "no '=' in \"$entry\""; continue }
                var keyText = entry.substring(0, eq).trim()
                val hold = keyText.length > 1 && keyText[0] in "Ll" && Keys.parse(keyText) == null
                if (hold) keyText = keyText.substring(1)
                val code = Keys.parse(keyText)
                val action = DriveAction.entries.firstOrNull { it.name == entry.substring(eq + 1).trim().uppercase() }
                when {
                    code == null -> errors += "unknown key \"$keyText\""
                    action == null -> errors += "unknown action in \"$entry\""
                    code in Keys.PROTECTED -> errors += "${Keys.name(code)} is reserved by the car"
                    else -> (if (hold) l else s)[code] = action
                }
            }
            return Parsed(KeyMapping(s, l), errors)
        }

        fun fromStored(text: String?): KeyMapping = parse(text).mapping
    }
}

/** Why a mapped input did not turn into an action. */
enum class Refusal { RECORDING_LOCKED, NOT_RECORDING, DEBOUNCED }

/**
 * Outcome of feeding one input in. [consumed] tells the activity to swallow the event (both its DOWN and its
 * UP, so a radio never hears half a press); [action] is what to do; [refusal] explains a swallowed input that
 * did nothing.
 */
data class DriveResult(val consumed: Boolean, val action: DriveAction? = null, val refusal: Refusal? = null) {
    companion object {
        val PASS = DriveResult(false)
        val SWALLOW = DriveResult(true)
    }
}

/**
 * The pure state machine behind the steering-wheel control: mapping, press/hold, debounce, the recording
 * lock and the parked/driving distinction. Time is injected (milliseconds, any monotonic clock).
 *
 * The web page owns the real selection and recording state; this class only mirrors the part it needs to
 * decide what to swallow (recording / arming), fed by [onPadEvent].
 */
class DriveControls(var mapping: KeyMapping = KeyMapping.DEFAULT) {
    /** Pad is in the foreground on the Agent Pad tab with wheel control switched on. */
    var active = false

    /** Mirrors the page: a note is being captured. */
    var recording = false
        private set
    private var armingUntil = 0L

    private class Press(val downAt: Long) {
        var done = false
    }

    private val pressed = HashMap<Int, Press>()
    private var lastSelectAt = NEVER
    private var lastToggleAt = NEVER
    private var lastScrollAt = NEVER
    private var scrollAcc = 0f

    /** True from "toggle record" until the page reports the recorder is live (or gave up). */
    fun arming(now: Long): Boolean = now < armingUntil
    fun locked(now: Long): Boolean = recording || arming(now)

    fun onPadEvent(type: String) {
        when (type) {
            "recording" -> { recording = true; armingUntil = 0L }
            "stopped", "cancelled", "failed", "refused", "silent" -> { recording = false; armingUntil = 0L }
        }
    }

    fun reset() {
        pressed.clear()
        recording = false
        armingUntil = 0L
        scrollAcc = 0f
    }

    fun onKeyDown(code: Int, repeat: Int, now: Long): DriveResult {
        if (!active || code in Keys.PROTECTED) return DriveResult.PASS
        val short = mapping.short(code)
        val long = mapping.long(code)
        if (short == null && long == null) return DriveResult.PASS
        if (repeat > 0) {
            val p = pressed[code] ?: return DriveResult.PASS // a repeat of a key we never took: not ours
            if (long != null && !p.done && now - p.downAt >= LONG_MS) {
                p.done = true
                return fire(long, now)
            }
            return DriveResult.SWALLOW
        }
        // Stop-type keys belong to the radio unless a note is actually being recorded.
        if (long == null && short == DriveAction.CANCEL && !recording) return DriveResult.PASS
        val p = Press(now)
        pressed[code] = p
        if (long != null) return DriveResult.SWALLOW // short vs hold is decided on release
        p.done = true
        return fire(short!!, now)
    }

    fun onKeyUp(code: Int, now: Long): DriveResult {
        val p = pressed.remove(code) ?: return DriveResult.PASS
        if (p.done) return DriveResult.SWALLOW
        val long = mapping.long(code)
        // No repeat ever arrived, so only arrival time says "held". That clock includes head-unit lag (a tap whose UP
        // showed up 700 ms late was read as a hold and toggled the mic), so a release-only hold needs a long margin;
        // a real hold produces repeat events and fires from onKeyDown at LONG_MS.
        val action = if (long != null && now - p.downAt >= LONG_UP_ONLY_MS) long else mapping.short(code)
        return if (action == null) DriveResult.SWALLOW else fire(action, now)
    }

    /** A complete press delivered without key events (a MediaSession transport callback). */
    fun onCommand(code: Int, now: Long): DriveResult {
        val down = onKeyDown(code, 0, now)
        val up = onKeyUp(code, now)
        return if (down.action != null || down.refusal != null) down else up
    }

    /** Rotary or scroll-wheel detents; positive is clockwise = next agent. */
    fun onScroll(delta: Float, now: Long): DriveResult {
        if (!active || delta == 0f) return DriveResult.PASS
        scrollAcc += delta
        if (scrollAcc > -SCROLL_STEP && scrollAcc < SCROLL_STEP) return DriveResult.SWALLOW
        val action = if (scrollAcc > 0) DriveAction.SELECT_NEXT else DriveAction.SELECT_PREV
        scrollAcc = 0f
        if (now - lastScrollAt < SCROLL_DEBOUNCE_MS) return DriveResult(true, refusal = Refusal.DEBOUNCED)
        lastScrollAt = now
        return fire(action, now)
    }

    private fun fire(action: DriveAction, now: Long): DriveResult = when (action) {
        DriveAction.SELECT_PREV, DriveAction.SELECT_NEXT -> when {
            locked(now) -> DriveResult(true, refusal = Refusal.RECORDING_LOCKED)
            now - lastSelectAt < SELECT_DEBOUNCE_MS -> DriveResult(true, refusal = Refusal.DEBOUNCED)
            else -> { lastSelectAt = now; DriveResult(true, action) }
        }
        DriveAction.TOGGLE_RECORD -> when {
            now - lastToggleAt < TOGGLE_DEBOUNCE_MS -> DriveResult(true, refusal = Refusal.DEBOUNCED)
            arming(now) -> DriveResult(true, refusal = Refusal.DEBOUNCED)
            else -> {
                lastToggleAt = now
                if (!recording) armingUntil = now + ARMING_MAX_MS
                DriveResult(true, action)
            }
        }
        DriveAction.CANCEL -> when {
            !recording -> DriveResult(true, refusal = Refusal.NOT_RECORDING)
            now - lastToggleAt < TOGGLE_DEBOUNCE_MS -> DriveResult(true, refusal = Refusal.DEBOUNCED)
            else -> { lastToggleAt = now; DriveResult(true, action) }
        }
    }

    companion object {
        const val LONG_MS = 600L
        const val LONG_UP_ONLY_MS = 1100L
        const val SELECT_DEBOUNCE_MS = 150L
        const val TOGGLE_DEBOUNCE_MS = 400L
        const val SCROLL_DEBOUNCE_MS = 120L
        const val ARMING_MAX_MS = 5000L
        const val SCROLL_STEP = 1f
        private const val NEVER = Long.MIN_VALUE / 2
    }
}

/** A message from the page about what just happened (selection, recording, send result). */
data class PadEvent(val type: String, val id: String = "", val name: String = "", val reason: String = "")

/** What to say and which tone to play for a [PadEvent]; pure so the wording is tested. */
object DriveSpeech {
    enum class Tone { START, STOP, SENT, ERROR }

    /** Spoken for the event itself. Recording start is announced before the mic opens (see [recordingStart]). */
    fun forEvent(e: PadEvent): String? = when (e.type) {
        "selected" -> e.name.ifBlank { null }
        // The instant ack was said at "stopped"; a send that only went through on a later retry is news of its own.
        "sent" -> if (e.reason == "retry") "Sent to ${e.name}".trim() else null
        "queued" -> "Not sent. Saved, will retry."
        "rejected" -> if (e.name.isBlank()) "Not sent. The agent can't be reached." else "Not sent. ${e.name} can't be reached."
        "silent" -> "Nothing heard, not sent."
        "cancelled" -> "Cancelled."
        // The instant ack (no server): said the moment the note ends, so the driver knows it went.
        "stopped" -> if (e.reason == "auto") "Recording stopped. ${ack(e.name)}" else ack(e.name)
        "failed" -> if (e.reason.startsWith("permission")) "Microphone permission needed. Open Holocene Auto when parked." else "Microphone unavailable."
        "refused" -> when (e.reason) {
            "recording" -> "Recording. Stop first."
            "no_agent" -> "Pick an agent first."
            else -> null
        }
        else -> null
    }

    fun recordingStart(name: String): String = if (name.isBlank()) "Recording." else "Recording for $name."

    fun ack(name: String): String = if (name.isBlank()) "Got it, sending." else "Got it, ${name.trim()}'s on it."

    /** "<Agent> heard: <first ~8 words>", spoken once when the transcript is back; null when there is nothing to say. */
    fun heardEcho(name: String, heard: String, words: Int = 8): String? {
        val w = heard.replace(Regex("""\s+"""), " ").trim().split(' ').filter { it.isNotBlank() }
        if (w.isEmpty()) return null
        val head = w.take(words).joinToString(" ").trimEnd(',', ';', ':', '-')
        val who = name.trim().ifBlank { "Agent" }
        return "$who heard: $head"
    }

    fun toneFor(e: PadEvent): Tone? = when (e.type) {
        // START is played by the host between "Recording for X" and opening the mic, so it is never recorded.
        "stopped" -> Tone.STOP
        "sent" -> Tone.SENT
        "queued", "rejected", "silent", "failed" -> Tone.ERROR
        else -> null
    }

    /** Speak in a car, or when the wheel was just used; stay quiet for plain touch use on a phone. */
    fun shouldSpeak(enabled: Boolean, isCarHost: Boolean, wheelRecently: Boolean): Boolean = enabled && (isCarHost || wheelRecently)
}
