package sh.delo.holocene.auto

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class DriveControlsTest {
    private lateinit var c: DriveControls

    @Before fun setUp() {
        c = DriveControls().also { it.active = true }
    }

    private fun tap(code: Int, t: Long): DriveResult {
        val down = c.onKeyDown(code, 0, t)
        val up = c.onKeyUp(code, t + 40)
        // The action may come on DOWN (immediate) or on UP (hold-aware key); both ends must be swallowed together.
        assertEquals("down/up consumption must agree for $code", down.consumed, up.consumed)
        return if (down.action != null || down.refusal != null) down else up
    }

    @Test fun defaultWheelRockerSelectsAgents() {
        assertEquals(DriveAction.SELECT_NEXT, tap(Keys.MEDIA_NEXT, 1000).action)
        assertEquals(DriveAction.SELECT_PREV, tap(Keys.MEDIA_PREVIOUS, 2000).action)
        assertEquals(DriveAction.SELECT_NEXT, tap(Keys.DPAD_RIGHT, 3000).action)
        assertEquals(DriveAction.SELECT_PREV, tap(Keys.NAVIGATE_PREVIOUS, 4000).action)
    }

    @Test fun playPauseFamilyTogglesRecord() {
        var t = 1000L
        for (k in listOf(Keys.MEDIA_PLAY_PAUSE, Keys.HEADSETHOOK, Keys.DPAD_CENTER, Keys.ENTER, Keys.F7, Keys.MEDIA_RECORD)) {
            c.reset()
            assertEquals(Keys.name(k), DriveAction.TOGGLE_RECORD, tap(k, t).action)
            t += 2000
        }
    }

    @Test fun unmappedProtectedAndInactiveKeysPass() {
        assertFalse(c.onKeyDown(Keys.BACK, 0, 0).consumed)
        assertFalse(c.onKeyDown(Keys.VOLUME_UP, 0, 0).consumed)
        assertFalse(c.onKeyDown(Keys.VOICE_ASSIST, 0, 0).consumed)
        assertFalse(c.onKeyDown(30, 0, 0).consumed) // 'A'
        assertFalse(c.onKeyUp(30, 10).consumed)
        c.active = false
        assertFalse(c.onKeyDown(Keys.MEDIA_NEXT, 0, 1000).consumed)
        assertFalse(c.onKeyUp(Keys.MEDIA_NEXT, 1040).consumed)
    }

    @Test fun protectedKeysCannotBeMappedEvenWhenStored() {
        val parsed = KeyMapping.parse("VOLUME_UP=TOGGLE_RECORD;24=CANCEL;MEDIA_NEXT=SELECT_NEXT")
        assertEquals(2, parsed.errors.size)
        c.mapping = KeyMapping(mapOf(Keys.VOLUME_UP to DriveAction.TOGGLE_RECORD), emptyMap())
        assertFalse(c.onKeyDown(Keys.VOLUME_UP, 0, 0).consumed)
    }

    @Test fun keyRepeatsAreSwallowedWithoutRepeatingTheAction() {
        assertEquals(DriveAction.SELECT_NEXT, c.onKeyDown(Keys.DPAD_RIGHT, 0, 1000).action)
        for (i in 1..5) {
            val r = c.onKeyDown(Keys.DPAD_RIGHT, i, 1000L + i * 50)
            assertTrue(r.consumed)
            assertNull(r.action)
        }
        assertTrue(c.onKeyUp(Keys.DPAD_RIGHT, 1400).consumed)
    }

    @Test fun repeatOfAKeyWeNeverTookIsNotOurs() {
        assertFalse(c.onKeyDown(Keys.DPAD_RIGHT, 3, 1000).consumed)
    }

    @Test fun holdingNextRecordsAndTappingNextSelects() {
        // short tap: action arrives on release
        assertTrue(c.onKeyDown(Keys.MEDIA_NEXT, 0, 1000).consumed)
        assertEquals(DriveAction.SELECT_NEXT, c.onKeyUp(Keys.MEDIA_NEXT, 1200).action)
        // hold: action arrives on release after LONG_MS
        assertNull(c.onKeyDown(Keys.MEDIA_NEXT, 0, 5000).action)
        assertEquals(DriveAction.TOGGLE_RECORD, c.onKeyUp(Keys.MEDIA_NEXT, 5000 + DriveControls.LONG_MS).action)
    }

    @Test fun holdFiresOnceWhileRepeatsArrive() {
        c.onKeyDown(Keys.MEDIA_NEXT, 0, 1000)
        assertNull(c.onKeyDown(Keys.MEDIA_NEXT, 1, 1300).action)
        assertEquals(DriveAction.TOGGLE_RECORD, c.onKeyDown(Keys.MEDIA_NEXT, 2, 1000 + DriveControls.LONG_MS + 10).action)
        assertNull(c.onKeyDown(Keys.MEDIA_NEXT, 3, 2000).action)
        val up = c.onKeyUp(Keys.MEDIA_NEXT, 2100)
        assertTrue(up.consumed)
        assertNull(up.action)
    }

    @Test fun longPlayPauseCancelsOnlyWhileRecording() {
        // not recording: a hold is swallowed quietly
        c.onKeyDown(Keys.MEDIA_PLAY_PAUSE, 0, 1000)
        val idle = c.onKeyUp(Keys.MEDIA_PLAY_PAUSE, 2000)
        assertEquals(Refusal.NOT_RECORDING, idle.refusal)
        // recording: the same hold cancels
        c.onPadEvent("recording")
        c.onKeyDown(Keys.MEDIA_PLAY_PAUSE, 0, 5000)
        assertEquals(DriveAction.CANCEL, c.onKeyUp(Keys.MEDIA_PLAY_PAUSE, 6000).action)
    }

    @Test fun stopKeyBelongsToTheRadioUnlessRecording() {
        val idle = c.onKeyDown(Keys.MEDIA_STOP, 0, 1000)
        assertFalse(idle.consumed)
        assertFalse(c.onKeyUp(Keys.MEDIA_STOP, 1040).consumed)
        c.onPadEvent("recording")
        val live = c.onKeyDown(Keys.MEDIA_STOP, 0, 3000)
        assertEquals(DriveAction.CANCEL, live.action)
        assertTrue(c.onKeyUp(Keys.MEDIA_STOP, 3040).consumed)
    }

    @Test fun selectionIsDebouncedButNotLostForever() {
        assertEquals(DriveAction.SELECT_NEXT, tap(Keys.MEDIA_NEXT, 1000).let { c.onKeyDown(Keys.DPAD_RIGHT, 0, 2000) }.action)
        c.onKeyUp(Keys.DPAD_RIGHT, 2010)
        val bounce = c.onKeyDown(Keys.DPAD_RIGHT, 0, 2060)
        assertEquals(Refusal.DEBOUNCED, bounce.refusal)
        assertTrue(bounce.consumed)
        c.onKeyUp(Keys.DPAD_RIGHT, 2070)
        assertEquals(DriveAction.SELECT_NEXT, c.onKeyDown(Keys.DPAD_RIGHT, 0, 2000L + DriveControls.SELECT_DEBOUNCE_MS + 5).action)
    }

    @Test fun toggleBounceDoesNotDoubleToggle() {
        assertEquals(DriveAction.TOGGLE_RECORD, c.onKeyDown(Keys.DPAD_CENTER, 0, 1000).action)
        c.onKeyUp(Keys.DPAD_CENTER, 1030)
        c.onPadEvent("recording")
        assertEquals(Refusal.DEBOUNCED, c.onKeyDown(Keys.DPAD_CENTER, 0, 1200).refusal)
        c.onKeyUp(Keys.DPAD_CENTER, 1230)
        assertEquals(DriveAction.TOGGLE_RECORD, c.onKeyDown(Keys.DPAD_CENTER, 0, 1000L + DriveControls.TOGGLE_DEBOUNCE_MS + 10).action)
    }

    @Test fun switchingAgentWhileRecordingIsRefused() {
        c.onPadEvent("recording")
        assertTrue(c.locked(0))
        val r = c.onKeyDown(Keys.MEDIA_PREVIOUS.let { Keys.DPAD_LEFT }, 0, 1000)
        assertTrue(r.consumed)
        assertEquals(Refusal.RECORDING_LOCKED, r.refusal)
        assertNull(r.action)
        c.onKeyUp(Keys.DPAD_LEFT, 1040)
        c.onPadEvent("stopped")
        assertEquals(DriveAction.SELECT_PREV, c.onKeyDown(Keys.DPAD_LEFT, 0, 2000).action)
    }

    @Test fun selectionIsLockedWhileTheMicIsArming() {
        assertEquals(DriveAction.TOGGLE_RECORD, c.onKeyDown(Keys.DPAD_CENTER, 0, 1000).action)
        c.onKeyUp(Keys.DPAD_CENTER, 1020)
        assertTrue(c.arming(1500))
        assertEquals(Refusal.RECORDING_LOCKED, c.onKeyDown(Keys.DPAD_RIGHT, 0, 1500).refusal)
        c.onKeyUp(Keys.DPAD_RIGHT, 1520)
        // a second toggle while arming does not stack a second start
        assertEquals(Refusal.DEBOUNCED, c.onKeyDown(Keys.DPAD_CENTER, 0, 2000).refusal)
        c.onKeyUp(Keys.DPAD_CENTER, 2020)
        // the page never answered: arming expires instead of locking the pad forever
        assertFalse(c.arming(1000L + DriveControls.ARMING_MAX_MS + 1))
        assertEquals(DriveAction.SELECT_NEXT, c.onKeyDown(Keys.DPAD_RIGHT, 0, 7000).action)
    }

    @Test fun pageRefusalOrFailureReleasesTheArmingLock() {
        c.onKeyDown(Keys.DPAD_CENTER, 0, 1000)
        c.onKeyUp(Keys.DPAD_CENTER, 1020)
        c.onPadEvent("refused")
        assertFalse(c.arming(1100))
        c.onKeyDown(Keys.DPAD_CENTER, 0, 1500)
        c.onKeyUp(Keys.DPAD_CENTER, 1520)
        c.onPadEvent("failed")
        assertFalse(c.locked(1600))
    }

    @Test fun cancelIsRefusedQuietlyWhenIdle() {
        c.mapping = c.mapping.bind(Keys.DPAD_LEFT, DriveAction.CANCEL)
        c.onKeyDown(Keys.DPAD_LEFT, 0, 1000).let {
            // mapped as a plain short CANCEL, idle: left to the system
            assertFalse(it.consumed)
        }
    }

    @Test fun rotaryDetentsAccumulateAndDebounce() {
        assertEquals(DriveAction.SELECT_NEXT, c.onScroll(1f, 1000).action)
        assertEquals(Refusal.DEBOUNCED, c.onScroll(-1f, 1050).refusal)
        assertEquals(DriveAction.SELECT_PREV, c.onScroll(-1f, 1300).action)
        // fractional ticks add up to one step
        assertNull(c.onScroll(0.4f, 2000).action)
        assertNull(c.onScroll(0.4f, 2300).action)
        assertEquals(DriveAction.SELECT_NEXT, c.onScroll(0.4f, 2600).action)
        assertFalse(c.onScroll(0f, 3000).consumed)
        c.active = false
        assertFalse(c.onScroll(1f, 4000).consumed)
    }

    @Test fun rotaryIsLockedWhileRecordingToo() {
        c.onPadEvent("recording")
        assertEquals(Refusal.RECORDING_LOCKED, c.onScroll(1f, 1000).refusal)
    }

    @Test fun mediaSessionCommandCountsAsAFullPress() {
        assertEquals(DriveAction.SELECT_NEXT, c.onCommand(Keys.MEDIA_NEXT, 1000).action)
        assertEquals(DriveAction.TOGGLE_RECORD, c.onCommand(Keys.MEDIA_PLAY_PAUSE, 2000).action)
        assertFalse(c.onCommand(Keys.VOLUME_UP, 3000).consumed)
    }

    @Test fun resetForgetsHeldKeysAndRecording() {
        c.onPadEvent("recording")
        c.onKeyDown(Keys.MEDIA_NEXT, 0, 1000)
        c.reset()
        assertFalse(c.recording)
        assertFalse(c.onKeyUp(Keys.MEDIA_NEXT, 1100).consumed)
    }

    @Test fun customMappingIsHonoured() {
        c.mapping = KeyMapping.parse("F7=SELECT_NEXT;LF7=CANCEL").mapping
        // F7 is not a known name here: falls back to the number
        c.mapping = KeyMapping.parse("137=SELECT_NEXT").mapping
        assertEquals(DriveAction.SELECT_NEXT, c.onKeyDown(137, 0, 1000).action)
        assertFalse(c.onKeyDown(Keys.MEDIA_NEXT, 0, 3000).consumed)
    }
}

