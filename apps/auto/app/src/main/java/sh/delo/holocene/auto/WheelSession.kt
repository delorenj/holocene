package sh.delo.holocene.auto

import android.content.Context
import android.content.Intent
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent

/**
 * Optional MediaSession owned only while Agent Pad is in the foreground on a car host.
 *
 * Why it exists: on the Honda image the steering-wheel media keys may be routed to the active
 * media-button session instead of the focused window. Owning the session is the only way a third-party
 * app can receive them there. The price: while this app is in front, Next/Previous/Play-Pause go to
 * Agent Pad instead of the radio or Spotify. [release] hands them back the moment the app is backgrounded.
 * It never plays audio and is never published as a media source.
 */
class WheelSession(
    context: Context,
    private val onKey: (code: Int, action: Int, repeat: Int, event: KeyEvent) -> Boolean,
    private val onCallback: (name: String, code: Int?) -> Unit,
) {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private var session: MediaSession? = null

    val held: Boolean get() = session != null

    fun acquire() {
        if (session != null) return
        val s = MediaSession(app, "HoloceneWheel")
        s.setCallback(object : MediaSession.Callback() {
            @Suppress("DEPRECATION")
            override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                val ev = mediaButtonIntent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return false
                return onKey(ev.keyCode, ev.action, ev.repeatCount, ev)
            }
            override fun onPlay() = onCallback("onPlay", KeyEvent.KEYCODE_MEDIA_PLAY)
            override fun onPause() = onCallback("onPause", KeyEvent.KEYCODE_MEDIA_PAUSE)
            override fun onSkipToNext() = onCallback("onSkipToNext", KeyEvent.KEYCODE_MEDIA_NEXT)
            override fun onSkipToPrevious() = onCallback("onSkipToPrevious", KeyEvent.KEYCODE_MEDIA_PREVIOUS)
            override fun onFastForward() = onCallback("onFastForward", KeyEvent.KEYCODE_MEDIA_FAST_FORWARD)
            override fun onRewind() = onCallback("onRewind", KeyEvent.KEYCODE_MEDIA_REWIND)
            override fun onStop() = onCallback("onStop", KeyEvent.KEYCODE_MEDIA_STOP)
        }, main)
        val actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_STOP or
            PlaybackState.ACTION_FAST_FORWARD or PlaybackState.ACTION_REWIND
        // A session becomes the media-button target when it goes "playing"; settle on paused straight away
        // so the car UI does not show a phantom player.
        s.setPlaybackState(PlaybackState.Builder().setActions(actions).setState(PlaybackState.STATE_PLAYING, 0L, 1f).build())
        s.isActive = true
        main.postDelayed({
            if (session === s) s.setPlaybackState(PlaybackState.Builder().setActions(actions).setState(PlaybackState.STATE_PAUSED, 0L, 0f).build())
        }, 150)
        session = s
    }

    fun release() {
        val s = session ?: return
        session = null
        main.removeCallbacksAndMessages(null)
        try {
            s.isActive = false
            s.release()
        } catch (_: RuntimeException) {
            // already gone
        }
    }
}
