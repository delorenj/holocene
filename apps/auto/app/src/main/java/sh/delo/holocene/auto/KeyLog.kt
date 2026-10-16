package sh.delo.holocene.auto

import java.time.Instant

/** One-line, greppable formats for the steering-wheel key inspector (logcat tag HoloceneKeys, file, upload). */
object KeyLog {
    private fun ts(ms: Long) = Instant.ofEpochMilli(ms).toString()

    private fun q(s: String) = "\"" + s.replace("\\", "/").replace("\"", "'").replace('\n', ' ').take(60) + "\""

    fun key(
        timeMs: Long, route: String, action: String, code: Int, name: String, scan: Int, source: Int,
        device: String, repeat: Int, longPress: Boolean, mapped: String?,
    ): String =
        "${ts(timeMs)} key route=$route act=$action code=$code $name scan=$scan src=0x${source.toString(16)} " +
            "dev=${q(device)} rep=$repeat long=$longPress mapped=${mapped ?: "-"}"

    fun scroll(timeMs: Long, route: String, axisScroll: Float, vscroll: Float, hscroll: Float, source: Int, device: String): String =
        "${ts(timeMs)} scroll route=$route axis_scroll=$axisScroll vscroll=$vscroll hscroll=$hscroll " +
            "src=0x${source.toString(16)} dev=${q(device)}"

    fun session(timeMs: Long, callback: String, detail: String = ""): String =
        "${ts(timeMs)} session cb=$callback ${detail.take(80)}".trimEnd()

    fun note(timeMs: Long, text: String): String = "${ts(timeMs)} note ${text.take(120)}"
}

/** Bounded in-memory log with an upload cursor, so "upload" sends only what the server has not seen. */
class KeyLogBuffer(private val max: Int = 200) {
    private val lines = ArrayDeque<String>()
    private var total = 0L
    private var uploaded = 0L

    @Synchronized fun add(line: String) {
        lines.addLast(line)
        total++
        while (lines.size > max) lines.removeFirst()
    }

    @Synchronized fun recent(n: Int): List<String> = lines.toList().takeLast(n)

    /** Lines added since the last [markUploaded], oldest first, with the sequence to pass back on success. */
    @Synchronized fun pending(limit: Int = 120): Pair<List<String>, Long> {
        val unseen = (total - uploaded).toInt().coerceIn(0, lines.size)
        return lines.toList().takeLast(unseen).takeLast(limit) to total
    }

    @Synchronized fun markUploaded(upTo: Long) { if (upTo > uploaded) uploaded = upTo }

    @Synchronized fun hasPending(): Boolean = total > uploaded
}
