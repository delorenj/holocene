package sh.delo.holocene.auto

import java.net.ServerSocket
import java.net.InetAddress
import java.util.Collections
import org.junit.Assert.*
import org.junit.Test

class PadDigestClientTest {
    @Test fun slowDripHeadersAndBodyCannotRenewTheFiveSecondDeadline() {
        for (headers in listOf(false, true)) {
            val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
            val worker = Thread {
                try {
                    server.accept().use { socket ->
                        val input = socket.getInputStream().bufferedReader()
                        while (true) { val line = input.readLine() ?: break; if (line.isEmpty()) break }
                        val out = socket.getOutputStream()
                        out.write((if (headers) "HTTP/1.1 200 OK\r\nX-Fixture: " else
                            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n").toByteArray())
                        out.flush()
                        repeat(14) { out.write(' '.code); out.flush(); Thread.sleep(500) }
                        out.write((if (headers) "\r\n\r\n{}" else "{}").toByteArray()); out.flush()
                    }
                } catch (_: java.io.IOException) {} // the deadline closes the fixture socket
            }
            worker.isDaemon = true
            worker.start()
            try {
                val start = System.nanoTime()
                val client = PadDigestClient("http://127.0.0.1:${server.localPort}", "fixture-" + "x".repeat(40))
                assertNull(client.read("/v1/pad-digest?agentId=alpha"))
                val elapsed = (System.nanoTime() - start) / 1_000_000
                assertTrue("$headers elapsed=$elapsed", elapsed in 4500..6000)
            } finally { server.close(); worker.join(2000) }
        }
    }
    @Test fun realNativeTransportHasBearerBoundsAndDoesNotFollowRedirects() {
        val token = "fixture-only-" + "x".repeat(40)
        val seen = Collections.synchronizedList(ArrayList<Pair<String, String?>>())
        val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
        val worker = Thread {
            try {
                while (!server.isClosed) server.accept().use { socket ->
                    val input = socket.getInputStream().bufferedReader()
                    val path = input.readLine().split(" ")[1]
                    var bearer: String? = null
                    while (true) {
                        val line = input.readLine() ?: break
                        if (line.isEmpty()) break
                        if (line.startsWith("Authorization:", ignoreCase = true)) bearer = line.substringAfter(':').trim()
                    }
                    seen.add(path to bearer)
                    val query = path.substringAfter('?', "")
                    val code = if (bearer != "Bearer $token") 401 else if (query == "redirect") 302 else 200
                    val body = if (query == "oversize") ByteArray(3_000_001) else "{\"status\":\"fixture-only\"}".toByteArray()
                    val location = if (code == 302) "Location: /must-not-follow\r\n" else ""
                    try {
                        socket.getOutputStream().apply {
                            write("HTTP/1.1 $code Fixture\r\n${location}Content-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
                            write(body); flush()
                        }
                    } catch (_: java.io.IOException) {} // size-bound client intentionally closes before body
                }
            } catch (_: java.net.SocketException) { /* closing the fixture */ }
        }
        worker.start()
        try {
            val endpoint = "http://127.0.0.1:${server.localPort}"
            assertNull(PadDigestClient(null, null).read("/v1/pad-digest?agentId=alpha"))
            assertNull(PadDigestClient(endpoint, null).read("/v1/pad-digest?agentId=alpha"))
            assertTrue(seen.isEmpty())
            val client = PadDigestClient(endpoint, token)
            for (path in listOf("//outside.invalid/v1/pad-digest", "/v1/pad-secret", "/v1/agent-session-digest")) {
                assertNull(client.read(path))
            }
            assertTrue(seen.isEmpty())
            assertNotNull(client.read("/v1/pad-digest?agentId=alpha"))
            assertEquals("Bearer $token", seen.last().second)
            assertNull(PadDigestClient(endpoint, "wrong-fixture-" + "z".repeat(40)).read("/v1/pad-digest"))
            assertNull(client.read("/v1/pad-summary?redirect"))
            assertFalse(seen.any { it.first == "/must-not-follow" })
            assertNull(client.read("/v1/pad-summary?oversize"))
        } finally { server.close(); worker.join(1000) }
    }
}