class KeyMappingTest {
    @Test fun defaultsRoundTripThroughText() {
        val text = KeyMapping.DEFAULT.serialize()
        assertEquals(KeyMapping.DEFAULT, KeyMapping.parse(text).mapping)
        assertTrue(text, text.contains("L" + "MEDIA_NEXT=TOGGLE_RECORD"))
    }

    @Test fun blankOrNullMeansDefaults() {
        assertEquals(KeyMapping.DEFAULT, KeyMapping.parse(null).mapping)
        assertEquals(KeyMapping.DEFAULT, KeyMapping.parse("  \n ").mapping)
    }

    @Test fun parsingAcceptsNamesNumbersAndSeparators() {
        val m = KeyMapping.parse("KEYCODE_MEDIA_NEXT=select_next\n88=SELECT_PREV,L85=cancel").mapping
        assertEquals(DriveAction.SELECT_NEXT, m.short(87))
        assertEquals(DriveAction.SELECT_PREV, m.short(88))
        assertEquals(DriveAction.CANCEL, m.long(85))
    }

    @Test fun badEntriesAreReportedAndSkipped() {
        val p = KeyMapping.parse("nope;MEDIA_NEXT=FLY;WIBBLE=CANCEL;HOME=CANCEL;87=SELECT_NEXT")
        assertEquals(DriveAction.SELECT_NEXT, p.mapping.short(87))
        assertEquals(4, p.errors.size)
        assertNull(p.mapping.short(Keys.HOME))
    }

