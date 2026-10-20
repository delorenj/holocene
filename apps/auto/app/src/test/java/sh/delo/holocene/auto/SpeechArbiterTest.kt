package sh.delo.holocene.auto

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class SpeechArbiterTest {
    private var t = 0L
    private val played = ArrayList<String>()
    private val halted = ArrayList<Pair<String, String>>()
    private val decisions = ArrayList<SpeechDecision>()
    private lateinit var a: SpeechArbiter

    /** What is audible at any moment: at most one id, and never while the mic is armed or open (except the prompt). */
    private var audible: String? = null

    @Before fun setUp() {
        a = SpeechArbiter({ t }, object : SpeechArbiter.Output {
            override fun play(u: Utterance) {
                assertNull("overlap: ${u.id} started while $audible plays", audible)
                if (u.kind != SpeechKind.ARMING) assertEquals("spoke while the mic was busy", SpeechArbiter.Mic.IDLE, a.mic)
                audible = u.id
                played += u.id
            }
            override fun halt(u: Utterance, reason: String) {
                assertEquals(u.id, audible)
                audible = null
                halted += u.id to reason
            }
            override fun decision(d: SpeechDecision) { decisions += d }
        })
    }

    private fun end(id: String) {
        assertEquals(id, audible)
        audible = null
        a.finished(id)
    }

    private val memo1 = "11111111-1111-5111-8111-111111111111"
    private val memo2 = "22222222-2222-5222-8222-222222222222"

    private fun say(text: String) = listOf(SpeechPart.Say(text))
    private fun clip() = listOf(SpeechPart.Clip(ByteArray(4), "ogg"))
    private fun ack(id: String = "ack") = Utterance(id, SpeechKind.ACK, say("Got it"), maxWaitMs = SpeechArbiter.ACK_WAIT_MS)
    private fun reply(memo: String, id: String = "replies/2026/10/20/120000Z-holocene-pm-$memo.ogg") =
        Utterance(id, SpeechKind.REPLY, clip(), memoId = SpeechArbiter.memoOfReply(id))
    private fun progress(memo: String, seq: Int) =
        Utterance("progress:$memo:$seq", SpeechKind.PROGRESS, clip(), memoId = memo, seq = seq, maxWaitMs = SpeechArbiter.PROGRESS_WAIT_MS)
    private fun echo(memo: String) = Utterance("echo:$memo", SpeechKind.ECHO, say("Holocene heard: hi"), memoId = memo, maxWaitMs = SpeechArbiter.ECHO_WAIT_MS)
    private fun dropped(id: String) = decisions.filter { it.id == id && it.action == "drop" }.map { it.reason }

    @Test fun anIdleQueueSpeaksAtOnce() {
        assertTrue(a.offer(ack()))
        assertEquals(listOf("ack"), played)
    }

    @Test fun replyArrivesDuringAck_waitsForTheAckThenPlays() {
        a.offer(ack())
        val r = reply(memo1)
        a.offer(r)
        assertEquals(listOf("ack"), played) // not cut, not mixed
        end("ack")
        assertEquals(listOf("ack", r.id), played)
    }

    @Test fun recordingStartsWhileReplyPlays_replyStopsAndNothingPlaysUntilTheMicCloses() {
        val r = reply(memo1)
        a.offer(r)
        var ready = false
        a.arm(Utterance("arm", SpeechKind.ARMING, say("Recording for Holocene.")), { ready = true })
        assertEquals(r.id to "recording", halted.single())
        assertEquals("arm", audible)
        assertFalse(ready) // the mic does not open over the prompt
        end("arm")
        assertTrue(ready)
        a.recordingStarted()
        a.offer(progress(memo2, 1))
        a.offer(echo(memo2))
        a.offer(ack())
        assertNull(audible)
        assertEquals(listOf(r.id, "arm"), played)
        a.recordingEnded()
        assertEquals("echo:$memo2", audible) // highest priority deferred item first
    }

    @Test fun armingWithoutPromptOpensAtOnceButStillHoldsTheQueue() {
        var ready = false
        a.arm(null) { ready = true }
        assertTrue(ready)
        a.offer(ack())
        assertNull(audible)
        a.recordingStarted()
        a.recordingEnded()
        assertEquals("ack", audible)
    }

    @Test fun progressArrivesDuringReply_otherMemoWaitsSameMemoIsDropped() {
        val r = reply(memo1)
        a.offer(r)
        a.offer(progress(memo1, 3))
        a.offer(progress(memo2, 1))
        assertEquals(listOf("after_reply"), dropped("progress:$memo1:3"))
        assertEquals(r.id, audible) // the reply is never cut by progress
        end(r.id)
        assertEquals("progress:$memo2:1", audible)
    }

    @Test fun replyCutsAPlayingProgressClipForItsOwnMemo() {
        a.offer(progress(memo1, 1))
        val r = reply(memo1)
        a.offer(r)
        assertEquals("progress:$memo1:1" to "after_reply", halted.single())
        assertEquals(r.id, audible)
    }

    @Test fun replyDoesNotCutAnotherMemosProgressOrAnAck() {
        a.offer(progress(memo2, 1))
        val r = reply(memo1)
        a.offer(r)
        assertTrue(halted.isEmpty())
        end("progress:$memo2:1")
        assertEquals(r.id, audible)
    }

    @Test fun twoProgressClipsRace_newestWins() {
        a.offer(ack()) // keep the queue busy so both progress clips wait
        a.offer(progress(memo1, 2))
        a.offer(progress(memo1, 3))
        assertEquals(listOf("superseded"), dropped("progress:$memo1:2"))
        a.offer(progress(memo1, 1)) // an older one arriving late
        assertEquals(listOf("stale"), dropped("progress:$memo1:1"))
        end("ack")
        assertEquals("progress:$memo1:3", audible)
        end("progress:$memo1:3")
        assertNull(audible)
    }

    @Test fun progressAfterTheMemoIsFinalIsNeverSpoken() {
        a.memoFinal(memo1)
        assertFalse(a.offer(progress(memo1, 5)))
        assertFalse(a.offer(echo(memo1)))
        assertTrue(played.isEmpty())
    }

    @Test fun priorityOrderIsReplyEchoProgressAck() {
        a.recordingStarted()
        a.offer(ack())
        a.offer(progress(memo2, 1))
        a.offer(echo(memo2))
        val r = reply(memo1)
        a.offer(r)
        a.recordingEnded()
        end(r.id)
        end("echo:$memo2")
        end("progress:$memo2:1")
        end("ack")
        assertEquals(listOf(r.id, "echo:$memo2", "progress:$memo2:1", "ack"), played)
    }

    @Test fun anAckThatCouldNotBeSaidInTimeIsDropped() {
        a.offer(reply(memo1))
        a.offer(ack())
        t += SpeechArbiter.ACK_WAIT_MS + 1
        end(played.single())
        assertEquals(listOf("expired"), dropped("ack"))
        assertNull(audible)
    }

    @Test fun echoIsSaidOncePerMemo() {
        a.offer(echo(memo1))
        end("echo:$memo1")
        assertFalse(a.offer(echo(memo1)))
        assertEquals(1, played.size)
    }

    @Test fun aCutEchoOrProgressComesBackAfterTheNote() {
        a.offer(echo(memo1))
        a.arm(null) {}
        a.recordingStarted()
        assertNull(audible)
        a.recordingEnded()
        assertEquals("echo:$memo1", audible)
        assertEquals(listOf("echo:$memo1", "echo:$memo1"), played)
    }

    @Test fun aNonDeferrableCueIsDroppedWhileRecording() {
        a.recordingStarted()
        assertFalse(a.offer(Utterance("stop-first", SpeechKind.CUE, say("Recording. Stop first."), deferrable = false)))
        a.recordingEnded()
        assertNull(audible)
        assertEquals(listOf("recording"), dropped("stop-first"))
    }

    @Test fun aNewerSelectionReplacesAQueuedOne() {
        a.offer(reply(memo1))
        a.offer(Utterance("sel1", SpeechKind.CUE, say("Grolf"), group = "select"))
        a.offer(Utterance("sel2", SpeechKind.CUE, say("Holocene"), group = "select"))
        assertEquals(listOf("superseded"), dropped("sel1"))
        end(played.single())
        assertEquals("sel2", audible)
    }

    @Test fun staleFinishedCallbacksAreIgnored() {
        val r = reply(memo1)
        a.offer(r)
        a.arm(null) {}
        a.finished(r.id) // the player's late "ended" for the reply that was cut
        assertEquals("ignored", decisions.last().action)
        a.recordingStarted()
        a.recordingEnded()
        assertNull(audible)
    }

    @Test fun pageStoppingItsReplyHaltsOrUnqueuesIt() {
        a.offer(ack())
        val r = reply(memo1)
        a.offer(r)
        a.cancel(r.id)
        assertEquals(listOf("stopped"), dropped(r.id))
        end("ack")
        assertNull(audible)
        a.offer(r)
        a.cancel(r.id)
        assertEquals(r.id to "stopped", halted.single())
    }

    @Test fun interruptedArmingReleasesTheQueueWithoutOpeningTheMic() {
        var ready = false
        a.arm(Utterance("arm", SpeechKind.ARMING, say("Recording.")), { ready = true })
        a.offer(ack())
        a.recordingEnded() // backgrounded mid-announcement
        assertEquals("arm" to "disarmed", halted.single())
        assertFalse(ready)
        assertEquals("ack", audible)
    }

    @Test fun resetSilencesEverything() {
        a.offer(reply(memo1))
        a.offer(ack())
        a.reset()
        assertNull(audible)
        assertTrue(a.queued.isEmpty())
    }

    @Test fun replyKeysNameTheirMemo() {
        assertEquals(memo1, SpeechArbiter.memoOfReply("replies/2026/10/20/120000Z-holocene-pm-$memo1.ogg"))
        assertNull(SpeechArbiter.memoOfReply("replies/2026/10/20/x.ogg"))
        assertTrue(SpeechArbiter.validMemoId(memo1))
        assertFalse(SpeechArbiter.validMemoId("../x"))
    }

    @Test fun everyDecisionIsReported() {
        a.offer(ack())
        end("ack")
        assertEquals(listOf("queued", "start", "end"), decisions.map { it.action })
    }
}
