package sh.delo.holocene.auto

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Native-only transport; production deliberately has no token/endpoint until HOLOC-73. */
class PadDigestClient(private val endpoint: String?, private val secret: String?) {
    fun get(path: String): JSONObject? {
        val deadline = System.nanoTime() + budgetMs(path) * 1_000_000L
        return try {
            val result = read(path)?.let { JSONObject(String(it, Charsets.UTF_8)) }
            if (System.nanoTime() >= deadline) null else result
        } catch (_: Exception) { null }
    }

    private fun budgetMs(path: String): Long = if (path.substringBefore('?') == "/v1/pad-summary") 30000L else 5000L

    /** Byte transport is shared with the real loopback fixture; JSON decoding stays native. */
    internal fun read(path: String): ByteArray? {
        if (endpoint.isNullOrBlank() || secret.isNullOrBlank() || secret.length < 32) return null
        val root = URL(endpoint)
        if (root.protocol != "https" && !(root.protocol == "http" && root.host == "127.0.0.1")) return null
        if (root.userInfo != null || root.query != null || root.ref != null) return null
        val url = URL(root, path)
        if (url.protocol != root.protocol || url.host != root.host || url.port != root.port || url.userInfo != null ||
            url.path !in setOf("/v1/pad-digest", "/v1/pad-summary")) return null
        val conn = url.openConnection() as HttpURLConnection
        val budgetMs = budgetMs(path)
        val deadline = System.nanoTime() + budgetMs * 1_000_000L
        fun remaining(): Int = ((deadline - System.nanoTime()) / 1_000_000L).coerceAtLeast(1L).coerceAtMost(budgetMs).toInt()
        val alarm = java.util.Timer("pad-read-deadline", true)
        alarm.schedule(object : java.util.TimerTask() { override fun run() { conn.disconnect() } }, budgetMs)
        return try {
            conn.instanceFollowRedirects = false
            conn.connectTimeout = remaining()
            conn.readTimeout = remaining()
            conn.setRequestProperty("Authorization", "Bearer $secret")
            conn.setRequestProperty("Cache-Control", "no-store")
            if (conn.responseCode != 200 || conn.contentLength > 3_000_000) return null
            val bytes = conn.inputStream.use { stream ->
                val out = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(8192)
                while (out.size() <= 3_000_000) {
                    if (System.nanoTime() >= deadline) return null
                    conn.readTimeout = remaining()
                    val n = stream.read(chunk)
                    if (System.nanoTime() >= deadline) return null
                    if (n < 0) break
                    out.write(chunk, 0, n)
                }
                out.toByteArray()
            }
            if (bytes.size > 3_000_000 || System.nanoTime() >= deadline) return null
            bytes
        } catch (_: Exception) { null } finally { alarm.cancel(); conn.disconnect() }
    }
}