    @Test fun bindingMovesAnActionToANewKey() {
        val m = KeyMapping.DEFAULT.bind(Keys.F7, DriveAction.SELECT_NEXT)
        assertEquals(DriveAction.SELECT_NEXT, m.short(Keys.F7))
        assertNull(m.short(Keys.MEDIA_NEXT)) // the old binding of that action is replaced
        assertEquals(DriveAction.TOGGLE_RECORD, m.long(Keys.MEDIA_NEXT)) // holds are untouched
        assertNull(m.unbind(Keys.F7).short(Keys.F7))
    }
}

class DriveSpeechTest {
    @Test fun wordingIsShortAndNamesTheAgent() {
        assertEquals("Holocene", DriveSpeech.forEvent(PadEvent("selected", "holocene-pm", "Holocene")))
        assertEquals("Recording for Holocene.", DriveSpeech.recordingStart("Holocene"))
        assertEquals("Recording.", DriveSpeech.recordingStart(""))
        assertEquals("Sent to Holocene", DriveSpeech.forEvent(PadEvent("sent", name = "Holocene")))
        assertEquals("Nothing heard, not sent.", DriveSpeech.forEvent(PadEvent("silent")))
        assertEquals("Recording. Stop first.", DriveSpeech.forEvent(PadEvent("refused", reason = "recording")))
        assertNull(DriveSpeech.forEvent(PadEvent("recording")))
        assertNull(DriveSpeech.forEvent(PadEvent("stopped")))
    }

