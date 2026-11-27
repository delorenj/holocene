package sh.delo.holocene.auto

/** Narrow native protocol. Source thread/evidence and credentials never cross into the page. */
data class PadDigestPayload(
    val agent: String, val status: String, val session: String = "", val version: String = "",
    val sourceAt: String = "", val text: String = "", val audio: ByteArray? = null,
)

/** The production bridge's asynchronous admission boundary, independent of Android for race tests. */
class PadDigestBridge(
    private val fetch: (String) -> PadDigestPayload?,
    private val worker: (() -> Unit) -> Unit,
    private val ui: (() -> Unit) -> Unit,
    private val trusted: (String) -> Boolean,
    private val busy: () -> Boolean,
    private val stop: () -> Unit,
    private val play: (String, ByteArray) -> Boolean,
    private val show: (String, PadDigestPayload?) -> Unit,
    private val phase: (String, String) -> Unit,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val selection = PadDigestSelection()
    private var digest: PadDigestPayload? = null
    private var token = 0L
    private fun fresh(value: PadDigestPayload): Boolean = try {
        val age = now() - java.time.Instant.parse(value.sourceAt).toEpochMilli()
        age in -5000L until 7_200_000L
    } catch (_: Exception) { false }

    fun select(agent: String, nonce: String, refresh: Boolean = false) {
        if (!trusted(nonce) || !agent.matches(Regex("[a-z0-9][a-z0-9-]{0,63}")) || busy()) return
        if (refresh && selection.agent != agent) return
        if (!refresh) { stop(); digest = null }
        token = selection.select(agent)
        val requested = token
        worker {
            val answer = fetch("/v1/pad-digest?agentId=$agent")
            ui {
                if (!trusted(nonce) || !selection.current(agent, null, requested) || busy()) return@ui
                val value = answer?.takeIf { it.agent == agent }
                if (digest?.session != value?.session || digest?.version != value?.version) stop()
                digest = value?.takeIf { it.status == "available" && it.session.matches(Regex("[A-Za-z0-9_.:-]{1,160}")) &&
                    it.version.matches(Regex("[0-9a-f]{64}")) && it.text.isNotBlank() && it.text.length <= 1200 && fresh(it) }
                show(agent, if (value?.status == "available") digest else value)
            }
        }
    }

    fun interrupt() { token = selection.select(selection.agent); stop() }
    fun clear(nonce: String) {
        if (!trusted(nonce)) return
        token = selection.select(null); digest = null; stop()
    }

    fun summary(agent: String, session: String, version: String, nonce: String) {
        val bound = digest
        if (!trusted(nonce) || busy() || bound?.agent != agent || bound.session != session || bound.version != version || !fresh(bound)) return
        token = selection.select(agent)
        val requested = token
        stop()
        phase(agent, "loading")
        worker {
            val q = "agentId=$agent&sourceSessionId=${java.net.URLEncoder.encode(session, "UTF-8")}&digestId=$version"
            val answer = fetch("/v1/pad-summary?$q")
            ui {
                if (!trusted(nonce) || !selection.current(agent, null, requested) || busy() || digest !== bound || !fresh(bound)) return@ui
                val bytes = answer?.takeIf { it.status == "available" && it.agent == agent && it.session == session && it.version == version }?.audio
                val started = bytes != null && bytes.isNotEmpty() && bytes.size <= 2 * 1024 * 1024 && play("summary:$requested", bytes)
                phase(agent, if (started) "playing" else "unavailable")
            }
        }
    }
}
