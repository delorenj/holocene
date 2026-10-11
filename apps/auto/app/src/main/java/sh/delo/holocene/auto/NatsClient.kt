package sh.delo.holocene.auto

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.concurrent.thread

/**
 * Minimal NATS text-protocol client (publish + subscribe) over raw TCP.
 * Framework-free: socket/thread code is small and Android-agnostic so the
 * protocol parsing stays JVM-unit-testable (see parseMsgLine).
 *
 * Protocol shape (verified against the DeLoNET NATS server):
 *   server -> INFO {json}
 *   client -> CONNECT {"verbose":false,...} then SUB <subject> <sid>
 *   client -> PUB <subject> <n>\r\n<payload>\r\n   PING\r\n -> PONG\r\n
 *   server -> MSG <subject> <sid> [reply-to] <n>\r\n<payload>\r\n
 */
internal class NatsClient(
    private val host: String,
    private val port: Int,
    private val clientName: String = "holocene-auto",
) {
    enum class State { DISCONNECTED, CONNECTING, CONNECTED, CLOSED }

    /** Message or state change delivered off the read loop thread. */
    fun interface Listener {
        fun onMessage(subject: String, payload: String)
    }

    @Volatile var state = State.DISCONNECTED
        private set
    @Volatile private var socket: Socket? = null
    private var output: BufferedOutputStream? = null
    @Volatile private var closed = false
    private val nextSid = java.util.concurrent.atomic.AtomicInteger(1)
    private val listenerRef = java.util.concurrent.CopyOnWriteArrayList<Listener>()
    private val stateRef = java.util.concurrent.CopyOnWriteArrayList<(State) -> Unit>()

    fun addListener(listener: Listener) { listenerRef.add(listener) }
    fun onStateChange(handler: (State) -> Unit) { stateRef.add(handler) }

    /** Blocking connect (call from a background thread). Throws on failure. */
    @Synchronized
    fun connect(timeoutMs: Int = 4000): Boolean {
        check(state == State.DISCONNECTED || state == State.CLOSED) { "connect from state $state" }
        closed = false
        state = State.CONNECTING
        publishState()
        val sock = Socket()
        try {
            sock.tcpNoDelay = true
            sock.connect(InetSocketAddress(host, port), timeoutMs)
            sock.soTimeout = READ_TIMEOUT_MS
            val out = BufferedOutputStream(sock.getOutputStream())
            val ins = BufferedInputStream(sock.getInputStream())
            // Server greeting: INFO {json}\r\n
            val info = readLine(ins, ByteArray(MAX_CONTROL_LINE))
            if (info == null || !info.startsWith("INFO")) {
                throw IOException("NATS greeting was not INFO: ${info?.take(40)}")
            }
            out.write(connectOptions(clientName).toByteArray(Charsets.UTF_8))
            out.write(CRLF)
            out.flush()
            socket = sock
            output = out
            state = State.CONNECTED
            publishState()
            thread(name = "holocene-nats-read", isDaemon = true) { readLoop(ins) }
            keepalive = thread(name = "holocene-nats-ping", isDaemon = true) { pingLoop() }
            return true
        } catch (e: Exception) {
            runCatching { sock.close() }
            state = State.DISCONNECTED
            publishState()
            throw e
        }
    }

    @Volatile private var keepalive: Thread? = null

    private fun pingLoop() {
        while (!closed && state == State.CONNECTED) {
            Thread.sleep(PING_INTERVAL_MS)
            if (closed || state != State.CONNECTED) return
            try {
                val out = synchronized(this) { output } ?: return
                out.write("PING\r\n".toByteArray(Charsets.UTF_8))
                out.flush()
            } catch (e: Exception) {
                markClosed("ping failed: ${e.message}")
                return
            }
        }
    }

    @Synchronized
    fun subscribe(subject: String): Int {
        val out = output ?: throw IOException("not connected")
        val sid = nextSid.getAndIncrement()
        out.write("SUB $subject $sid\r\n".toByteArray(Charsets.UTF_8))
        out.write("PING\r\n".toByteArray(Charsets.UTF_8))
        out.flush()
        return sid
    }

    @Synchronized
    fun publish(subject: String, payload: String) {
        val out = output ?: throw IOException("not connected")
        val body = payload.toByteArray(Charsets.UTF_8)
        out.write("PUB $subject ${body.size}\r\n".toByteArray(Charsets.UTF_8))
        out.write(body)
        out.write(CRLF)
        out.flush()
    }

    /** Flush protocol (PING + wait for PONG) is fire-and-forget here: PING already sent with SUB. */

    @Synchronized
    fun close() {
        if (closed) return
        closed = true
        state = State.CLOSED
        runCatching { output?.flush() }
        runCatching { socket?.close() }
        publishState()
    }

    private fun markClosed(reason: String) {
        if (closed) return
        closed = true
        state = State.CLOSED
        runCatching { socket?.close() }
        publishState()
    }

    private fun publishState() {
        stateRef.forEach { it(state) }
    }

    private fun readLoop(ins: BufferedInputStream) {
        val lineBuf = ByteArray(MAX_CONTROL_LINE)
        try {
            while (!closed) {
                val line = readLine(ins, lineBuf) ?: break
                when {
                    line.startsWith("MSG ") -> {
                        val parsed = parseMsgLine(line)
                        if (parsed == null) { markClosed("bad MSG line: ${line.take(60)}"); return }
                        val payload = readExactly(ins, parsed.size)
                        readLine(ins, lineBuf) // trailing CRLF
                        if (payload == null) { markClosed("short payload"); return }
                        listenerRef.forEach { it.onMessage(parsed.subject, String(payload, Charsets.UTF_8)) }
                    }
                    line == "PING" -> {
                        val out = synchronized(this) { output } ?: return
                        out.write("PONG\r\n".toByteArray(Charsets.UTF_8))
                        out.flush()
                    }
                    line.startsWith("-ERR") -> markClosed(line)
                    line == "PONG" || line.startsWith("INFO") -> Unit
                    else -> Unit
                }
            }
        } catch (e: Exception) {
            markClosed("read loop ended: ${e.javaClass.simpleName} ${e.message}")
        }
    }

    private fun connectOptions(name: String): String =
        "{\"verbose\":false,\"pedantic\":false,\"tls_required\":false,\"name\":\"$name\",\"lang\":\"kotlin\",\"version\":\"1.0\",\"protocol\":1}"

    companion object {
        const val MAX_CONTROL_LINE = 16 * 1024
        const val READ_TIMEOUT_MS = 0 // blocking read; keepalive PING detects dead peers
        private val CRLF = "\r\n".toByteArray(Charsets.UTF_8)
        private const val PING_INTERVAL_MS = 20_000L

        /** MSG <subject> <sid> [reply-to] <size> -> (subject, sid, replyTo?, size). */
        fun parseMsgLine(line: String): MsgHead? {
            if (!line.startsWith("MSG ")) return null
            val args = line.substring(4).trim().split(' ').filter { it.isNotEmpty() }
            return when (args.size) {
                3 -> MsgHead(args[0], args[1].toIntOrNull() ?: return null, null, args[2].toIntOrNull() ?: return null)
                4 -> MsgHead(args[0], args[1].toIntOrNull() ?: return null, args[2], args[3].toIntOrNull() ?: return null)
                else -> null
            }
        }

        fun readLine(ins: BufferedInputStream, reuse: ByteArray): String? {
            var len = 0
            while (true) {
                val b = ins.read()
                if (b < 0) return if (len == 0) null else String(reuse, 0, len, Charsets.UTF_8)
                if (b == '\n'.code) return String(reuse, 0, maxOf(len - 1, 0), Charsets.UTF_8) // strip \r
                if (len >= reuse.size) throw IOException("control line too long")
                reuse[len++] = b.toByte()
            }
        }

        fun readExactly(ins: BufferedInputStream, n: Int): ByteArray? {
            if (n < 0 || n > 32 * 1024 * 1024) return null
            val buf = ByteArray(n)
            var got = 0
            while (got < n) {
                val r = ins.read(buf, got, n - got)
                if (r < 0) return null
                got += r
            }
            return buf
        }
    }
}

internal data class MsgHead(val subject: String, val sid: Int, val replyTo: String?, val size: Int)
