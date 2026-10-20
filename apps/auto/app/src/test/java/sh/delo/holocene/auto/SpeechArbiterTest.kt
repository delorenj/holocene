package sh.delo.holocene.auto

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class SpeechArbiterTest {
    private var t = 0L
    private val played = ArrayList<String>()
    private val halted = ArrayList<Pair<String, String>>()
    private val decisions = ArrayList<SpeechDecision>()
    private val done = ArrayList<Pair<String, String>>()
    private val waits = ArrayList<Int>()
    private val wakes = ArrayList<Long>()
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
                // a chunked reply waiting between two chunks is current but silent
                if (u.chunks == 0 || audible != null) assertEquals(u.id, audible?.substringBefore('#'))
                audible = null
                halted += u.id to reason
            }
            override fun playChunk(u: Utterance, index: Int, clip: SpeechPart.Clip) {
                assertNull("overlap: chunk $index of ${u.id} started while $audible plays", audible)
                assertEquals("spoke while the mic was busy", SpeechArbiter.Mic.IDLE, a.mic)
                assertEquals(u.id, a.current?.id)
                audible = "${u.id}#$index"
                played += "${u.id}#$index"
            }
            override fun streamDone(u: Utterance, reason: String) {
                assertNull("the reply ended while a chunk still plays", audible)
                done += u.id to reason
            }
            override fun waitChunk(u: Utterance, index: Int) { waits += index }
            override fun wakeAfter(ms: Long) { wakes += ms }
            override fun decision(d: SpeechDecision) { decisions += d }
        })
    }

    /** A sound was just cut: nothing may start over its tail; once it drained from the speakers the queue moves on. */
    private fun drain() {
        assertNull("started over the tail of a sound that was just cut", audible)
        assertTrue("the host was not asked to come back after the drain", wakes.isNotEmpty())
        t += SpeechArbiter.HALT_DRAIN_MS
        a.tick()
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
        drain() // the prompt waits for the cut reply to leave the speakers
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

    // The real order on the car: the page stops its reply (stopReply -> cancel) a few ms before it asks to record, so
    // when arm() runs nothing is current, yet the reply's tail is still coming out of the speakers.
    @Test fun recordingAfterThePageStoppedItsReply_promptWaitsForTheReplyToDrain() {
        val r = reply(memo1)
        a.offer(r)
        a.cancel(r.id) // stopReply
        assertEquals(r.id to "stopped", halted.single())
        t += 30 // the page's startFor() lands 16-55 ms later
        var ready = false
        a.arm(Utterance("arm", SpeechKind.ARMING, say("Recording for Holocene.")), { ready = true })
        assertNull("the prompt started over the tail of the reply that was just stopped", audible)
        assertEquals("deferred", decisions.last { it.id == "arm" }.action)
        assertEquals(SpeechArbiter.HALT_DRAIN_MS - 30, wakes.last())
        t += SpeechArbiter.HALT_DRAIN_MS - 31
        a.tick()
        assertNull("the prompt started before the drain was over", audible)
        t += 1
        a.tick()
        assertEquals("arm", audible)
        assertFalse(ready)
        end("arm")
        assertTrue(ready)
    }

    @Test fun recordingLongAfterAReplyWasStopped_promptStartsAtOnce() {
        val r = reply(memo1)
        a.offer(r)
        a.cancel(r.id)
        t += SpeechArbiter.HALT_DRAIN_MS
        a.arm(Utterance("arm", SpeechKind.ARMING, say("Recording for Holocene.")), { })
        assertEquals("arm", audible)
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

    @Test fun aMicWaitsUntilTheSpeakersHaveBeenQuiet() {
        // Nothing ever sounded: no wait.
        assertEquals(0L, a.quietLeftMs(450))
        a.offer(ack())
        assertEquals(450L, a.quietLeftMs(450)) // something is current: all of it
        t += 1_000
        end("ack")
        assertEquals(450L, a.quietLeftMs(450)) // it just ended: its tail is still on its way to the speakers
        t += 300
        assertEquals(150L, a.quietLeftMs(450))
        t += 200
        assertEquals(0L, a.quietLeftMs(450))
    }

    @Test fun aSoundHaltedByArmingCountsAsJustEnded() {
        a.offer(reply(memo1))
        t += 2_000
        var waited = -1L
        a.arm(null) { waited = a.quietLeftMs(450) }
        assertEquals("the halted reply drains in full before a prompt-less mic opens", 450L, waited)
    }

    @Test fun aPromptThatCutsASoundStartsOnlyOnceItDrained() {
        a.offer(echo(memo1))
        var ready = false
        a.arm(Utterance("arm", SpeechKind.ARMING, say("Recording for Holocene.")), { ready = true })
        assertNull(audible)
        assertEquals(listOf(SpeechArbiter.HALT_DRAIN_MS), wakes)
        t += SpeechArbiter.HALT_DRAIN_MS - 1
        a.tick()
        assertNull("the prompt started over the cut echo's tail", audible)
        t += 1
        a.tick()
        assertEquals("arm", audible)
        end("arm")
        assertTrue(ready)
    }

    @Test fun aPromptWithNothingToCutStartsAtOnce() {
        a.arm(Utterance("arm", SpeechKind.ARMING, say("Recording.")), {})
        assertEquals("arm", audible)
        assertTrue(wakes.isEmpty())
    }

    @Test fun aWaitingPromptThatIsDisarmedNeverPlays() {
        a.offer(echo(memo1))
        a.arm(Utterance("arm", SpeechKind.ARMING, say("Recording.")), { fail("the mic opened") })
        a.recordingEnded()
        t += SpeechArbiter.HALT_DRAIN_MS
        a.tick()
        assertFalse(played.contains("arm"))
        assertEquals("echo:$memo1", audible) // the cut echo comes back once the speakers are clear
    }

    @Test fun aSoundThatEndsByItselfNeedsNoDrain() {
        a.offer(ack("a1"))
        a.offer(ack("a2"))
        end("a1")
        assertEquals("a2", audible)
        assertTrue(wakes.isEmpty())
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
        drain()
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

    @Test fun aCueAnswersTheDriverBeforeNarrationButNeverBeforeAReply() {
        a.recordingStarted()
        a.offer(progress(memo2, 1))
        a.offer(Utterance("cancelled", SpeechKind.CUE, say("Cancelled.")))
        a.recordingEnded()
        assertEquals("cancelled", audible)
        end("cancelled")
        val r = reply(memo1)
        a.offer(r)
        end("progress:$memo2:1")
        a.offer(Utterance("sel", SpeechKind.CUE, say("Grolf")))
        assertEquals(r.id, audible) // not cut
        end(r.id)
        assertEquals("sel", audible)
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
        drain()
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
        drain()
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

    // ---- chunked replies: one reply, chunk after chunk, nothing between ----

    private val streamId = "replies/2026/10/20/120000Z-holocene-pm-$memo1.ogg"
    private fun chunk(i: Int, n: Int = 3, id: String = streamId) =
        a.offerChunk(id, SpeechArbiter.memoOfReply(id), i, n, SpeechPart.Clip(ByteArray(4), "opus"))
    private fun endChunk(i: Int, id: String = streamId) {
        assertEquals("$id#$i", audible)
        audible = null
        a.chunkEnded(id, i)
    }

    @Test fun chunksPlayInOrderAsOneReply_andNothingElseIsSaidBetweenThem() {
        assertTrue(chunk(1))
        assertEquals(listOf("$streamId#1"), played)
        a.offer(progress(memo2, 1))
        a.offer(ack())
        a.offer(echo(memo2))
        endChunk(1)
        // chunk 2 is still rendering: the reply holds the queue, silent, and nothing of lower rank slips in
        assertEquals(listOf(2), waits)
        assertNull(audible)
        assertEquals(streamId, a.current?.id)
        assertEquals(listOf("$streamId#1"), played)
        assertTrue(chunk(3)) // early: buffered
        assertTrue(chunk(2)) // the one it waits for: plays at once
        assertEquals("$streamId#2", audible)
        endChunk(2)
        assertEquals("$streamId#3", audible) // already there: straight on
        endChunk(3)
        assertEquals(listOf(streamId to ""), done)
        assertEquals("end", decisions.last { it.id == streamId }.action)
        // only now the rest of the queue: the echo outranks progress; the ack expired meanwhile or follows
        assertEquals("echo:$memo2", played[3])
    }

    @Test fun aRecordingStopsTheWholeChunkedReply_andThePageOffersItAgainFromChunkOne() {
        chunk(1); chunk(2)
        endChunk(1)
        assertEquals("$streamId#2", audible)
        var ready = false
        a.arm(null) { ready = true }
        assertTrue(ready)
        assertEquals(streamId to "recording", halted.single())
        a.recordingStarted()
        a.recordingEnded()
        assertNull(audible) // the reply went back to the page whole; the queue does not resume it mid-way
        assertNull(a.current)
        t += SpeechArbiter.HALT_DRAIN_MS // the cut reply has left the speakers by the time the page offers it again
        played.clear()
        // the page's replay offers it again from the first chunk
        chunk(1); chunk(2); chunk(3)
        assertEquals(listOf("$streamId#1"), played)
        endChunk(1); endChunk(2); endChunk(3)
        assertEquals(listOf("$streamId#1", "$streamId#2", "$streamId#3"), played)
        assertEquals(listOf(streamId to ""), done)
    }

    @Test fun aChunkOfferedWhileRecordingWaitsAndPlaysAfterTheNote() {
        a.arm(null) {}
        a.recordingStarted()
        assertTrue(chunk(1))
        chunk(2)
        assertNull(audible)
        assertEquals("recording", decisions.first { it.id == streamId && it.action == "deferred" }.reason)
        a.recordingEnded()
        assertEquals("$streamId#1", audible)
        endChunk(1)
        assertEquals("$streamId#2", audible)
    }

    @Test fun aChunkThatNeverComesEndsTheReplyAfterTheWait_andTheQueueMovesOn() {
        chunk(1)
        endChunk(1)
        a.offer(echo(memo2))
        t += SpeechArbiter.CHUNK_WAIT_MS - 1
        a.tick()
        assertTrue(done.isEmpty())
        t += 2
        a.tick()
        assertEquals(listOf(streamId to "chunk_timeout"), done)
        drain()
        assertEquals("echo:$memo2", audible)
    }

    @Test fun aChunkedReplyMakesItsMemoFinal() {
        a.offer(progress(memo1, 1))
        chunk(1)
        assertEquals("progress:$memo1:1" to "after_reply", halted.single())
        drain()
        assertEquals("$streamId#1", audible)
        assertFalse(a.offer(progress(memo1, 2)))
        assertFalse(a.offer(echo(memo1)))
    }

    @Test fun badDuplicateAndChangedChunksAreDropped() {
        assertFalse(chunk(0))
        assertFalse(chunk(4, 3))
        assertFalse(chunk(1, 1)) // one chunk is not a stream: a single reply goes through playReply
        assertTrue(chunk(1))
        assertFalse(chunk(1))    // playing already
        assertTrue(chunk(2))
        assertFalse(chunk(2))    // buffered already
        assertFalse(chunk(3, 4)) // a different count for the same reply
        assertEquals(listOf("bad_chunk", "bad_chunk", "bad_chunk", "duplicate_chunk", "duplicate_chunk", "chunk_count_changed"),
            decisions.filter { it.id == streamId && it.action == "drop" }.map { it.reason })
    }

    @Test fun chunksOfferedOutOfOrderStillPlayInOrder() {
        chunk(2)
        assertEquals(listOf(1), waits) // started, waiting for chunk 1
        assertNull(audible)
        chunk(1)
        assertEquals("$streamId#1", audible)
        endChunk(1)
        assertEquals("$streamId#2", audible)
    }

    @Test fun aReplyQueuedBehindAChunkedReplyWaitsForItsLastChunk() {
        chunk(1, 2)
        val r = reply(memo2)
        a.offer(r)
        endChunk(1)
        assertNull(audible) // waiting for chunk 2: the other reply does not jump in
        chunk(2, 2)
        endChunk(2)
        assertEquals(r.id, audible)
    }

    @Test fun aChunkedReplyThatLosesItsAudioFocusFailsWhole_andTheQueueMovesOn() {
        chunk(1); chunk(2)
        a.offer(echo(memo2))
        audible = null // the player stopped itself when the focus went
        a.abandon(streamId, "focus_lost")
        assertEquals(listOf(streamId to "focus_lost"), done)
        drain()
        assertEquals("echo:$memo2", audible)
        a.abandon("not-current", "x") // ignored
        assertEquals(1, done.size)
    }
}