    @Test fun tonesMarkStopAndOutcome() {
        assertEquals(DriveSpeech.Tone.STOP, DriveSpeech.toneFor(PadEvent("stopped")))
        assertEquals(DriveSpeech.Tone.SENT, DriveSpeech.toneFor(PadEvent("sent")))
        assertEquals(DriveSpeech.Tone.ERROR, DriveSpeech.toneFor(PadEvent("silent")))
        assertNull(DriveSpeech.toneFor(PadEvent("selected")))
        assertNull(DriveSpeech.toneFor(PadEvent("recording"))) // played by the host before the mic opens
    }

    @Test fun speaksInTheCarOrAfterWheelUseOnly() {
        assertTrue(DriveSpeech.shouldSpeak(true, isCarHost = true, wheelRecently = false))
        assertTrue(DriveSpeech.shouldSpeak(true, isCarHost = false, wheelRecently = true))
        assertFalse(DriveSpeech.shouldSpeak(true, isCarHost = false, wheelRecently = false))
        assertFalse(DriveSpeech.shouldSpeak(false, isCarHost = true, wheelRecently = true))
    }
}

class HostUxTest {
    @Test fun parkedIsOnlyTheEmptyMask() {
        assertTrue(HostUx.PARKED.unrestricted)
        assertFalse(HostUx(requiresDo = true, mask = 0).unrestricted)
        assertFalse(HostUx(requiresDo = false, mask = HostUx.NO_VIDEO).unrestricted)
        assertFalse(HostUx.UNKNOWN.unrestricted)
    }

