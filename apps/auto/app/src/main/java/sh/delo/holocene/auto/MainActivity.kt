package sh.delo.holocene.auto

import android.Manifest
import android.app.Activity
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
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
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.widget.EditText
import android.widget.Button
import android.widget.FrameLayout
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
    private lateinit var content: FrameLayout
    private lateinit var scroll: ScrollView
    private lateinit var pad: AgentPadHost
    private var showingPad = true
    private var carHost: CarHost? = null
    private var unrestricted = false
    private var hostUx = HostUx.UNKNOWN // fail closed until the car host reports

    // Steering-wheel control (see DriveControls): pure state machine plus the Android plumbing around it.
    private lateinit var tabs: LinearLayout
    private lateinit var settings: DriveSettings
    private lateinit var inspector: KeyInspector
    private val controls = DriveControls()
    // Every sound the app makes goes through this one queue (SpeechArbiter): wheel cues, the instant ack, the heard
    // echo, progress narration and replies. Created in onCreate and shared with the pad.
    private lateinit var voice: SpeechHost
    private var wheelSession: WheelSession? = null
    private var resumed = false
    private var lastWheelAt = 0L
    private var learning: DriveAction? = null
    private val learnSwallowed = HashSet<Int>()
    private var askedMic = false
    private var inspectorLog: TextView? = null
    private var inspectorInfo: TextView? = null
    private var recognizer: SpeechRecognizer? = null
    private var recorder: AudioRecord? = null
    private var speech: TextToSpeech? = null
    @Volatile private var capturing = false
    private var audio: AudioManager? = null
    private var focus: AudioFocusRequest? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        audio = getSystemService(AudioManager::class.java)
        scroll = ScrollView(this)
        body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 16, 24, 24)
            setBackgroundColor(Color.rgb(11, 16, 32))
        }
        scroll.addView(body)
        content = FrameLayout(this)
        // Debug builds only: a validated localhost dev-server origin from the launch intent, never persisted.
        val debuggable = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        val devUrl = AgentPadPolicy.devPadUrlOrNull(intent.getStringExtra(EXTRA_PAD_URL), debuggable)
        voice = SpeechHost(this)
        pad = AgentPadHost(this, content, devUrl, voice)
        settings = DriveSettings(this)
        controls.mapping = settings.mapping
        inspector = KeyInspector(this).also {
            it.meta = { mapOf("mapping" to controls.mapping.serialize(), "installer" to installSource(), "session" to (wheelSession?.held == true).toString()) }
            it.onChanged = { refreshInspector() }
        }
        pad.onPadEvent = { ev -> onPadEvent(ev) }
        pad.beforeRecord = { name, go -> announceRecording(name, go) }
        pad.echoAllowed = { speaking() }
        tabs = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.rgb(11, 16, 32))
            for ((title, toPad) in listOf("Agent Pad" to true, "Diagnostics" to false)) {
                addView(Button(this@MainActivity).apply {
                    text = title
                    isAllCaps = false
                    // Car touch targets: at least 76 px tall with 22 sp text (was 56 px / 14 sp).
                    minHeight = 80
                    minimumHeight = 80
                    textSize = 22f
                    setOnClickListener { showView(toPad) }
                }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            }
            if (CarHost.isCarHostAvailable(this@MainActivity) && installSource() != PLAY_STORE) addView(TextView(this@MainActivity).apply {
                text = "SIDELOAD: blocked while driving"
                textSize = 14f
                gravity = android.view.Gravity.CENTER
                setPadding(16, 0, 16, 0)
                setTextColor(Color.BLACK)
                setBackgroundColor(Color.rgb(255, 152, 0))
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT))
            if (devUrl != null) addView(TextView(this@MainActivity).apply {
                text = "DEV $devUrl"
                textSize = 14f
                gravity = android.view.Gravity.CENTER
                setPadding(16, 0, 16, 0)
                setTextColor(Color.BLACK)
                setBackgroundColor(Color.rgb(255, 193, 7))
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT))
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(11, 16, 32))
            // targetSdk 35 is edge-to-edge: keep the tabs out from under the status/navigation bars.
            setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                android.view.WindowInsets.CONSUMED
            }
            addView(tabs, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            addView(content, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        })
        status = label("Host UX unknown; capture and detail disabled", 18f)
        connectHost()
        scheduleDiagnosticIntent(intent)
        showView(true)
    }

    private fun mode(): PadMode = PadModes.of(carHost != null, hostUx)

    private fun showView(toPad: Boolean) {
        // Diagnostics (probes, key inspector, settings) are for a parked car or a desk phone only.
        if (!toPad && !PadModes.diagnosticsAllowed(mode())) return
        showingPad = toPad
        syncWheel()
        if (toPad) {
            refreshPad()
        } else {
            pad.teardown()
            content.removeAllViews()
            content.addView(scroll)
        }
    }

    private fun refreshPad() {
        if (!showingPad) return
        // Never torn down for driving: the page switches to its driving layout instead.
        pad.setHost(mode(), hostUx)
        pad.show()
    }

    /** Parked shows the tabs; driving shows only the pad. */
    private fun applyMode() {
        val driving = mode() == PadMode.DRIVING
        tabs.visibility = if (driving) android.view.View.GONE else android.view.View.VISIBLE
        if (driving && !showingPad) showView(true)
        syncWheel()
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

    private fun scheduleDiagnosticIntent(intent: Intent, attempt: Int = 0) {
        val mic = intent.getBooleanExtra(EXTRA_RUN_MIC, false)
        val asr = intent.getBooleanExtra(EXTRA_RUN_ASR, false)
        if (mic == asr) return
        timers.postDelayed({
            // A car host reports "restricted" first and "unrestricted" a moment later (about 1.7 s after start on the
            // Honda image, just after HOST_SETTLE_MS). Wait for it instead of refusing the probe in that gap, which made
            // auto:sim:mic-check time out as INCONCLUSIVE.
            if (!unrestricted && attempt < HOST_WAIT_ATTEMPTS) { scheduleDiagnosticIntent(intent, attempt + 1); return@postDelayed }
            probe("diagnostic_intent", "mic=$mic asr=$asr unrestricted=$unrestricted attempt=$attempt")
            when {
                mic && unrestricted -> microphoneProbe()
                asr && unrestricted -> recognitionProbe()
                else -> report("Diagnostic intent refused: host restricted or unknown")
            }
        }, if (attempt == 0) HOST_SETTLE_MS else HOST_WAIT_STEP_MS)
    }

    private fun probe(event: String, detail: String = "") {
        Log.i(TAG, "event=$event t=${SystemClock.elapsedRealtime()} gen=${session.generation} $detail".trim())
    }

    private fun report(message: String) {
        Log.i(TAG, message)
        status.text = message
    }

    @Suppress("DEPRECATION") // The int-flags overload also works on the Honda's Android 12L.
    private fun recognitionProvider(): String {
        val selected = Settings.Secure.getString(contentResolver, "voice_recognition_service").orEmpty()
        val services = packageManager.queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), 0)
            .joinToString(",") { "${it.serviceInfo.packageName}/${it.serviceInfo.name}" }
        return "selected=$selected services=$services"
    }

    private fun render() {
        body.removeAllViews()
        label("Holocene Auto · FIXTURE", 26f)
        label("Emulator diagnostic only · no live agents · not driving approved")
        val hostConnected = carHost?.connected == true
        status = label(
            when {
                unrestricted -> "Host unrestricted; diagnostic controls only"
                hostConnected -> "Host restricted/unknown; no detail, capture or playback"
                else -> "Not a car host; fixture availability shown read-only, diagnostics disabled"
            },
        )
        val roles = getSystemService(RoleManager::class.java)
        label("Assistant role available=${roles.isRoleAvailable(RoleManager.ROLE_ASSISTANT)}, held=${roles.isRoleHeld(RoleManager.ROLE_ASSISTANT)}; no role change")
        label("Recognition provider=${SpeechRecognizer.isRecognitionAvailable(this)}; on-device=${SpeechRecognizer.isOnDeviceRecognitionAvailable(this)}")
        val isAutomotiveDevice = packageManager.hasSystemFeature(PackageManager.FEATURE_AUTOMOTIVE)
        if (unrestricted || !isAutomotiveDevice) {
            button("Open privacy policy in browser") {
                openPrivacyPolicy()
            }
        }
        if (carHost == null || unrestricted) body.addView(buildInspector())
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

    private fun openPrivacyPolicy() {
        if (packageManager.hasSystemFeature(PackageManager.FEATURE_AUTOMOTIVE) && !unrestricted) {
            report("Blocked while driving")
            return
        }
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_POLICY_URL)))
        } catch (e: android.content.ActivityNotFoundException) {
            report("No browser available to open privacy policy")
        }
    }

    private fun connectHost() {
        if (!CarHost.isCarHostAvailable(this)) {
            carHost = null
            unrestricted = false
            status.text = "Not a car host; fixture availability shown read-only, diagnostics disabled"
            render()
            return
        }
        val host = CarHost(
            onUnrestrictedChange = { free ->
                unrestricted = free
                if (!free) {
                    session.restricted()
                    releaseAll("Host restricted; stopped")
                }
                render()
                applyMode()
                refreshPad()
            },
            onStatus = { message -> if (::status.isInitialized) report(message) },
            onUx = { ux -> hostUx = ux },
        )
        carHost = host
        host.connect(this, main)
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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) try {
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
            else { probe("asr_support_unavailable", "sdk=${Build.VERSION.SDK_INT}; provider preflight requires API 33") }
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

    private fun installSource(): String = try {
        packageManager.getInstallSourceInfo(packageName).installingPackageName ?: "none"
    } catch (e: Exception) { "unknown" }

    /** Wheel control is live only while Agent Pad itself is in front. */
    private fun syncWheel() {
        if (!::settings.isInitialized) return
        val on = settings.wheelControl && showingPad && resumed
        if (controls.active != on) controls.reset()
        controls.active = on
        // The MediaSession is the price of getting media keys on a car that routes them there: held only in front.
        val wantSession = settings.wheelControl && resumed && carHost != null
        if (wantSession) {
            val s = wheelSession ?: WheelSession(this, ::sessionKey, ::sessionCallback).also { wheelSession = it }
            s.acquire()
        } else {
            wheelSession?.release()
        }
        inspectorInfo?.text = inspectorInfoText()
    }

    private fun wheelRecent() = SystemClock.elapsedRealtime() - lastWheelAt < WHEEL_RECENT_MS

    private fun speaking() = DriveSpeech.shouldSpeak(settings.spokenFeedback, carHost != null, wheelRecent())

    private fun describe(r: DriveResult): String? = when {
        r.action != null -> r.action.name
        r.refusal != null -> "refused:${r.refusal.name}"
        r.consumed -> "swallowed"
        else -> null
    }

    private fun textFieldFocused() = currentFocus is EditText

    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        val now = SystemClock.uptimeMillis()
        val typing = textFieldFocused()
        val target = learning
        if (target != null && !typing && e.action == KeyEvent.ACTION_DOWN && e.repeatCount == 0 && e.keyCode !in Keys.PROTECTED) {
            inspector.key(e, "learn", target.name)
            learnKey(e.keyCode, target)
            learnSwallowed += e.keyCode
            return true
        }
        if (e.action == KeyEvent.ACTION_UP && learnSwallowed.remove(e.keyCode)) return true
        val result = when (e.action) {
            KeyEvent.ACTION_DOWN -> controls.onKeyDown(e.keyCode, e.repeatCount, now)
            KeyEvent.ACTION_UP -> controls.onKeyUp(e.keyCode, now)
            else -> DriveResult.PASS
        }
        if (!typing) {
            inspector.key(e, "activity", describe(result))
            if (!showingPad) inspector.scheduleAutoUpload()
        }
        if (result.consumed) {
            perform(result)
            return true
        }
        return super.dispatchKeyEvent(e)
    }

    override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean {
        if (ev.action == MotionEvent.ACTION_SCROLL) {
            inspector.scroll(ev, "activity")
            if (!showingPad) inspector.scheduleAutoUpload()
            val rotary = ev.getAxisValue(MotionEvent.AXIS_SCROLL)
            val delta = if (rotary != 0f) rotary else if (ev.source and InputDevice.SOURCE_ROTARY_ENCODER != 0) ev.getAxisValue(MotionEvent.AXIS_HSCROLL) else 0f
            if (delta != 0f) {
                val r = controls.onScroll(delta, SystemClock.uptimeMillis())
                if (r.consumed) {
                    perform(r)
                    return true
                }
            }
        }
        return super.dispatchGenericMotionEvent(ev)
    }

    /** MediaSession media-button route: same state machine, same swallow rules. */
    private fun sessionKey(code: Int, action: Int, repeat: Int, ev: KeyEvent): Boolean {
        val now = SystemClock.uptimeMillis()
        val target = learning
        if (target != null && action == KeyEvent.ACTION_DOWN && repeat == 0 && code !in Keys.PROTECTED) {
            inspector.key(ev, "session-learn", target.name)
            learnKey(code, target)
            learnSwallowed += code
            return true
        }
        if (action == KeyEvent.ACTION_UP && learnSwallowed.remove(code)) return true
        val result = when (action) {
            KeyEvent.ACTION_DOWN -> controls.onKeyDown(code, repeat, now)
            KeyEvent.ACTION_UP -> controls.onKeyUp(code, now)
            else -> DriveResult.PASS
        }
        inspector.key(ev, "session", describe(result))
        if (!showingPad) inspector.scheduleAutoUpload()
        if (result.consumed) perform(result)
        return result.consumed
    }

    /** Transport-control callbacks (the car's own media UI pressing our session): log, and treat as a press. */
    private fun sessionCallback(name: String, code: Int?) {
        inspector.session(name, code)
        if (!showingPad) inspector.scheduleAutoUpload()
        if (code == null) return
        val r = controls.onCommand(code, SystemClock.uptimeMillis())
        if (r.consumed) perform(r)
    }

    private fun perform(r: DriveResult) {
        lastWheelAt = SystemClock.elapsedRealtime()
        val action = r.action
        if (action != null) {
            pad.control(action, "wheel")
            return
        }
        if (r.refusal == Refusal.RECORDING_LOCKED && speaking()) {
            // Never deferred: said after the note it would be nonsense, said during it, it would be in the memo.
            voice.cue("cue:locked:${SystemClock.elapsedRealtime()}", SpeechKind.CUE,
                listOf(SpeechPart.Tone(DriveSpeech.Tone.ERROR), SpeechPart.Say("Recording. Stop first.")), 2_000L, group = "locked", deferrable = false)
        }
    }

    private fun onPadEvent(ev: PadEvent) {
        controls.onPadEvent(ev.type)
        if (!speaking()) return
        val parts = ArrayList<SpeechPart>()
        DriveSpeech.toneFor(ev)?.let { parts += SpeechPart.Tone(it) }
        DriveSpeech.forEvent(ev)?.let { parts += SpeechPart.Say(it) }
        if (parts.isEmpty()) return
        val id = "${ev.type}:${SystemClock.elapsedRealtime()}"
        when (ev.type) {
            // The instant ack: queued while the mic is still closing, said the moment it is closed (no server).
            // Both belong to the note just recorded (STOP tone + "Got it", then the SENT tone): they go before what the
            // recording held back, however long the upload took. A "sent" with no open note is an older note's retry.
            "stopped" -> voice.cue("ack:$id", SpeechKind.ACK, parts, SpeechArbiter.ACK_WAIT_MS, note = voice.arbiter.noteStopped())
            "sent" -> {
                val note = if (ev.reason == "retry") null else voice.arbiter.noteSent()
                voice.cue("ack:$id", SpeechKind.ACK, parts, if (note != null) SpeechArbiter.SENT_WAIT_MS else SpeechArbiter.ACK_WAIT_MS, note = note)
            }
            // A newer selection replaces an older one that has not been said yet; a stale name is dropped.
            "selected" -> voice.cue("cue:$id", SpeechKind.CUE, parts, SpeechArbiter.SELECT_WAIT_MS, group = "select")
            // "Recording. Stop first." belongs to the moment; it is never said into or after the note.
            "refused" -> voice.cue("cue:$id", SpeechKind.CUE, parts, 2_000L, group = "refused", deferrable = ev.reason != "recording")
            else -> voice.cue("cue:$id", SpeechKind.CUE, parts, SpeechArbiter.CUE_WAIT_MS)
        }
    }

    /**
     * Say "Recording for X" and beep, then let the page open the mic: the announcement must not end up in the memo.
     * Either way the speech queue is held (anything playing stops) from now until the mic closes.
     */
    private fun announceRecording(name: String, go: () -> Unit): Boolean {
        val prompt = if (speaking()) listOf(SpeechPart.Say(DriveSpeech.recordingStart(name)), SpeechPart.Tone(DriveSpeech.Tone.START)) else null
        voice.arm(prompt, go)
        return true
    }

    private fun learnKey(code: Int, action: DriveAction) {
        learning = null
        controls.mapping = controls.mapping.bind(code, action)
        settings.mapping = controls.mapping
        inspector.note("learned ${KeyEvent.keyCodeToString(code)} -> ${action.name}")
        render()
        report("${KeyEvent.keyCodeToString(code)} now means ${action.name}")
        inspector.scheduleAutoUpload()
    }

    private fun inspectorInfoText() =
        "Install source: ${installSource()} (distraction-optimized only honoured from ${PLAY_STORE}) · session held: ${wheelSession?.held == true}"

    private fun refreshInspector() {
        inspectorInfo?.text = inspectorInfoText()
        inspectorLog?.text = inspector.buffer.recent(LOG_LINES).asReversed().joinToString("\n") { it.substringAfter('T').take(200) }
    }

    private fun buildInspector(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(0, 16, 0, 16)
        fun text(t: String, size: Float = 16f) = TextView(this@MainActivity).apply {
            this.text = t
            textSize = size
            setTextColor(Color.rgb(238, 243, 255))
            setPadding(0, 8, 0, 8)
        }
        fun btn(t: String, action: () -> Unit) = Button(this@MainActivity).apply {
            text = t
            isAllCaps = false
            minHeight = 56
            setOnClickListener { action() }
        }
        addView(text("Steering wheel control", 22f))
        addView(btn("Wheel control + media session: ${if (settings.wheelControl) "ON" else "OFF"}") {
            settings.wheelControl = !settings.wheelControl
            syncWheel()
            render()
        })
        addView(btn("Spoken feedback: ${if (settings.spokenFeedback) "ON" else "OFF"}") {
            settings.spokenFeedback = !settings.spokenFeedback
            render()
        })
        inspectorInfo = text(inspectorInfoText())
        addView(inspectorInfo)
        addView(text("Key inspector: press every wheel button once. Lines are logged (tag HoloceneKeys) and uploaded after 6 s of quiet."))
        addView(text(if (learning != null) "Press the wheel button for ${learning?.name} now…" else "Learn a button:"))
        for ((label, action) in listOf("Previous agent" to DriveAction.SELECT_PREV, "Next agent" to DriveAction.SELECT_NEXT, "Record / stop" to DriveAction.TOGGLE_RECORD, "Cancel note" to DriveAction.CANCEL)) {
            addView(btn("Learn: $label") {
                learning = action
                render()
            })
        }
        val editor = EditText(this@MainActivity).apply {
            setText(controls.mapping.serialize().replace(";", "\n"))
            textSize = 14f
            typeface = android.graphics.Typeface.MONOSPACE
            setTextColor(Color.rgb(238, 243, 255))
            setBackgroundColor(Color.rgb(24, 32, 56))
            setPadding(16, 12, 16, 12)
            minLines = 4
            isSingleLine = false
        }
        addView(editor)
        addView(btn("Save mapping text (KEY=ACTION, L prefix = hold)") {
            val parsed = KeyMapping.parse(editor.text.toString())
            controls.mapping = parsed.mapping
            settings.mapping = parsed.mapping
            inspector.note("mapping saved")
            render()
            report(if (parsed.errors.isEmpty()) "Mapping saved" else "Mapping saved; skipped: ${parsed.errors.joinToString("; ")}")
        })
        addView(btn("Reset mapping to defaults") {
            settings.resetMapping()
            controls.mapping = KeyMapping.DEFAULT
            render()
            report("Mapping reset")
        })
        addView(btn("Upload key log now") {
            inspector.upload { result -> report(result) }
        })
        inspectorLog = TextView(this@MainActivity).apply {
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            setTextColor(Color.rgb(170, 200, 255))
        }
        addView(inspectorLog)
        refreshInspector()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (StopKeys.isStop(keyCode)) {
            probe("key_stop", "key=${KeyEvent.keyCodeToString(keyCode)} simulated_diagnostic=true")
            cancelDiagnostic("Stopped by key ${KeyEvent.keyCodeToString(keyCode)}; nothing published", "key")
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        pad.onResume()
        refreshPad()
        syncWheel()
        if (carHost != null && settings.spokenFeedback) voice.feedback.prepare()
        // Permission prompts are "setup": ask once while parked so a first recording never needs one while driving.
        if (carHost != null && mode() == PadMode.PARKED && !askedMic && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            askedMic = true
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_PREGRANT_MIC)
        }
    }

    override fun onPause() {
        resumed = false
        syncWheel() // hands the media keys back to the radio
        voice.dropFeedback()
        pad.interruptStart()
        // Leaving the screen (a wheel "Source" key opening the car's own UI, say) must not strand the lines just
        // pressed: send them now instead of waiting for a timer that onPause would cancel.
        inspector.cancelAutoUpload()
        if (inspector.buffer.hasPending()) inspector.upload(null)
        cancelDiagnostic("Activity paused; capture cancelled", "pause")
        pad.onPause()
        super.onPause()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        pad.onPermissionsResult(requestCode, grantResults)
    }

    @Suppress("DEPRECATION") // Plain Activity back handling; no AndroidX OnBackPressedDispatcher.
    override fun onBackPressed() {
        if (showingPad && pad.goBack()) return
        super.onBackPressed()
    }

    override fun onDestroy() {
        wheelSession?.release()
        voice.shutdown()
        inspector.shutdown()
        pad.destroy()
        session.cancel()
        releaseAll("Activity destroyed")
        main.removeCallbacksAndMessages(null)
        carHost?.disconnect()
        carHost = null
        super.onDestroy()
    }

    private companion object {
        const val TAG = "HoloceneProbe"
        const val PRIVACY_POLICY_URL = "https://holocene.delo.sh/auto/privacy"
        const val PLAY_STORE = "com.android.vending"
        const val WHEEL_RECENT_MS = 4000L
        const val LOG_LINES = 25
        const val REQUEST_PREGRANT_MIC = 4
        const val EXTRA_PAD_URL = "sh.delo.holocene.extra.PAD_URL"
        const val EXTRA_RUN_MIC = "sh.delo.holocene.extra.RUN_MIC"
        const val EXTRA_RUN_ASR = "sh.delo.holocene.extra.RUN_ASR"
        const val SAMPLE_RATE = 16000
        const val MIC_WINDOW_MS = 6000L
        const val HOST_SETTLE_MS = 1500L
        const val HOST_WAIT_STEP_MS = 500L
        const val HOST_WAIT_ATTEMPTS = 12 // 6 s more
        const val ASR_BOUND_MS = 15000L
        const val TTS_BOUND_MS = 10000L
    }
}
