package sh.delo.holocene.auto

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Native-only transport; production deliberately has no token/endpoint until HOLOC-73. */
class PadDigestClient(private val endpoint: String?, private val secret: String?) {
    fun get(path: String): JSONObject? = try { read(path)?.let { JSONObject(String(it, Charsets.UTF_8)) } } catch (_: Exception) { null }

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
        return try {
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 5000
            conn.readTimeout = if (url.path == "/v1/pad-summary") 30000 else 5000
            conn.setRequestProperty("Authorization", "Bearer $secret")
            conn.setRequestProperty("Cache-Control", "no-store")
            if (conn.responseCode != 200 || conn.contentLength > 3_000_000) return null
            val bytes = conn.inputStream.use { stream ->
                val out = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(8192)
                while (out.size() <= 3_000_000) {
                    val n = stream.read(chunk)
                    if (n < 0) break
                    out.write(chunk, 0, n)
                }
                out.toByteArray()
            }
            if (bytes.size > 3_000_000) return null
            bytes
        } catch (_: Exception) { null } finally { conn.disconnect() }
    }
}
