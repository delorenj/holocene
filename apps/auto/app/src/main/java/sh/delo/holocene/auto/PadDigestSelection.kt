package sh.delo.holocene.auto

/** A private read belongs to the selected agent and the page generation that requested it. */
class PadDigestSelection {
    private var generation = 0L
    var agent: String? = null
        private set
    var session: String? = null
        private set

    fun select(id: String?, sourceSessionId: String? = null): Long {
        agent = id
        session = sourceSessionId
        return ++generation
    }

    fun current(id: String, sourceSessionId: String?, token: Long): Boolean =
        agent == id && session == sourceSessionId && generation == token

    fun interrupt() { generation++ }
}
