package sh.delo.holocene.auto

import org.junit.Assert.*
import org.junit.Test

class FixturesTest {
    @Test fun duplicatesAreRemoved() {
        assertEquals(4, Fixtures.normalized(Fixtures.events + Fixtures.events).size)
    }
    @Test fun unknownEventsRemainVisible() {
        assertTrue(Fixtures.normalized(Fixtures.events).last().contains("unknown (future-kind)"))
    }
    @Test fun timelinesAreBounded() {
        val events = (1..40).map { EventFixture("$it", "tool", "fixture", "x".repeat(500)) }
        assertEquals(12, Fixtures.normalized(events).size)
        assertTrue(Fixtures.normalized(events).all { it.length < 230 })
    }
    @Test fun fixturesCannotBeWritable() {
        assertTrue(Fixtures.agents.all { !it.writable })
        assertEquals(2, Fixtures.agents.map { it.runtime.substringBefore(':') }.distinct().size)
    }
    @Test fun processingDoesNotImplyAnswer() {
        assertTrue(Fixtures.normalized(Fixtures.events).first().contains("answer unavailable"))
    }
    @Test fun noDestinationRejectsTranscript() {
        assertFalse(VoicePreview().finalTranscript("do work"))
    }
    @Test fun previewHasFrozenDestinationAndCannotPublish() {
        val voice = VoicePreview()
        voice.select("fixture-thread-1")
        assertTrue(voice.finalTranscript("status"))
        assertTrue(voice.preview!!.contains("fixture-thread-1"))
        assertTrue(voice.state.contains("publication disabled"))
    }
    @Test fun routeChangeCancelsPreview() {
        val voice = VoicePreview()
        voice.select("first")
        voice.finalTranscript("status")
        voice.select("second")
        assertNull(voice.preview)
        assertEquals("second", voice.destination)
    }
    @Test fun hostRestrictionInvalidatesDestination() {
        val voice = VoicePreview()
        voice.select("fixture")
        voice.finalTranscript("status")
        voice.invalidateRoute()
        assertNull(voice.preview)
        assertNull(voice.destination)
    }
    @Test fun emptyOrOversizedUtterancesAreRejected() {
        val voice = VoicePreview()
        voice.select("fixture")
        assertFalse(voice.finalTranscript(" "))
        assertFalse(voice.finalTranscript("x".repeat(241)))
    }
}
