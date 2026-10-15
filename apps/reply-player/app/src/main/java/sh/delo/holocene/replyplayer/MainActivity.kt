package sh.delo.holocene.replyplayer

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        status = TextView(this).apply { text = "Reply Player idle" }
        val start = Button(this).apply { text = "Start watching" }
        val pause = Button(this).apply { text = "Pause" }
        val layout = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            addView(status); addView(start); addView(pause)
        }
        setContentView(layout)

        start.setOnClickListener {
            ensurePermissions()
            ContextCompat.startForegroundService(
                this, Intent(this, ReplyWatcherService::class.java)
            )
            status.text = "Watching holocene-auto replies…"
        }
        pause.setOnClickListener {
            sendBroadcast(Intent(ReplyWatcherService.ACTION_PAUSE).setPackage(packageName))
            status.text = "Paused (new replies noted, not queued)"
        }
    }

    private fun ensurePermissions() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }
}
