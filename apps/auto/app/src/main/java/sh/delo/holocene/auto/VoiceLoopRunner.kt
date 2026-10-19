package sh.delo.holocene.auto

import android.content.Context
import android.content.SharedPreferences
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Handler
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.math.sqrt

/** Loop server endpoints; persisted in SharedPreferences, defaults target the DeLoNET host. */
internal data class LoopConfig(
    val natsHost: String,
    val natsPort: Int,
    val intakeUrl: String,
    val intakeToken: String = VoiceLoopContract.DEFAULT_INTAKE_TOKEN,
)

internal object LoopSettings {
    const val PREFS = "holocene_auto_loop"
    private const val HOST = "nats_host"
    private const val PORT = "nats_port"
    private const val INTAKE = "intake_url"

    fun load(prefs: SharedPreferences): LoopConfig = LoopConfig(
        natsHost = prefs.getString(HOST, null) ?: VoiceLoopContract.DEFAULT_NATS_HOST,
        natsPort = prefs.getInt(PORT, VoiceLoopContract.DEFAULT_NATS_PORT),
        intakeUrl = prefs.getString(INTAKE, null) ?: VoiceLoopContract.DEFAULT_INTAKE_URL,
    )

    fun save(prefs: SharedPreferences, host: String, port: Int, intakeUrl: String) {
        prefs.edit().putString(HOST, host).putInt(PORT, port).putString(INTAKE, intakeUrl).apply()
    }
}

/**
 * Android orchestration for one voice-loop run: record (bounded, silence-end)
 * -> AAC/m4a encode -> sha256 upload to wax intake -> NATS transcription event
 * -> dispatch command -> answer event -> MediaPlayer stream. Pure logic lives
 * in VoiceLoop/VoiceLoopContract; protocol in NatsClient.
 */
