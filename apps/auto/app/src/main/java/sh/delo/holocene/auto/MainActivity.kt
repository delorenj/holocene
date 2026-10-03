package sh.delo.holocene.auto

import android.Manifest
import android.app.Activity
import android.app.role.RoleManager
import android.car.Car
import android.car.drivingstate.CarUxRestrictions
import android.car.drivingstate.CarUxRestrictionsManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import android.view.KeyEvent
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.Locale
import kotlin.concurrent.thread

class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val timers = Handler(Looper.getMainLooper())
    private val session = DiagnosticSession()
    private val preview get() = session.preview
    private lateinit var body: LinearLayout
    private lateinit var status: TextView
    private var car: Car? = null
    private var ux: CarUxRestrictionsManager? = null
    private var unrestricted = false
    private var recognizer: SpeechRecognizer? = null
    private var recorder: AudioRecord? = null
    private var speech: TextToSpeech? = null
    @Volatile private var capturing = false
    private var audio: AudioManager? = null
    private var focus: AudioFocusRequest? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        audio = getSystemService(AudioManager::class.java)
        val scroll = ScrollView(this)
        body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 16, 24, 24)
            setBackgroundColor(Color.rgb(11, 16, 32))
        }
        scroll.addView(body)
        setContentView(scroll)
        status = label("Host UX unknown; capture and detail disabled", 18f)
        connectHost()
        scheduleDiagnosticIntent(intent)
    }

    private fun label(text: String, size: Float = 16f): TextView = TextView(this).apply {
        this.text = text
        textSize = size
        setTextColor(Color.rgb(238, 243, 255))
        setPadding(0, 8, 0, 8)
        body.addView(this)
    }

    private fun button(text: String, action: () -> Unit) {
        body.addView(Button(this).apply {
            this.text = text
            isAllCaps = false
            minHeight = 56
            setOnClickListener { action() }
        })
    }

    private fun scheduleDiagnosticIntent(intent: Intent) {
        val mic = intent.getBooleanExtra(EXTRA_RUN_MIC, false)
        val asr = intent.getBooleanExtra(EXTRA_RUN_ASR, false)
        if (mic == asr) return
        timers.postDelayed({
            probe("diagnostic_intent", "mic=$mic asr=$asr unrestricted=$unrestricted")
            when {
                mic && unrestricted -> microphoneProbe()
                asr && unrestricted -> recognitionProbe()
                else -> report("Diagnostic intent refused: host restricted or unknown")
            }
        }, HOST_SETTLE_MS)
    }

    private fun probe(event: String, detail: String = "") {
        Log.i(TAG, "event=$event t=${SystemClock.elapsedRealtime()} gen=${session.generation} $detail".trim())
    }

    private fun report(message: String) {
        Log.i(TAG, message)
        status.text = message
    }

    private fun recognitionProvider(): String {
        val selected = Settings.Secure.getString(contentResolver, "voice_recognition_service").orEmpty()
        val services = packageManager.queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), PackageManager.ResolveInfoFlags.of(0))
            .joinToString(",") { "${it.serviceInfo.packageName}/${it.serviceInfo.name}" }
        return "selected=$selected services=$services"
    }

    private fun render() {
        body.removeAllViews()
        label("Holocene Auto · FIXTURE", 26f)
        label("Emulator diagnostic only · no live agents · not driving approved")
        status = label(if (unrestricted) "Host unrestricted; diagnostic controls only" else "Host restricted/unknown; no detail, capture or playback")
        val roles = getSystemService(RoleManager::class.java)
        label("Assistant role available=${roles.isRoleAvailable(RoleManager.ROLE_ASSISTANT)}, held=${roles.isRoleHeld(RoleManager.ROLE_ASSISTANT)}; no role change")
        label("Recognition provider=${SpeechRecognizer.isRecognitionAvailable(this)}; on-device=${SpeechRecognizer.isOnDeviceRecognitionAvailable(this)}")
        if (!unrestricted) return
        for (agent in Fixtures.agents) {
            label("FIXTURE · ${agent.employee} · ${agent.state}\n${agent.runtime} / ${agent.nativeSession}\nObserved ${agent.observedAt} · read-only")
        }
        button("Preview canned input (never send)") {
            preview.select("fixture-thread-1")
            preview.finalTranscript("Summarize recent work")
            report("${preview.preview}\n${preview.state}")
        }
        button("Probe microphone for 6 seconds (no audio saved)") { microphoneProbe() }
        button("Probe final ASR + local diagnostic acknowledgement") { recognitionProbe() }
        button("Cancel diagnostic capture / playback / unsent preview") { cancelDiagnostic("Cancelled by screen; nothing published", "screen") }
        for (event in Fixtures.normalized(Fixtures.events)) label(event)
    }

    private fun connectHost() {
        try {
            car = Car.createCar(this, main, Car.CAR_WAIT_TIMEOUT_DO_NOT_WAIT) { connectedCar, ready ->
                if (!ready) {
                    unrestricted = false
                    cancelDiagnostic("Car service unavailable", "car-unavailable")
                    render()
                    return@createCar
                }
                try {
                    ux = connectedCar.getCarManager(Car.CAR_UX_RESTRICTION_SERVICE) as CarUxRestrictionsManager
                    ux!!.registerListener { restrictions -> applyRestrictions(restrictions) }
                    applyRestrictions(ux!!.currentCarUxRestrictions)
                } catch (error: Exception) {
                    unrestricted = false
                    render()
                    report("Host UX unavailable: ${error.javaClass.simpleName}")
                }
            }
        } catch (error: Exception) {
            render()
            report("Car connection blocked: ${error.javaClass.simpleName}")
        }
    }

    private fun applyRestrictions(restrictions: CarUxRestrictions) {
        unrestricted = !restrictions.isRequiresDistractionOptimization && restrictions.activeRestrictions == CarUxRestrictions.UX_RESTRICTIONS_BASELINE
        if (!unrestricted) {
            session.restricted()
            releaseAll("Host restricted; stopped")
        }
        render()
        report("Host UX requiresDO=${restrictions.isRequiresDistractionOptimization}, mask=${restrictions.activeRestrictions}; unrestricted=$unrestricted")
    }

    private fun hasMicPermission(): Boolean {
        if (!unrestricted) return false
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return true
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
        report("Microphone permission requested; explicitly retry after grant")
        return false
    }

    private fun requestFocus(gain: Int, usage: Int, content: Int, stopsOnLoss: Boolean): Boolean {
        val request = AudioFocusRequest.Builder(gain)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(usage).setContentType(content).build())
            .setOnAudioFocusChangeListener { change ->
                probe("audio_focus_change", "change=$change")
                if (change <= 0 && stopsOnLoss) cancelDiagnostic("Focus lost; diagnostic cancelled", "focus-loss")
            }.build()
        focus = request
        val result = audio!!.requestAudioFocus(request)
        probe("audio_focus_request", "gain=$gain result=$result")
        return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun beginDiagnostic(): Int? {
        val token = session.begin(unrestricted)
        if (token == null) {
            probe("begin_refused", "phase=${session.phase} unrestricted=$unrestricted")
            report("Diagnostic busy or host restricted; use Cancel first")
            return null
        }
        if (!requestFocus(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE, AudioAttributes.USAGE_ASSISTANT, AudioAttributes.CONTENT_TYPE_SPEECH, true)) {
            cancelDiagnostic("Capture focus denied", "focus-denied")
            return null
        }
        return token
    }

    private fun microphoneProbe() {
        if (!hasMicPermission()) return
        val token = beginDiagnostic() ?: return
        try {
            val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val record = AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.MIC)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(maxOf(minimum, 6400)).build()
            recorder = record
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                cancelDiagnostic("AudioRecord initialization failed", "mic-init")
                return
            }
            capturing = true
            record.startRecording()
            probe("mic_started", "rate=$SAMPLE_RATE channels=1 encoding=pcm16 bound_ms=$MIC_WINDOW_MS")
            report("AudioRecord started; bounded 6-second capture; no persistence/upload")
            thread(name = "holocene-mic-probe") {
                val stats = PcmStats()
                var readError = 0
                val buffer = ShortArray(1600)
                try {
                    while (capturing && stats.samples < SAMPLE_RATE * MIC_WINDOW_MS / 1000) {
                        val count = record.read(buffer, 0, buffer.size)
                        if (count <= 0) { readError = count; break }
                        stats.add(buffer, count)
                    }
                } catch (error: Exception) { readError = AudioRecord.ERROR_INVALID_OPERATION }
                main.post {
                    if (session.isCapturing(token) && recorder === record) {
                        probe("mic_result", "${stats.summary()} readError=$readError envelope_100ms=${stats.envelope.joinToString(",")}")
                        session.endCapture(token)
                        releaseAll("Mic capture ${stats.summary()}, readError=$readError; silence is not real speech")
                    } else {
                        probe("mic_result_ignored", "late=true samples=${stats.samples}")
                    }
                }
            }
            timers.postDelayed({
                if (session.isCapturing(token) && recorder === record) cancelDiagnostic("Mic probe timed out; no transcript", "mic-timeout")
            }, MIC_WINDOW_MS + 1500L)
        } catch (error: SecurityException) {
            cancelDiagnostic("Microphone permission revoked or unavailable", "mic-permission")
        } catch (error: Exception) { cancelDiagnostic("Mic blocked: ${error.javaClass.simpleName}", "mic-error") }
    }

    private fun recognitionProbe() {
        if (!hasMicPermission()) return
        probe("asr_provider", recognitionProvider())
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            probe("asr_blocked", "reason=no_installed_recognition_provider")
            report("ASR blocked: no installed recognition provider")
            return
        }
        val token = beginDiagnostic() ?: return
        val started = SystemClock.elapsedRealtime()
        try {
            val engine = SpeechRecognizer.createSpeechRecognizer(this)
            recognizer = engine
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US")
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
            try {
                engine.checkRecognitionSupport(intent, mainExecutor, object : RecognitionSupportCallback {
                    override fun onSupportResult(support: RecognitionSupport) {
                        if (!session.isCapturing(token) || recognizer !== engine) {
                            probe("asr_support_ignored", "origin_gen=$token online=${support.onlineLanguages} installed=${support.installedOnDeviceLanguages}")
                            return
                        }
                        probe("asr_support", "online=${support.onlineLanguages} installed=${support.installedOnDeviceLanguages} pending=${support.pendingOnDeviceLanguages} supported=${support.supportedOnDeviceLanguages}")
                    }
                    override fun onError(error: Int) {
                        if (!session.isCapturing(token) || recognizer !== engine) {
                            probe("asr_support_error_ignored", "origin_gen=$token error=$error")
                            return
                        }
                        probe("asr_support_error", "origin_gen=$token error=$error")
                    }
                })
            } catch (error: Exception) { probe("asr_support_exception", "type=${error.javaClass.simpleName} message=${error.message}") }
            engine.setRecognitionListener(object : RecognitionListener {
                private fun live() = session.isCapturing(token) && recognizer === engine
                override fun onReadyForSpeech(params: Bundle?) {
                    if (!live()) { probe("asr_ready_ignored"); return }
                    probe("asr_ready", "since_start_ms=${SystemClock.elapsedRealtime() - started}")
                    report("ASR ready; intentional diagnostic capture")
                }
                override fun onBeginningOfSpeech() {
                    if (!live()) { probe("asr_begin_ignored"); return }
                    probe("asr_speech_begin", "since_start_ms=${SystemClock.elapsedRealtime() - started}")
                    report("Speech began")
                }
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {
                    if (!live()) { probe("asr_end_ignored"); return }
                    probe("asr_endpoint", "since_start_ms=${SystemClock.elapsedRealtime() - started}")
                    report("ASR endpoint reported; awaiting final transcript")
                }
                override fun onError(error: Int) {
                    if (!live()) { probe("asr_error_ignored", "error=$error"); return }
                    probe("asr_error", "error=$error since_start_ms=${SystemClock.elapsedRealtime() - started}")
                    session.endCapture(token)
                    releaseAll("ASR error=$error; no transcript/dispatch")
                }
                override fun onResults(results: Bundle?) {
                    if (!live()) { probe("asr_results_ignored"); return }
                    val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                    probe("asr_final", "since_start_ms=${SystemClock.elapsedRealtime() - started} transcript=\"$text\"")
                    val ack = session.accept(token, text)
                    releaseAll("ASR final result accepted=${ack != null}; diagnostic only", clearPreview = ack == null)
                    if (ack != null) {
                        status.text = "Actual provider transcript: $text\n${preview.state}"
                        speakAcknowledgement(token, ack)
                    }
                }
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            engine.startListening(intent)
            timers.postDelayed({
                if (session.isCapturing(token) && recognizer === engine) {
                    probe("asr_timeout", "bound_ms=$ASR_BOUND_MS")
                    cancelDiagnostic("ASR 15-second timeout; no final transcript", "asr-timeout")
                }
            }, ASR_BOUND_MS)
        } catch (error: Exception) { cancelDiagnostic("ASR blocked: ${error.javaClass.simpleName}", "asr-error") }
    }

    private fun speakAcknowledgement(token: Int, ack: Acknowledgement) {
        if (!session.isAcknowledging(token)) return
        probe("ack_requested", "label=\"${ack.label}\" text=\"${ack.spoken}\"")
        if (!requestFocus(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT, AudioAttributes.USAGE_ASSISTANT, AudioAttributes.CONTENT_TYPE_SPEECH, true)) {
            finishAcknowledgement(token, "Playback focus denied; no acknowledgement")
            return
        }
        var engine: TextToSpeech? = null
        engine = TextToSpeech(applicationContext) { initStatus ->
            main.post {
                val current = engine
                if (current == null || !session.isAcknowledging(token) || speech !== current) {
                    probe("tts_init_ignored", "status=$initStatus")
                    current?.shutdown()
                    return@post
                }
                if (initStatus != TextToSpeech.SUCCESS) {
                    probe("tts_init_failed", "status=$initStatus")
                    finishAcknowledgement(token, "TTS init failed; no acknowledgement")
                    return@post
                }
                val language = current.setLanguage(Locale.US)
                val boundEngine = boundTtsEngine(current)
                probe("tts_ready", "bound_engine=$boundEngine default_preference=${current.defaultEngine} language_result=$language available=${current.engines.joinToString(",") { it.name }}")
                if (language < TextToSpeech.LANG_AVAILABLE) {
                    finishAcknowledgement(token, "TTS en-US voice unavailable ($language); no acknowledgement")
                    return@post
                }
                current.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                current.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {
                        main.post {
                            if (!session.isAcknowledging(token) || speech !== current) { probe("tts_start_ignored"); return@post }
                            probe("tts_start", "utterance=$utteranceId")
                            report("Platform-local diagnostic acknowledgement playing (not Vox, not an agent reply)")
                        }
                    }
                    override fun onDone(utteranceId: String?) {
                        main.post {
                            if (!session.isAcknowledging(token) || speech !== current) { probe("tts_done_ignored"); return@post }
                            probe("tts_done", "utterance=$utteranceId")
                            finishAcknowledgement(token, "Acknowledgement finished; nothing published")
                        }
                    }
                    @Deprecated("Required by UtteranceProgressListener")
                    override fun onError(utteranceId: String?) { onError(utteranceId, -1) }
                    override fun onError(utteranceId: String?, errorCode: Int) {
                        main.post {
                            if (!session.isAcknowledging(token) || speech !== current) { probe("tts_error_ignored", "code=$errorCode"); return@post }
                            probe("tts_error", "code=$errorCode")
                            finishAcknowledgement(token, "TTS error=$errorCode; no acknowledgement")
                        }
                    }
                })
                val queued = current.speak(ack.spoken, TextToSpeech.QUEUE_FLUSH, null, "holoc10-ack-$token")
                probe("tts_speak_queued", "result=$queued")
                if (queued != TextToSpeech.SUCCESS) finishAcknowledgement(token, "TTS speak rejected; no acknowledgement")
            }
        }
        speech = engine
        timers.postDelayed({
            if (session.isAcknowledging(token) && speech === engine) {
                probe("tts_timeout", "bound_ms=$TTS_BOUND_MS")
                cancelDiagnostic("TTS 10-second timeout; acknowledgement cancelled", "tts-timeout")
            }
        }, TTS_BOUND_MS)
    }

    private fun finishAcknowledgement(token: Int, reason: String) {
        if (!session.completeAcknowledgement(token)) return
        releaseAll(reason)
    }

    private fun boundTtsEngine(engine: TextToSpeech): String = try {
        engine.javaClass.getMethod("getCurrentEngine").invoke(engine) as String? ?: "none"
    } catch (error: Exception) {
        "unreported"
    }

    private fun cancelDiagnostic(reason: String, source: String) {
        val wasActive = session.cancel()
        probe("cancel", "source=$source was_active=$wasActive")
        releaseAll(reason)
    }

    private fun releaseAll(reason: String, clearPreview: Boolean = true) {
        capturing = false
        timers.removeCallbacksAndMessages(null)
        recorder?.let {
            try { it.stop() } catch (error: IllegalStateException) { Log.i(TAG, "Recorder already stopped") }
            it.release()
        }
        recorder = null
        recognizer?.cancel()
        recognizer?.destroy()
        recognizer = null
        speech?.let {
            it.stop()
            it.shutdown()
        }
        speech = null
        focus?.let { audio?.abandonAudioFocusRequest(it) }
        focus = null
        if (clearPreview) preview.cancel()
        probe("released", "reason=\"$reason\"")
        if (::status.isInitialized) report(reason)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (StopKeys.isStop(keyCode)) {
            probe("key_stop", "key=${KeyEvent.keyCodeToString(keyCode)} simulated_diagnostic=true")
            cancelDiagnostic("Stopped by key ${KeyEvent.keyCodeToString(keyCode)}; nothing published", "key")
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onPause() {
        cancelDiagnostic("Activity paused; capture cancelled", "pause")
        super.onPause()
    }

    override fun onDestroy() {
        session.cancel()
        releaseAll("Activity destroyed")
        main.removeCallbacksAndMessages(null)
        ux?.unregisterListener()
        car?.disconnect()
        super.onDestroy()
    }

    private companion object {
        const val TAG = "HoloceneProbe"
        const val EXTRA_RUN_MIC = "sh.delo.holocene.extra.RUN_MIC"
        const val EXTRA_RUN_ASR = "sh.delo.holocene.extra.RUN_ASR"
        const val SAMPLE_RATE = 16000
        const val MIC_WINDOW_MS = 6000L
        const val HOST_SETTLE_MS = 1500L
        const val ASR_BOUND_MS = 15000L
        const val TTS_BOUND_MS = 10000L
    }
}
