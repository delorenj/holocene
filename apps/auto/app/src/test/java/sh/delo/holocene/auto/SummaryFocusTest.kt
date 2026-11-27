package sh.delo.holocene.auto

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Test

class SummaryFocusTest {
    @Test fun summaryStopsOnCallWhileRepliesKeepTheirExistingPausePolicy() {
        assertEquals(ReplyFocus.Act.STOP, ReplyFocus.onChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, false, true))
        assertEquals(ReplyFocus.Act.PAUSE, ReplyFocus.onChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, false))
        assertEquals(ReplyFocus.Act.NONE, ReplyFocus.onChange(AudioManager.AUDIOFOCUS_GAIN, false, true))
    }
}
