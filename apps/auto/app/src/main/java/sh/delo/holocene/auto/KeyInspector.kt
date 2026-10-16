package sh.delo.holocene.auto

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** Persisted steering-wheel settings (SharedPreferences "drive"). Defaults: wheel control on, speech on. */
class DriveSettings(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("drive", Context.MODE_PRIVATE)

    var wheelControl: Boolean
        get() = prefs.getBoolean("wheel_control", true)
        set(v) { prefs.edit().putBoolean("wheel_control", v).apply() }

    var spokenFeedback: Boolean
        get() = prefs.getBoolean("spoken_feedback", true)
        set(v) { prefs.edit().putBoolean("spoken_feedback", v).apply() }

    var mapping: KeyMapping
        get() = KeyMapping.fromStored(prefs.getString("mapping", null))
        set(v) { prefs.edit().putString("mapping", v.serialize()).apply() }

    fun resetMapping() { prefs.edit().remove("mapping").apply() }
}

/**
 * Records every key, scroll and media-session callback the activity sees so the real Civic wheel buttons
 * can be identified: logcat tag HoloceneKeys, a capped file in app storage, a live buffer for the
 * Diagnostics screen, and an upload (POST /upload/client-event, event=wheel_keys; no audio) that the
 * upload proxy prints to its log.
 */
class KeyInspector(context: Context) {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val file = File(app.filesDir, "wheel-keys.log")
    val buffer = KeyLogBuffer()

    /** Called on the main thread after every new line. */
    var onChanged: (() -> Unit)? = null

    /** Extra context sent with an upload: mapping text, install source. */
    var meta: () -> Map<String, String> = { emptyMap() }

    private val autoUpload = Runnable { upload(null) }

    private val dedupe = KeyRouteDedupe()

    fun key(e: KeyEvent, route: String, mapped: String?) {
        val lane = if (route.startsWith("session")) "session" else route // session and session-learn are one route
        if (dedupe.duplicate(lane, e.keyCode, e.action, android.os.SystemClock.uptimeMillis())) return
        add(
            KeyLog.key(
                System.currentTimeMillis(), route, if (e.action == KeyEvent.ACTION_DOWN) "DOWN" else if (e.action == KeyEvent.ACTION_UP) "UP" else "ACT${e.action}",
                e.keyCode, KeyEvent.keyCodeToString(e.keyCode), e.scanCode, e.source, deviceName(e.deviceId), e.repeatCount,
                e.isLongPress || (e.flags and KeyEvent.FLAG_LONG_PRESS != 0), mapped,
            ),
        )
    }

    fun scroll(e: MotionEvent, route: String) {
        add(
            KeyLog.scroll(
                System.currentTimeMillis(), route, e.getAxisValue(MotionEvent.AXIS_SCROLL), e.getAxisValue(MotionEvent.AXIS_VSCROLL),
                e.getAxisValue(MotionEvent.AXIS_HSCROLL), e.source, deviceName(e.deviceId),
            ),
        )
    }

    fun session(callback: String, code: Int?) {
        add(KeyLog.session(System.currentTimeMillis(), callback, code?.let { "key=${KeyEvent.keyCodeToString(it)}" } ?: ""))
    }

    fun note(text: String) = add(KeyLog.note(System.currentTimeMillis(), text))

    private fun deviceName(id: Int): String = try { InputDevice.getDevice(id)?.name ?: "device$id" } catch (_: Exception) { "device$id" }

    private fun add(line: String) {
        Log.i(TAG, line)
        buffer.add(line)
        io.execute { append(line) }
        onChanged?.invoke()
    }

    private fun append(line: String) {
        try {
            if (file.length() > MAX_FILE) {
                val keep = file.readLines().takeLast(500)
                file.writeText(keep.joinToString("\n", postfix = "\n"))
            }
            file.appendText(line + "\n")
        } catch (e: Exception) {
            Log.w(TAG, "log file write failed: ${e.javaClass.simpleName}")
        }
    }

    /** Send the new lines 6 s after the last key (Diagnostics open in a parked car: press, then read the server). */
    fun scheduleAutoUpload() {
        main.removeCallbacks(autoUpload)
        main.postDelayed(autoUpload, AUTO_UPLOAD_MS)
    }

    fun cancelAutoUpload() = main.removeCallbacks(autoUpload)

    /** [done] gets a short human result on the main thread. */
    fun upload(done: ((String) -> Unit)?) {
        val (lines, upTo) = buffer.pending()
        if (lines.isEmpty()) { done?.invoke("Nothing new to upload"); return }
        val extra = meta()
        io.execute {
            val result = try {
                val body = JSONObject().apply {
                    put("event", "wheel_keys")
                    put("app", "${app.packageName} ${versionName()}")
                    put("device", "${Build.MANUFACTURER} ${Build.MODEL} sdk${Build.VERSION.SDK_INT}")
                    for ((k, v) in extra) put(k, v)
                    put("lines", JSONArray(lines))
                }.toString()
                val conn = URL(ENDPOINT).openConnection() as HttpURLConnection
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toByteArray()) }
                val code = conn.responseCode
                conn.disconnect()
                if (code in 200..299) { buffer.markUploaded(upTo); "Uploaded ${lines.size} lines" } else "Upload failed: HTTP $code"
            } catch (e: Exception) {
                "Upload failed: ${e.javaClass.simpleName}"
            }
            Log.i(TAG, result)
            main.post { done?.invoke(result) }
        }
    }

    @Suppress("DEPRECATION")
    private fun versionName(): String = try { app.packageManager.getPackageInfo(app.packageName, 0).versionName ?: "?" } catch (_: Exception) { "?" }

    fun shutdown() {
        main.removeCallbacks(autoUpload)
        io.shutdown()
    }

    companion object {
        const val TAG = "HoloceneKeys"
        const val ENDPOINT = "https://agent-pad.delo.sh/upload/client-event"
        private const val MAX_FILE = 200_000L
        private const val AUTO_UPLOAD_MS = 6000L
    }
}
