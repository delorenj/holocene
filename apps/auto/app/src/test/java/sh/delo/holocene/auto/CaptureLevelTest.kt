package sh.delo.holocene.auto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptureLevelTest {
    @Test fun fullScaleIsZeroDb() = assertEquals(0.0, CaptureLevel.dbfs(32768), 0.001)

    @Test fun zeroIsTheFloor() = assertEquals(CaptureLevel.FLOOR_DBFS, CaptureLevel.dbfs(0), 0.0)

    @Test fun halfScaleIsAboutMinusSix() = assertEquals(-6.02, CaptureLevel.dbfs(16384), 0.01)

    @Test fun overshootClampsToZeroDb() = assertEquals(0.0, CaptureLevel.dbfs(100000), 0.001)

    @Test fun meterIsEmptyAtAndBelowTheSilenceLine() {
        assertEquals(0.0, CaptureLevel.meter01(0), 0.0)
        assertEquals(0.0, CaptureLevel.meter01(2), 0.0)
        assertTrue(CaptureLevel.meter01(200) > 0.0)
    }

    @Test fun meterIsFullAtFullScale() = assertEquals(1.0, CaptureLevel.meter01(32768), 0.001)

    @Test fun meterIsMonotonic() {
        var last = -1.0
        for (a in listOf(0, 10, 100, 1000, 10000, 32767)) {
            val m = CaptureLevel.meter01(a)
            assertTrue(m >= last)
            last = m
        }
    }

    @Test fun emulatorDitherIsSilent() {
        // The stuck-PulseAudio capture that produced empty_transcript: peak 2 of 32768 = -84 dBFS.
        val s = CaptureStats()
        repeat(60) { s.add(if (it % 2 == 0) 2 else 1) }
        assertTrue(s.silent)
        assertTrue(s.peakDbfs < -80.0)
    }

    @Test fun roomNoiseIsNotSilent() {
        // Host Yeti room noise measured at about -44 dB mean: peaks near 200 of 32768 = -44 dBFS.
        val s = CaptureStats()
        repeat(60) { s.add(150 + it) }
        assertFalse(s.silent)
        assertTrue(s.peakDbfs > -50.0)
    }

    @Test fun oneLoudWindowIsEnoughToNotBeSilent() {
        val s = CaptureStats()
        repeat(59) { s.add(0) }
        s.add(3000)
        assertFalse(s.silent)
    }

    @Test fun emptyStatsAreSilentAndFinite() {
        val s = CaptureStats()
        assertEquals(CaptureLevel.FLOOR_DBFS, s.peakDbfs, 0.0)
        assertEquals(CaptureLevel.FLOOR_DBFS, s.rmsDbfs, 0.0)
        assertTrue(s.silent)
    }

    @Test fun jsonCarriesTheFieldsThePageReads() {
        val s = CaptureStats()
        s.add(16384)
        s.add(16384)
        assertEquals("""{"peak_dbfs":-6.0,"rms_dbfs":-6.0,"samples":2,"source":"native"}""", s.toJson())
    }

    @Test fun thresholdMatchesTheContract() = assertEquals(-60.0, CaptureLevel.SILENCE_DBFS, 0.0)
}
