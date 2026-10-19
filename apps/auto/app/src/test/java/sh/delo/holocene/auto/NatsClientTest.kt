package sh.delo.holocene.auto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.BufferedInputStream
import java.io.ByteArrayInputStream

/** Pure-JVM regressions for NATS wire parsing (MSG line forms + payload framing). */
class NatsClientTest {

    @Test
    fun parseMsgLine_threeArgForm() {
        val head = NatsClient.parseMsgLine("MSG bloodbank.evt.audio.transcription.completed 3 251")
        assertEquals("bloodbank.evt.audio.transcription.completed", head?.subject)
        assertEquals(3, head?.sid)
        assertNull(head?.replyTo)
        assertEquals(251, head?.size)
    }

    @Test
    fun parseMsgLine_fourArgFormWithReplyTo() {
        val head = NatsClient.parseMsgLine("MSG bloodbank.cmd.agent.invocation.start 7 _INBOX.abc.1 512")
        assertEquals("bloodbank.cmd.agent.invocation.start", head?.subject)
        assertEquals(7, head?.sid)
        assertEquals("_INBOX.abc.1", head?.replyTo)
        assertEquals(512, head?.size)
    }

    @Test
    fun parseMsgLine_extraSpacesTolerated() {
        val head = NatsClient.parseMsgLine("MSG  subject.one   1   42")
        assertEquals("subject.one", head?.subject)
        assertEquals(1, head?.sid)
        assertNull(head?.replyTo)
        assertEquals(42, head?.size)
    }

    @Test
    fun parseMsgLine_rejectsNonMsg() {
        assertNull(NatsClient.parseMsgLine("PONG"))
        assertNull(NatsClient.parseMsgLine("INFO {\"server_id\":\"x\"}"))
        assertNull(NatsClient.parseMsgLine("+OK"))
    }

    @Test
    fun parseMsgLine_rejectsGarbageArgs() {
        assertNull(NatsClient.parseMsgLine("MSG subject notanumber 42"))
        assertNull(NatsClient.parseMsgLine("MSG subject 1 notanumber"))
        assertNull(NatsClient.parseMsgLine("MSG subject 1")) // too few
        assertNull(NatsClient.parseMsgLine("MSG subject 1 reply 4 extra")) // too many
    }

    @Test
    @Throws(java.io.IOException::class)
    fun readLine_stripsCarriageReturn() {
        val stream = java.io.BufferedInputStream(ByteArrayInputStream("PONG\r\n-ERR 'stale'\r\n".toByteArray(Charsets.UTF_8)))
        val buf = ByteArray(64)
        assertEquals("PONG", NatsClient.readLine(stream, buf))
        assertEquals("-ERR 'stale'", NatsClient.readLine(stream, buf))
        assertNull(NatsClient.readLine(stream, buf)) // EOF
    }

    @Test
    fun readExactly_readsFullPayload() {
        val payload = ByteArray(1000) { (it % 251).toByte() }
        val stream = java.io.BufferedInputStream(ByteArrayInputStream(payload))
        val read = NatsClient.readExactly(stream, payload.size)
        assertEquals(payload.size, read?.size)
        org.junit.Assert.assertArrayEquals(payload, read)
    }

    @Test
    fun readExactly_shortStreamReturnsNull() {
        val stream = java.io.BufferedInputStream(ByteArrayInputStream(ByteArray(10)))
        assertNull(NatsClient.readExactly(stream, 11))
        assertNull(NatsClient.readExactly(stream, -1))
    }
}