    @Test fun drivingFlagsAreDecoded() {
        val ux = HostUx(true, HostUx.FULLY_RESTRICTED, maxStringLength = 120, maxItems = 6, maxDepth = 3)
        assertTrue(ux.noVideo && ux.noText && ux.noKeyboard && ux.noSetup && ux.limitContent)
        assertEquals(120, ux.maxLabel)
        val slow = HostUx(true, HostUx.NO_VIDEO)
        assertTrue(slow.noVideo)
        assertFalse(slow.noText)
        assertEquals(0, slow.maxLabel)
    }

    @Test fun carHostsFailClosedToTheDrivingLayoutButPhonesNeverDo() {
        assertEquals(PadMode.PARKED, PadModes.of(false, HostUx.UNKNOWN))
        assertEquals(PadMode.PARKED, PadModes.of(true, HostUx.PARKED))
        assertEquals(PadMode.DRIVING, PadModes.of(true, HostUx.UNKNOWN))
        assertEquals(PadMode.DRIVING, PadModes.of(true, HostUx(true, HostUx.NO_VIDEO)))
    }

    @Test fun diagnosticsStayParkedOnly() {
        assertTrue(PadModes.diagnosticsAllowed(PadMode.PARKED))
        assertFalse(PadModes.diagnosticsAllowed(PadMode.DRIVING))
    }
}

class KeyLogTest {
    @Test fun keyLineIsGreppable() {
        val line = KeyLog.key(0L, "activity", "DOWN", 87, "KEYCODE_MEDIA_NEXT", 163, 0x101, "Honda \"wheel\" pad", 0, false, "SELECT_NEXT")
        assertEquals(
            "1970-01-01T00:00:00Z key route=activity act=DOWN code=87 KEYCODE_MEDIA_NEXT scan=163 src=0x101 dev=\"Honda 'wheel' pad\" rep=0 long=false mapped=SELECT_NEXT",
            line,
        )
        assertTrue(KeyLog.key(0, "r", "UP", 1, "K", 0, 0, "d", 0, true, null).endsWith("mapped=-"))
    }

    @Test fun scrollAndSessionLines() {
        assertTrue(KeyLog.scroll(0, "activity", 1f, 0f, 0f, 0x10000000, "knob").contains("axis_scroll=1.0"))
        assertEquals("1970-01-01T00:00:00Z session cb=onSkipToNext key=KEYCODE_MEDIA_NEXT", KeyLog.session(0, "onSkipToNext", "key=KEYCODE_MEDIA_NEXT"))
    }

    @Test fun bufferKeepsTheTailAndTracksWhatWasUploaded() {
        val b = KeyLogBuffer(max = 3)
        for (i in 1..5) b.add("l$i")
        assertEquals(listOf("l3", "l4", "l5"), b.recent(10))
        val (first, upTo) = b.pending()
        assertEquals(listOf("l3", "l4", "l5"), first)
        b.markUploaded(upTo)
        assertFalse(b.hasPending())
        b.add("l6")
        assertEquals(listOf("l6"), b.pending().first)
        assertTrue(b.hasPending())
    }
}

class EarconsTest {
    @Test fun everyToneHasSoundAndStaysBounded() {
        for (t in DriveSpeech.Tone.entries) {
            val pcm = Earcons.pcm(t)
            assertTrue("$t", pcm.any { it.toInt() != 0 })
            assertTrue("$t", Earcons.durationMs(pcm) in 100..700)
            assertEquals(0, pcm.first().toInt()) // faded in: no click
        }
    }
}