internal class VoiceLoopRunner(
    private val cacheDir: File,
    private val main: Handler,
    private val config: () -> LoopConfig,
    private val onPhase: (LoopPhase, String) -> Unit, // always main thread
    private val log: (String, String) -> Unit,
    private val requestPlaybackFocus: () -> Boolean,
    private val abandonPlaybackFocus: () -> Unit,
) {
    private val lock = Any()
    private val running = AtomicBoolean(false)
    @Volatile private var cancelled = false
    @Volatile private var runId = 0
    private var loop: VoiceLoop? = null
    private var nats: NatsClient? = null
    @Volatile private var player: MediaPlayer? = null
    @Volatile private var playerPrepared = false
    private var transcriptLatch = CountDownLatch(1)
    private var answerLatch = CountDownLatch(1)
    @Volatile private var recordFailure: String? = null

    val active: Boolean get() = synchronized(lock) { loop?.active == true }
    fun statusText(): String = synchronized(lock) { loop?.statusText() ?: "Voice loop idle" }
    fun agentName(): String? = synchronized(lock) { loop?.agentName }

    /** Starts a loop for [agent]; false when one is already running. */
    fun start(agent: String): Boolean {
        if (!running.compareAndSet(false, true)) return false
        cancelled = false
        recordFailure = null
        transcriptLatch = CountDownLatch(1)
        answerLatch = CountDownLatch(1)
        val fresh = VoiceLoop(agent)
        if (!fresh.begin()) { running.set(false); return false }
        synchronized(lock) { loop = fresh }
        val myRun = ++runId
        log("voice_loop_start", "agent=$agent thread=${fresh.threadId} profile=${fresh.targetProfile}")
        emit()
        thread(name = "holocene-voice-loop") { pipeline(myRun, fresh) }
        return true
    }

    /** Cancels the loop from UI/keys/focus loss; safe to call repeatedly. */
    fun cancel(reason: String) {
        if (!running.get()) return
        cancelled = true
        transcriptLatch.countDown()
        answerLatch.countDown()
        main.post { stopPlayback(myRun = null) }
        closeNats()
        synchronized(lock) { loop?.cancel() }
        log("voice_loop_cancel", "reason=\"$reason\"")
        emit()
        finishRun()
    }

    // ---- pipeline (background thread) ----

    private fun pipeline(myRun: Int, fresh: VoiceLoop) {
        try {
            val m4a = recordAndEncode(myRun)
                ?: run {
                    synchronized(lock) {
                        if (cancelled) fresh.cancel() else fresh.fail(recordFailure ?: "Recording failed")
                    }
                    emit()
                    finishRun()
                    return
                }
            if (stale(myRun)) return
            val cfg = config()
            val client = NatsClient(cfg.natsHost, cfg.natsPort)
            nats = client
            client.addListener { subject, payload -> onNatsMessage(subject, payload) }
            try {
                client.connect()
            } catch (error: Exception) {
                failRun(myRun, fresh, "NATS connect failed (${cfg.natsHost}:${cfg.natsPort}): ${error.javaClass.simpleName}")
                return
            }
            client.subscribe(VoiceLoopContract.NATS_SUBJECT_TRANSCRIPT)
            client.subscribe(VoiceLoopContract.NATS_SUBJECT_ANSWER)

            step(myRun, fresh, LoopPhase.UPLOADING)
            val itemId = VoiceLoopContract.itemId(m4a)
            fresh.awaitItem(itemId)
            val filename = VoiceLoopContract.fileName(System.currentTimeMillis(), fresh.agentName)
            val code = upload(m4a, filename, cfg)
            if (code !in 200..299) {
                failRun(myRun, fresh, "Intake rejected upload: HTTP $code")
                return
            }
            if (stale(myRun)) return
            log("voice_loop_uploaded", "file=$filename item=$itemId bytes=${m4a.size}")

            step(myRun, fresh, LoopPhase.TRANSCRIBING)
            if (!awaitLatch(transcriptLatch, TRANSCRIBE_TIMEOUT_S)) {
                if (cancelled) { cancelLate(fresh) } else failRun(myRun, fresh, "Transcription timeout after ${TRANSCRIBE_TIMEOUT_S}s")
                return
            }
            if (stale(myRun)) return
            val transcriptJson = transcriptEvent
            val transcript = transcriptJson?.let { VoiceLoopContract.transcriptFromEvent(it) }
            if (transcript.isNullOrEmpty()) {
                failRun(myRun, fresh, "Transcription was empty; aborting dispatch")
                return
            }
            log("voice_loop_transcript", "chars=${transcript.length} item=$itemId")

            step(myRun, fresh, LoopPhase.DISPATCHING)
            val commandId = UUID.randomUUID().toString()
            val correlationId = UUID.randomUUID().toString()
            val envelope = VoiceLoopContract.buildDispatchEnvelope(
                agentName = fresh.agentName,
                transcript = transcript,
                threadId = fresh.threadId ?: "holocene-auto-unknown",
                commandId = commandId,
                correlationId = correlationId,
                idempotencyKey = UUID.randomUUID().toString(),
                nowIso8601 = Instant.now().toString(),
            )
            client.publish(VoiceLoopContract.NATS_SUBJECT_DISPATCH, envelope)
            log("voice_loop_dispatched", "command=$commandId thread=${fresh.threadId} target=${fresh.targetProfile}")

            step(myRun, fresh, LoopPhase.AWAITING_ANSWER)
            if (!awaitLatch(answerLatch, ANSWER_TIMEOUT_S)) {
                if (cancelled) { cancelLate(fresh) } else failRun(myRun, fresh, "No agent answer within ${ANSWER_TIMEOUT_S}s")
                return
            }
            if (stale(myRun)) return
            val audioUrl = answerEvent?.let { VoiceLoopContract.answerAudioUrl(it) }
            if (audioUrl.isNullOrEmpty()) {
                failRun(myRun, fresh, "Answer arrived without playable audio")
                return
            }
            step(myRun, fresh, LoopPhase.PLAYING)
            main.post { startPlayback(myRun, audioUrl) }
            // run finishes from player completion/error callbacks or watchdog.
        } catch (error: Exception) {
            log("voice_loop_exception", "type=${error.javaClass.simpleName} message=${error.message}")
            synchronized(lock) { loop?.let { if (it.active) { if (cancelled) it.cancel() else it.fail(error.javaClass.simpleName) } } }
            emit()
            finishRun()
        }
    }

    @Volatile private var transcriptEvent: String? = null
    @Volatile private var answerEvent: String? = null

    private fun onNatsMessage(subject: String, payload: String) {
        val current = loop ?: return
        when (subject) {
            VoiceLoopContract.NATS_SUBJECT_TRANSCRIPT -> {
                val id = VoiceLoopContract.itemIdFromEvent(payload) ?: return
                if (id == current.itemId) { transcriptEvent = payload; transcriptLatch.countDown() }
            }
            VoiceLoopContract.NATS_SUBJECT_ANSWER -> {
                val thread = current.threadId ?: return
                if (VoiceLoopContract.matchesAnswerEvent(payload, thread)) { answerEvent = payload; answerLatch.countDown() }
            }
        }
    }

    // ---- recording + AAC encode (framework only) ----

    private fun recordAndEncode(myRun: Int): ByteArray? {
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val record = AudioRecord.Builder()
            .setAudioSource(MediaRecorder.AudioSource.MIC)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .build(),
            )
            .setBufferSizeInBytes(maxOf(minBuf, 12800))
            .build()
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            runCatching { record.release() }
            recordFailure = "AudioRecord initialization failed"
            return null
        }
        val tmp = File(cacheDir, "holocene-auto-loop.m4a")
        var encoder: MediaCodec? = null
        var muxer: MediaMuxer? = null
        try {
            record.startRecording()
            encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).apply {
                configure(
                    MediaFormat().apply {
                        setString(MediaFormat.KEY_MIME, MediaFormat.MIMETYPE_AUDIO_AAC)
                        setInteger(MediaFormat.KEY_SAMPLE_RATE, SAMPLE_RATE)
                        setInteger(MediaFormat.KEY_CHANNEL_COUNT, 1)
                        setInteger(MediaFormat.KEY_BIT_RATE, 32000)
                        setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                    },
                    null, null, MediaCodec.CONFIGURE_FLAG_ENCODE,
                )
                start()
            }
            muxer = MediaMuxer(tmp.absolutePath, MediaMuxer.OutputFormat.MPEG_4)

            val chunk = ShortArray(SAMPLE_RATE / 10) // 100 ms
            val pcmBuffer = ByteBuffer.allocate(chunk.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            var totalSamples = 0L
            var speechSeen = false
            var lastSpeechAt = 0L
            var noiseFloor = Double.MAX_VALUE
            val startedAt = System.currentTimeMillis()
            val mux = MuxState()
            while (!cancelled && !staleNoLock(myRun)) {
                val elapsed = System.currentTimeMillis() - startedAt
                if (elapsed >= MAX_CAPTURE_MS) break
                val n = record.read(chunk, 0, chunk.size)
                if (n <= 0) { recordFailure = "Microphone read failed"; return null }
                var sum = 0.0
                for (i in 0 until n) sum += chunk[i].toDouble() * chunk[i]
                val rms = sqrt(sum / n)
                if (rms < noiseFloor) noiseFloor = rms
                val threshold = maxOf(1100.0, noiseFloor * 3.0)
                if (rms >= threshold) { speechSeen = true; lastSpeechAt = System.currentTimeMillis() }
                if (!speechSeen && elapsed >= EARLY_SILENCE_MS) {
                    recordFailure = "No speech detected"
                    return null
                }
                if (speechSeen && System.currentTimeMillis() - lastSpeechAt >= TRAILING_SILENCE_MS) break

                pcmBuffer.clear()
                pcmBuffer.asShortBuffer().put(chunk, 0, n)
                val pcm = ByteArray(n * 2)
                pcmBuffer.position(0)
                pcmBuffer.get(pcm)
                val ptsUs = totalSamples * 1_000_000L / SAMPLE_RATE
                totalSamples += n
                val inIdx = encoder.dequeueInputBuffer(10_000)
                if (inIdx >= 0) {
                    val buf = encoder.getInputBuffer(inIdx)!!
                    buf.clear()
                    buf.put(pcm)
                    encoder.queueInputBuffer(inIdx, 0, pcm.size, ptsUs, 0)
                }
                drainEncoder(encoder, muxer, mux, timeoutUs = 0)
            }
            // Flush end-of-stream through the encoder.
            val eosIdx = encoder.dequeueInputBuffer(100_000)
            if (eosIdx >= 0) {
                encoder.queueInputBuffer(eosIdx, 0, 0, totalSamples * 1_000_000L / SAMPLE_RATE, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            }
            var sawEos = false
            while (!sawEos) sawEos = drainEncoder(encoder, muxer, mux, timeoutUs = 50_000)
            if (mux.trackIndex < 0) { recordFailure = "Encoder produced no audio"; return null }
            if (!mux.started) {
                muxer.start()
                mux.started = true
            }
            runCatching { muxer.stop() }
            return tmp.readBytes()
        } catch (error: Exception) {
            recordFailure = "Capture failed: ${error.javaClass.simpleName}"
            return null
        } finally {
            runCatching { record.stop() }
            runCatching { record.release() }
            runCatching { encoder?.stop() }
            runCatching { encoder?.release() }
            runCatching { muxer?.release() }
            runCatching { tmp.delete() }
        }
    }

    /** Muxer start ordering: addTrack(outputFormat) -> start() -> writeSampleData. */
    private class MuxState {
        var trackIndex = -1
        var started = false
    }

    /**
     * Drains encoder output; handles track registration and muxer start in the
     * protocol-mandated order. Returns true when EOS was seen.
     */
    private fun drainEncoder(encoder: MediaCodec, muxer: MediaMuxer, mux: MuxState, timeoutUs: Long): Boolean {
        val info = MediaCodec.BufferInfo()
        while (true) {
            val outIdx = encoder.dequeueOutputBuffer(info, timeoutUs)
            when {
                outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    if (!mux.started) {
                        mux.trackIndex = muxer.addTrack(encoder.outputFormat)
                        muxer.start()
                        mux.started = true
                    }
                }
                outIdx >= 0 -> {
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                        encoder.releaseOutputBuffer(outIdx, false)
                    } else {
                        val data = encoder.getOutputBuffer(outIdx)!!
                        data.position(info.offset)
                        data.limit(info.offset + info.size)
                        if (info.size > 0) {
                            if (!mux.started) {
                                mux.trackIndex = muxer.addTrack(encoder.outputFormat)
                                muxer.start()
                                mux.started = true
                            }
                            muxer.writeSampleData(mux.trackIndex, data, info)
                        }
                        encoder.releaseOutputBuffer(outIdx, false)
                    }
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return true
                }
                else -> return false // TRY_AGAIN_LATER / INFO_OUTPUT_BUFFERS_CHANGED
            }
        }
    }


    // ---- upload ----

    private fun upload(bytes: ByteArray, filename: String, cfg: LoopConfig): Int {
        var conn: HttpURLConnection? = null
        return try {
            val url = URL(cfg.intakeUrl.trimEnd('/') + "/inbox/" + filename)
            conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "PUT"
            conn.connectTimeout = 10_000
            conn.readTimeout = 30_000
            conn.setDoOutput(true)
            conn.setRequestProperty("Authorization", "Bearer ${cfg.intakeToken}")
            conn.setRequestProperty("Content-Type", "audio/mp4")
            conn.outputStream.use { it.write(bytes) }
            conn.responseCode
        } catch (error: Exception) {
            log("voice_loop_upload_error", "type=${error.javaClass.simpleName} message=${error.message}")
            -1
        } finally {
            conn?.disconnect()
        }
    }

    // ---- playback (main thread) ----

    private fun startPlayback(myRun: Int, url: String) {
        if (stale(myRun) || cancelled) return
        if (!requestPlaybackFocus()) {
            synchronized(lock) { loop?.fail("Playback focus denied") }
            emit()
            finishRun()
            return
        }
        val mediaPlayer = MediaPlayer()
        player = mediaPlayer
        try {
            mediaPlayer.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            mediaPlayer.setDataSource(url)
            mediaPlayer.setOnPreparedListener {
                if (stale(myRun) || cancelled) return@setOnPreparedListener
                playerPrepared = true
                mediaPlayer.start()
                log("voice_loop_playing", "url=${url.take(120)}")
            }
            mediaPlayer.setOnCompletionListener {
                if (stale(myRun)) return@setOnCompletionListener
                log("voice_loop_done", "thread=${loop?.threadId}")
                synchronized(lock) { loop?.complete() }
                emit()
                stopPlayback(myRun)
                finishRun()
            }
            mediaPlayer.setOnErrorListener { _, what, extra ->
                if (stale(myRun)) return@setOnErrorListener true
                synchronized(lock) { loop?.fail("Player error $what/$extra") }
                emit()
                stopPlayback(myRun)
                finishRun()
                true
            }
            mediaPlayer.prepareAsync()
            main.postDelayed({
                if (!stale(myRun) && synchronized(lock) { loop?.phase } == LoopPhase.PLAYING) {
                    synchronized(lock) { loop?.fail("Playback timeout") }
                    emit()
                    stopPlayback(myRun)
                    finishRun()
                }
            }, PLAYBACK_TIMEOUT_MS)
        } catch (error: Exception) {
            synchronized(lock) { loop?.fail("Playback failed: ${error.javaClass.simpleName}") }
            emit()
            stopPlayback(myRun)
            finishRun()
        }
    }

    private fun stopPlayback(myRun: Int?) {
        val current = player ?: return
        player = null
        playerPrepared = false
        runCatching { if (playerPrepared) current.stop() }
        runCatching { current.stop() }
        runCatching { current.release() }
        abandonPlaybackFocus()
    }

    // ---- helpers ----

    private fun stale(myRun: Int): Boolean = myRun != runId || cancelled

    private fun staleNoLock(myRun: Int): Boolean = stale(myRun)

    private fun step(myRun: Int, fresh: VoiceLoop, phase: LoopPhase) {
        if (stale(myRun)) return
        synchronized(lock) { fresh.transition(phase) }
        emit()
    }

    private fun failRun(myRun: Int, fresh: VoiceLoop, reason: String) {
        if (stale(myRun) && !cancelled) return
        synchronized(lock) { fresh.fail(reason) }
        log("voice_loop_failed", "reason=\"$reason\"")
        emit()
        finishRun()
    }

    private fun cancelLate(fresh: VoiceLoop) {
        synchronized(lock) { fresh.cancel() }
        emit()
        finishRun()
    }

    private fun emit() {
        val text = synchronized(lock) { loop?.statusText() } ?: return
        val phase = synchronized(lock) { loop?.phase } ?: return
        main.post { onPhase(phase, text) }
    }

    private fun closeNats() {
        nats?.let { runCatching { it.close() } }
        nats = null
    }

    private fun finishRun() {
        closeNats()
        running.set(false)
    }

    private fun awaitLatch(latch: CountDownLatch, timeoutSec: Long): Boolean {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSec)
        while (System.nanoTime() < deadline) {
            if (cancelled) return false
            if (latch.await(500, TimeUnit.MILLISECONDS)) return true
        }
        return latch.await(0, TimeUnit.MILLISECONDS)
    }

    private companion object {
        const val SAMPLE_RATE = 16000
        const val MAX_CAPTURE_MS = 10_000L
        const val EARLY_SILENCE_MS = 3_000L
        const val TRAILING_SILENCE_MS = 1_400L
        const val TRANSCRIBE_TIMEOUT_S = 120L
        const val ANSWER_TIMEOUT_S = 300L
        const val PLAYBACK_TIMEOUT_MS = 180_000L
    }
}
