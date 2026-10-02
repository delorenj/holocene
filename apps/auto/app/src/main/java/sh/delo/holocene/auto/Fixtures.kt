package sh.delo.holocene.auto

data class AgentFixture(
    val employee: String,
    val runtime: String,
    val nativeSession: String,
    val logicalThread: String?,
    val state: String,
    val observedAt: String,
    val writable: Boolean = false,
)

data class EventFixture(val id: String, val kind: String, val source: String, val summary: String)

object Fixtures {
    val agents = listOf(
        AgentFixture("fixture-pm", "hermes:fixture-runtime", "fixture-native-1", "fixture-thread-1", "working", "2026-10-02T00:00:00Z"),
        AgentFixture("unknown employee", "opencode:fixture-runtime", "fixture-native-2", null, "unknown / stale coverage", "2026-10-01T00:00:00Z"),
    )
    val events = listOf(
        EventFixture("fixture-1", "lifecycle", "fixture:hermes", "Processing completed; answer unavailable"),
        EventFixture("fixture-2", "tool", "fixture:opencode", "Read completed; no attention inferred"),
        EventFixture("fixture-3", "message", "fixture:hermes", "Canned message, not an agent reply"),
        EventFixture("fixture-4", "future-kind", "fixture:unknown", "Unrecognized event preserved as unknown"),
    )

    fun normalized(events: List<EventFixture>): List<String> = events.distinctBy { it.id }.takeLast(12).map {
        val kind = if (it.kind in setOf("lifecycle", "tool", "message")) it.kind else "unknown (${it.kind.take(40)})"
        "FIXTURE · $kind · ${it.source.take(60)}\n${it.summary.take(180)}"
    }
}

class VoicePreview {
    var destination: String? = null
        private set
    var preview: String? = null
        private set
    var state = "Unsent / fixture only"
        private set

    fun select(route: String) {
        cancel()
        destination = route
    }

    fun finalTranscript(text: String): Boolean {
        if (destination == null || text.isBlank() || text.length > 240) return false
        preview = "FIXTURE preview to $destination: $text"
        state = "Confirmation not implemented; publication disabled"
        return true
    }

    fun cancel() {
        preview = null
        state = "Cancelled / nothing published"
    }

    fun invalidateRoute() {
        cancel()
        destination = null
    }
}
