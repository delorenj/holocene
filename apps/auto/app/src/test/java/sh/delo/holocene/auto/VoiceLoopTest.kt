package sh.delo.holocene.auto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

import sh.delo.holocene.auto.LoopPhase.AWAITING_ANSWER
import sh.delo.holocene.auto.LoopPhase.DISPATCHING
import sh.delo.holocene.auto.LoopPhase.PLAYING
import sh.delo.holocene.auto.LoopPhase.RECORDING
import sh.delo.holocene.auto.LoopPhase.TRANSCRIBING
import sh.delo.holocene.auto.LoopPhase.UPLOADING

/**
 * Pure-JVM regressions for the HOLOC-14 voice loop helpers: transcript
 * cleanup, item_id, dispatch envelope, answer filtering, state machine.
 */
class VoiceLoopTest {

    // ---- transcript cleanup ----

    @Test
    fun cleanTranscript_stripsMarkdownHeader() {
        val raw = "# Transcription: holocene-auto-1.m4a\n\nWhat is the status of HOLOC-12?\n"
        assertEquals("What is the status of HOLOC-12?", VoiceLoopContract.cleanTranscript(raw))
    }

    @Test
    fun cleanTranscript_plainTextPassesThrough() {
        assertEquals("Summarize recent work", VoiceLoopContract.cleanTranscript("Summarize recent work"))
    }

    @Test
    fun cleanTranscript_headerOnlyFallsBackToEmpty() {
        // All-header input: fallback also removes headers -> empty -> callers abort.
        assertEquals("", VoiceLoopContract.cleanTranscript("# Transcription: x.m4a\n"))
    }

    @Test
    fun cleanTranscript_fallbackKeepsNonHeaderTail() {
        // Leading blank + header + blank, body present -> body.
        val raw = "\n# Title\n\nline one\nline two\n"
        assertEquals("line one\nline two", VoiceLoopContract.cleanTranscript(raw))
    }

    @Test
    fun transcriptFromEvent_extractsCleanedUtterance() {
        val event = """{"data":{"item_id":"abc","transcript_text":"# Transcription: f.m4a\n\nTurn on the garage lights"}}"""
        assertEquals("Turn on the garage lights", VoiceLoopContract.transcriptFromEvent(event))
    }

    @Test
    fun transcriptFromEvent_nullWhenNoText() {
        assertNull(VoiceLoopContract.transcriptFromEvent("""{"data":{"item_id":"abc"}}"""))
    }

    @Test
    fun transcriptFromEvent_nullWhenEmptyAfterCleanup() {
        val event = """{"data":{"transcript_text":"# only a header"}}"""
        assertNull(VoiceLoopContract.transcriptFromEvent(event))
    }

    // ---- item_id ----

