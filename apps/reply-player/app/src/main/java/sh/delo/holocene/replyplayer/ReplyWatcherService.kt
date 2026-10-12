package sh.delo.holocene.replyplayer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.media.MediaPlayer
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Watches the Holocene reply box and plays each new reply exactly once.
 *
 * The box is an S3 prefix listing, polled anonymously. A reply is identified
 * by object key; the newest unplayed key streams through [MediaPlayer] with
 * range requests. While paused, new arrivals are noted but not queued —
 * resuming plays only the newest unplayed file (deterministic, no backlog).
 */
class ReplyWatcherService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var player: MediaPlayer? = null
    private var paused: Boolean = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PAUSE -> { paused = true }
            ACTION_RESUME -> { paused = false }
            ACTION_STOP -> { stopSelf() }
        }
        startForeground(NOTIF_ID, buildNotification())
        scope.launch { pollLoop() }
        return START_STICKY
    }

    private suspend fun pollLoop() {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        var lastPlayed = prefs.getString(KEY_LAST, "") ?: ""
        val http = OkHttpClient.Builder().build()
        while (scope.isActive) {
            try {
                if (!paused) {
                    val newest = newestUnplayed(http, lastPlayed)
                    if (newest != null) {
                        play(newest)
                        lastPlayed = newest.key
                        prefs.edit().putString(KEY_LAST, newest.key).apply()
                    }
                }
            } catch (_: Exception) { /* network blips: next poll */ }
            delay(POLL_MS)
        }
    }

    private data class Entry(val key: String, val url: String)

    private fun newestUnplayed(http: OkHttpClient, lastPlayed: String): Entry? {
        // List the prefix via the S3 anonymous listing endpoint.
        val today = SimpleDateFormat("yyyy/MM/dd", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date())
        val listUrl = "$BUCKET_URL?list-type=2&prefix=replies/$today/&max-keys=20"
        val body = http.newCall(Request.Builder().url(listUrl).get().build())
            .execute().use { it.body?.string() } ?: return null
        val xml = android.util.Xml.newPullParser()
        xml.setInput(body.reader())
        var key: String? = null
        var latest: String? = null
        while (xml.eventType != org.xmlpull.v1.XmlPullParser.END_DOCUMENT) {
            if (xml.eventType == org.xmlpull.v1.XmlPullParser.START_TAG && xml.name == "Key") {
                key = xml.nextText()
                if (key != null && key.endsWith(".ogg") && key > lastPlayed) {
                    if (latest == null || key > latest) latest = key
                }
            }
            xml.next()
        }
        return latest?.let { Entry(it, "$BUCKET_URL/$it") }
    }

    private suspend fun play(entry: Entry) {
        player?.release()
        val mp = MediaPlayer()
        player = mp
        mp.setDataSource(entry.url)
        mp.prepareAsync()
        while (scope.isActive) {
            if (mp.isPlaying) break
            delay(200)
        }
        while (scope.isActive && mp.isPlaying) delay(500)
        mp.release()
        player = null
    }

    private fun buildNotification(): Notification {
        val channelId = "reply_player"
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(channelId, "Reply Player", NotificationManager.IMPORTANCE_LOW)
        )
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, channelId)
            .setContentTitle("Reply Player")
            .setContentText("Watching holocene-auto replies")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(pi)
            .build()
    }

    override fun onDestroy() {
        scope.cancel()
        player?.release()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_PAUSE = "sh.delo.holocene.replyplayer.PAUSE"
        const val ACTION_RESUME = "sh.delo.holocene.replyplayer.RESUME"
        const val ACTION_STOP = "sh.delo.holocene.replyplayer.STOP"
        private const val NOTIF_ID = 42
        private const val PREFS = "reply_player"
        private const val KEY_LAST = "last_played_key"
        private const val POLL_MS = 15_000L
        private const val BUCKET_URL = "https://s3.delo.sh/holocene-auto"
    }
}
