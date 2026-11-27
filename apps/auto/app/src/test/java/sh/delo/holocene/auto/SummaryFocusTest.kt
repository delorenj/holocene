package sh.delo.holocene.auto

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SummaryFocusTest {
    @Test fun preparedSummaryChecksDeadlineButRepliesHaveNone() {
        assertTrue(ReplyFocus.fresh(7_200_000, 7_199_000))
        assertFalse(ReplyFocus.fresh(7_200_000, 7_200_000))
        assertFalse(ReplyFocus.fresh(7_200_000, 7_201_000))
        assertTrue(ReplyFocus.fresh(null, Long.MAX_VALUE))
    }
    @Test fun summaryStopsOnCallWhileRepliesKeepTheirExistingPausePolicy() {
        assertEquals(ReplyFocus.Act.STOP, ReplyFocus.onChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, false, true))
        assertEquals(ReplyFocus.Act.PAUSE, ReplyFocus.onChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, false))
        assertEquals(ReplyFocus.Act.NONE, ReplyFocus.onChange(AudioManager.AUDIOFOCUS_GAIN, false, true))
    }
}