    @Test
    fun itemId_first16HexOfSha256() {
        // sha256("test") = 9f86d081884c7d65... (verified via sha256sum)
        assertEquals("9f86d081884c7d65", VoiceLoopContract.itemId("test".toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun itemId_emptyBytes() {
        // sha256("") = e3b0c44298fc1c14...
        assertEquals("e3b0c44298fc1c14", VoiceLoopContract.itemId(ByteArray(0)))
    }

    @Test
    fun itemId_always16HexChars() {
        val id = VoiceLoopContract.itemId(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10))
        assertEquals(16, id.length)
        assertTrue(id.all { it in "0123456789abcdef" })
    }

    // ---- filename ----

    @Test
    fun fileName_convention() {
        assertEquals("holocene-auto-1760000000000-Grolf.m4a", VoiceLoopContract.fileName(1760000000000L, "Grolf"))
    }

    // ---- dispatch envelope ----

    @Test
    fun dispatchEnvelope_hasAllRequiredFields() {
        val json = VoiceLoopContract.buildDispatchEnvelope(
            agentName = "Grolf",
            transcript = "What is HOLOC-12 status?",
            threadId = "holocene-auto-1760000000000",
            commandId = "11111111-1111-1111-1111-111111111111",
            correlationId = "22222222-2222-2222-2222-222222222222",
            idempotencyKey = "33333333-3333-3333-3333-333333333333",
            nowIso8601 = "2026-10-11T12:00:00Z",
        )
        // Envelope must parse as valid JSON.
        val parsed = JsonParser(json).parseDocument() as Map<*, *>
        assertEquals("1.0", parsed["specversion"])
        assertEquals("11111111-1111-1111-1111-111111111111", parsed["id"])
        assertEquals("urn:33god:cli:holocene-auto", parsed["source"])
        assertEquals("bloodbank.agent.invocation.start", parsed["type"])
        assertEquals("bloodbank.cmd.agent.invocation.start", parsed["subject"])
        assertEquals("2026-10-11T12:00:00Z", parsed["time"])
        assertEquals("application/json", parsed["datacontenttype"])
        assertEquals("command", parsed["kind"])
        assertEquals("agent", parsed["domain"])
        assertEquals("apicurio://holyfields/bloodbank.agent.invocation.start/versions/1", parsed["dataschema"])
        assertEquals("bloodbank.agent.invocation.start.v1", parsed["schemaref"])
        assertEquals("single_consumer", parsed["delivery"])
        assertEquals("thread:holocene-auto-1760000000000", parsed["ordering_key"])
        assertEquals("11111111-1111-1111-1111-111111111111", parsed["command_id"])
        val actor = parsed["actor"] as Map<*, *>
        assertEquals("agent_cli", actor["type"])
        assertEquals("holocene-auto", actor["agent_id"])
        assertEquals("android", actor["cli"])
        val data = parsed["data"] as Map<*, *>
        assertEquals("33god-pm", data["target_agent_id"]) // Grolf -> 33god-pm
        assertEquals("What is HOLOC-12 status?", data["prompt"])
        assertEquals("holocene-auto-1760000000000", data["thread_id"])
        assertEquals("11111111-1111-1111-1111-111111111111", data["turn_id"])
        val context = data["context"] as Map<*, *>
        assertEquals("HOLOCENE-AUTO:Agent:Grolf", context["source"])
        assertEquals("holoc-14", context["test"])
    }

    @Test
    fun dispatchEnvelope_correlationEqualsCausation() {
        val json = VoiceLoopContract.buildDispatchEnvelope(
            "Grolf", "prompt", "t-1", "c-1", "corr-1", "idem-1", "2026-01-01T00:00:00Z",
        )
        val parsed = JsonParser(json).parseDocument() as Map<*, *>
        assertEquals(parsed["correlationid"], parsed["causationid"])
        assertEquals("corr-1", parsed["correlationid"])
    }

    @Test
    fun dispatchEnvelope_escapesNewlinesInPrompt() {
        val json = VoiceLoopContract.buildDispatchEnvelope(
            "Grolf", "line one\nline two \"quoted\"", "t", "c", "corr", "idem", "2026-01-01T00:00:00Z",
        )
        val parsed = JsonParser(json).parseDocument() as Map<*, *>
        assertEquals("line one\nline two \"quoted\"", (parsed["data"] as Map<*, *>)["prompt"])
    }

    @Test
    fun dispatchEnvelope_unknownAgentFallsBackToDefaultProfile() {
        val json = VoiceLoopContract.buildDispatchEnvelope(
            "Momo", "prompt", "t", "c", "corr", "idem", "2026-01-01T00:00:00Z",
        )
        val parsed = JsonParser(json).parseDocument() as Map<*, *>
        assertEquals("33god-pm", (parsed["data"] as Map<*, *>)["target_agent_id"])
    }

    @Test(expected = IllegalArgumentException::class)
    fun dispatchEnvelope_blankPromptThrows() {
        VoiceLoopContract.buildDispatchEnvelope("Grolf", "   ", "t", "c", "corr", "idem", "2026-01-01T00:00:00Z")
    }

    // ---- answer filtering ----

    @Test
    fun answerFilter_threadMatch() {
        val event = """{"data":{"thread_id":"holocene-auto-1","final_answer":true,"role":"assistant","reply":{"audio":{"url":"http://s3/x.ogg","mime":"audio/ogg","sha256":"aa","bytes":10,"duration_s":2.5}}}}"""
        assertTrue(VoiceLoopContract.matchesAnswerEvent(event, "holocene-auto-1"))
        assertEquals("http://s3/x.ogg", VoiceLoopContract.answerAudioUrl(event))
    }

    @Test
    fun answerFilter_threadMismatch() {
        val event = """{"data":{"thread_id":"holocene-auto-2","final_answer":true}}"""
        assertFalse(VoiceLoopContract.matchesAnswerEvent(event, "holocene-auto-1"))
    }

    @Test
    fun answerFilter_nonFinalIgnored() {
        val event = """{"data":{"thread_id":"holocene-auto-1","final_answer":false,"role":"assistant"}}"""
        assertFalse(VoiceLoopContract.matchesAnswerEvent(event, "holocene-auto-1"))
    }

    @Test
    fun answerFilter_dottedReplyAudioKey() {
        // Flat envelope shape with literal "reply.audio" object key.
        val event = """{"data":{"thread_id":"t","final_answer":true,"reply.audio":{"url":"http://s3/y.ogg"}}}"""
        assertTrue(VoiceLoopContract.matchesAnswerEvent(event, "t"))
        assertEquals("http://s3/y.ogg", VoiceLoopContract.answerAudioUrl(event))
    }

    @Test
    fun answerFilter_missingAudioIsNull() {
        val event = """{"data":{"thread_id":"t","final_answer":true}}"""
        assertTrue(VoiceLoopContract.matchesAnswerEvent(event, "t"))
        assertNull(VoiceLoopContract.answerAudioUrl(event))
    }

    // ---- state machine ----

    @Test
    fun stateMachine_happyPath() {
        val loop = VoiceLoop("Grolf", now = { 1760000000000L })
        assertEquals(LoopPhase.IDLE, loop.phase)
        assertTrue(loop.begin())
        assertEquals(LoopPhase.RECORDING, loop.phase)
        assertEquals("holocene-auto-1760000000000", loop.threadId)
        loop.transition(LoopPhase.UPLOADING)
        loop.awaitItem("9f86d081884c7d65")
        loop.transition(LoopPhase.TRANSCRIBING)
        loop.transition(LoopPhase.DISPATCHING)
        loop.transition(LoopPhase.AWAITING_ANSWER)
        loop.transition(LoopPhase.PLAYING)
        loop.complete()
        assertEquals(LoopPhase.DONE, loop.phase)
        assertFalse(loop.active)
    }

    @Test
    fun stateMachine_beginTwiceRefused() {
        val loop = VoiceLoop("Grolf")
        assertTrue(loop.begin())
        assertFalse(loop.begin())
        assertEquals(1, loop.attempt)
    }

    @Test
    fun stateMachine_failFromAnyRunningPhase() {
        for (phase in listOf(RECORDING, UPLOADING, TRANSCRIBING, DISPATCHING, AWAITING_ANSWER, PLAYING)) {
            val loop = VoiceLoop("Grolf")
            loop.begin()
            phaseUpTo(loop, phase)
            loop.fail("boom")
            assertEquals(LoopPhase.FAILED, loop.phase)
            assertEquals("boom", loop.lastError?.reason)
            assertEquals(phase, loop.lastError?.phase)
            assertFalse(loop.active)
        }
    }

    @Test
    fun stateMachine_cancelFromAnyRunningPhase() {
        for (phase in listOf(RECORDING, UPLOADING, TRANSCRIBING, DISPATCHING, AWAITING_ANSWER, PLAYING)) {
            val loop = VoiceLoop("Grolf")
            loop.begin()
            phaseUpTo(loop, phase)
            loop.cancel()
            assertEquals(LoopPhase.CANCELLED, loop.phase)
            assertFalse(loop.active)
        }
    }

    @Test
    fun stateMachine_illegalTransitionThrows() {
        val loop = VoiceLoop("Grolf")
        loop.begin() // RECORDING
        try {
            loop.transition(LoopPhase.PLAYING)
            org.junit.Assert.fail("expected IllegalArgumentException")
        } catch (expected: IllegalArgumentException) {
            assertEquals(LoopPhase.RECORDING, loop.phase) // unchanged
        }
    }

    @Test
    fun stateMachine_restartAfterTerminal() {
        val loop = VoiceLoop("Grolf", now = { 1760000000000L })
        loop.begin()
        loop.cancel()
        assertTrue(loop.begin())
        assertEquals(2, loop.attempt)
        assertEquals(LoopPhase.RECORDING, loop.phase)
    }

    @Test
    fun stateMachine_failOnTerminalIsNoop() {
        val loop = VoiceLoop("Grolf")
        loop.begin()
        loop.cancel()
        loop.fail("late") // ignored
        assertEquals(LoopPhase.CANCELLED, loop.phase)
        assertNull(loop.lastError)
    }

    @Test
    fun statusText_coversTerminalStates() {
        val loop = VoiceLoop("Grolf")
        loop.begin()
        loop.fail("intake unreachable")
        assertEquals("Loop failed: intake unreachable", loop.statusText())
        val loop2 = VoiceLoop("Grolf")
        loop2.begin()
        loop2.cancel()
        assertEquals("Loop cancelled", loop2.statusText())
    }

    @Test
    fun profileMapping() {
        assertEquals("33god-pm", VoiceLoopContract.profileFor("Grolf"))
        assertEquals("33god-pm", VoiceLoopContract.profileFor("Momo"))
        assertEquals("33god-pm", VoiceLoopContract.profileFor("unknown"))
    }

    private fun phaseUpTo(loop: VoiceLoop, target: LoopPhase) {
        val order = listOf(RECORDING, UPLOADING, TRANSCRIBING, DISPATCHING, AWAITING_ANSWER, PLAYING)
        var current = order.indexOf(target)
        check(current >= 0)
        for (i in 0 until current) loop.transition(order[i + 1])
    }
}
