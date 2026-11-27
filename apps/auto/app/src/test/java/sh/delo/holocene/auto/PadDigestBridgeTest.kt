package sh.delo.holocene.auto

import org.junit.Assert.*
import org.junit.Test

class PadDigestBridgeTest {
    private val tasks = ArrayList<() -> Unit>()
    private val shown = ArrayList<PadDigestPayload?>()
    private val phases = ArrayList<String>()
    private val plays = ArrayList<String>()
    private var stops = 0
    private var busy = false
    private var allowed = true
    private val v = "a".repeat(64)
    private var time = java.time.Instant.parse("2026-11-27T12:00:00Z").toEpochMilli()
    private var result = PadDigestPayload("alpha", "available", "s1", v, "2026-11-27T12:00:00Z", "Built it. Checked it.", byteArrayOf(1))
    private val bridge = PadDigestBridge({ result }, { tasks.add(it) }, { it() }, { allowed && it == "nonce" }, { busy },
        { stops++ }, { id, _ -> plays.add(id); true }, { _, d -> shown.add(d) }, { _, p -> phases.add(p) }, now = { time })
    private fun run() { tasks.removeAt(0)() }
    private fun select() { bridge.select("alpha", "nonce"); run() }

    @Test fun originAndIdentityAreCheckedBeforeReadAndBeforeDelivery() {
        bridge.select("alpha", "bad"); bridge.select("../alpha", "nonce")
        assertTrue(tasks.isEmpty())
        bridge.select("alpha", "nonce"); allowed = false; run()
        assertTrue(shown.isEmpty())
        allowed = true; select()
        assertEquals("s1", shown.last()?.session)
        bridge.summary("alpha", "s2", v, "nonce")
        assertTrue(tasks.isEmpty())
        bridge.summary("beta", "s1", v, "nonce")
        assertTrue(tasks.isEmpty())
    }

    @Test fun aBBackAndTwoSessionsCannotDeliverLateDigestOrAudio() {
        bridge.select("alpha", "nonce")
        bridge.select("beta", "nonce")
        run(); assertTrue(shown.isEmpty())
        bridge.clear("nonce"); run(); assertTrue(shown.isEmpty())
        select()
        bridge.summary("alpha", "s1", v, "nonce")
        bridge.interrupt(); run(); assertTrue(plays.isEmpty())
        bridge.summary("alpha", "s1", v, "nonce")
        result = result.copy(session = "s2"); run()
        assertTrue(plays.isEmpty()); assertEquals("unavailable", phases.last())
        bridge.select("alpha", "nonce", true); run()
        bridge.summary("alpha", "s1", v, "nonce")
        assertTrue(tasks.isEmpty())
        bridge.summary("alpha", "s2", v, "nonce"); run()
        assertEquals(1, plays.size)
    }

    @Test fun recordingHostCallAndReplyInterruptionsRejectInflightSummary() {
        for (why in listOf("record", "host", "call", "reply")) {
            select(); bridge.summary("alpha", "s1", v, "nonce")
            bridge.interrupt(); run()
            assertTrue("late audio after $why", plays.isEmpty())
        }
        select(); bridge.summary("alpha", "s1", v, "nonce"); busy = true; run()
        assertTrue(plays.isEmpty())
        assertTrue(stops >= 8)
    }

    @Test fun staleMissingFutureAndExpiredDuringFetchCannotReachPlayback() {
        select(); bridge.summary("alpha", "s1", v, "nonce")
        time += 7_200_000L
        run()
        assertTrue(plays.isEmpty())
        bridge.summary("alpha", "s1", v, "nonce")
        assertTrue(tasks.isEmpty())
        select(); assertNull(shown.last())
        result = result.copy(sourceAt = "")
        select(); assertNull(shown.last())
        result = result.copy(sourceAt = java.time.Instant.ofEpochMilli(time + 6000).toString())
        select(); assertNull(shown.last())
    }

    @Test fun missingMixedOrChangedRefreshNeverSubstitutesAudio() {
        select(); bridge.summary("alpha", "s1", v, "nonce")
        bridge.select("alpha", "nonce", true)
        result = result.copy(agent = "beta")
        run(); run()
        assertNull(shown.last()); assertTrue(plays.isEmpty())
        result = result.copy(agent = "alpha", status = "missing")
        select(); bridge.summary("alpha", "s1", v, "nonce")
        assertTrue(tasks.isEmpty())
    }
}
