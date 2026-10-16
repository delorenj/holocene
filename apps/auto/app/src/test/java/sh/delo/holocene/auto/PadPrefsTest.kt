package sh.delo.holocene.auto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PadPrefsTest {
    private class MemStore : PadPrefs.Store {
        val m = HashMap<String, String>()
        override fun get(key: String) = m[key]
        override fun put(key: String, value: String) { m[key] = value }
    }

    private val key = "agentpad.lastDoneReply"

    @Test fun roundTripsTheReplyMarker() {
        val s = MemStore()
        val p = PadPrefs(s)
        assertEquals("", p.get(key))
        assertTrue(p.set(key, "replies/2026/10/16/204554Z-holocene-pm-de7e0540.ogg"))
        // a new PadPrefs over the same store is the next process: the marker is still there
        assertEquals("replies/2026/10/16/204554Z-holocene-pm-de7e0540.ogg", PadPrefs(s).get(key))
    }

    @Test fun otherKeysAreRefusedBothWays() {
        val s = MemStore()
        val p = PadPrefs(s)
        assertFalse(p.set("anything.else", "x"))
        assertTrue(s.m.isEmpty())
        s.m["anything.else"] = "secret"
        assertEquals("", p.get("anything.else"))
    }

    @Test fun oversizedValuesAreRefused() {
        val s = MemStore()
        val p = PadPrefs(s)
        assertFalse(p.set(key, "x".repeat(PadPrefs.MAX_VALUE + 1)))
        assertTrue(p.set(key, "x".repeat(PadPrefs.MAX_VALUE)))
    }
}
