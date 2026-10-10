package sh.delo.holocene.auto

import android.Manifest
import android.app.Activity
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
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
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
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
    private val surface = AutoSurface(session) { reason, recordResult -> releaseAll(reason, recordResult = recordResult) }
    private var hasRunDiagnostic = false
    private var hostEvidence = "Car safety status unknown"
    private val captureButtons = ArrayList<Pair<Button, () -> Boolean>>()
    private var homeVoice: Button? = null
    private var homeVoiceStatus: TextView? = null
    private var homeCancel: Button? = null
    private var runtimeStatus: TextView? = null
    private lateinit var scroll: ScrollView
    private var unregisterBack: () -> Unit = {}
    private lateinit var body: LinearLayout
    private lateinit var status: TextView
    private var carHost: CarHost? = null
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
        scroll = ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(themeColor(android.R.attr.colorBackground))
        }
        body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(32), dp(24), dp(32), dp(24))
        }
        scroll.addView(body, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        // Keep Honda/OS chrome. Account for bars and cutouts rather than covering them.
        scroll.setOnApplyWindowInsetsListener { view, insets ->
            val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            insets
        }
        setContentView(scroll)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val dispatcher = onBackInvokedDispatcher
            val callback = android.window.OnBackInvokedCallback { handleBack() }
            dispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
            unregisterBack = { dispatcher.unregisterOnBackInvokedCallback(callback) }
        }
        scroll.requestApplyInsets()
        render()
        connectHost()
        scheduleDiagnosticIntent(intent)
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()

    private fun themeColor(attribute: Int): Int = obtainStyledAttributes(intArrayOf(attribute)).let {
        val color = it.getColor(0, 0)
        it.recycle()
        color
    }

    private fun label(text: String, size: Float = BODY_SP, heading: Boolean = false): TextView = TextView(this).apply {
        this.text = text
        textSize = size // TextView uses sp, including the operator's font scale.
        setTextColor(themeColor(android.R.attr.textColorPrimary))
        setPadding(0, dp(8), 0, dp(8))
        isAccessibilityHeading = heading
        body.addView(this, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    private fun button(text: String, primary: Boolean = false, enabled: Boolean = true, action: () -> Unit): Button {
        val control = if (primary) Button(this) else Button(this, null, android.R.attr.borderlessButtonStyle)
        control.apply {
            this.text = text
            textSize = BODY_SP
            isAllCaps = false
            minHeight = dp(64)
            minimumWidth = dp(48)
            setPadding(dp(16), dp(12), dp(16), dp(12))
            isEnabled = enabled
            if (primary) {
                backgroundTintList = ColorStateList.valueOf(themeColor(android.R.attr.colorAccent))
                setTextColor(themeColor(android.R.attr.colorBackground))
                alpha = if (enabled) 1f else 0.5f
            }
            setOnClickListener { action() }
        }
        body.addView(control, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(8)
            bottomMargin = dp(4)
        })
        return control
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
        surface.recordResult(message)
        if (surface.screen == AutoScreen.DIAGNOSTICS && ::status.isInitialized) status.text = message
        updateVoiceControls()
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
        captureButtons.clear()
        homeVoice = null
        homeVoiceStatus = null
        homeCancel = null
        runtimeStatus = null
        when (surface.screen) {
            AutoScreen.HOME -> renderHome()
            AutoScreen.DIAGNOSTICS -> renderDiagnostics()
            AutoScreen.ABOUT -> renderAbout()
        }
    }

    private fun renderHome() {
        label("Holocene Auto", TITLE_SP, heading = true)
        label("Agents disconnected", HEADING_SP, heading = true)
        label("Diagnostics only. Agent connections and replies are not available.")
        homeVoice = button("Local voice check", primary = true, enabled = false) { recognitionProbe() }
        homeVoiceStatus = label("").apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        homeCancel = button("Cancel voice check", enabled = surface.busy) {
            cancelDiagnostic("Voice check cancelled; nothing sent", "home")
        }
        button("Diagnostics") { navigate(AutoScreen.DIAGNOSTICS) }
        button("About & privacy") { navigate(AutoScreen.ABOUT) }
        updateVoiceControls()
    }

    private fun renderDiagnostics() {
        label("Diagnostics", TITLE_SP, heading = true)
        button("Back to home") { navigate(AutoScreen.HOME) }
        label("Local checks only. No agent messages are sent. Not approved for driving.")
        if (!surface.hostAllowsInteraction) {
            label(surface.voiceAvailability(false, false).explanation)
            status = label("Details and diagnostic controls are unavailable until the car allows interaction.")
            return
        }
        label("Voice & microphone", HEADING_SP, heading = true)
        label("Android speech service may process audio. Only its final transcript triggers the platform-local acknowledgement; it is not an agent reply.")
        label(surface.voiceAvailability(SpeechRecognizer.isRecognitionAvailable(this), microphoneGranted()).explanation)
        captureButtons += button("Allow microphone", enabled = !microphoneGranted()) { requestMicrophone() } to { surface.hostAllowsInteraction && !surface.busy && !microphoneGranted() }
        captureButtons += button("Probe microphone · 6 seconds", enabled = surface.canCapture(microphoneGranted())) { microphoneProbe() } to { surface.canCapture(microphoneGranted()) }
        captureButtons += button("Check final speech & local acknowledgement", enabled = surface.voiceAvailability(SpeechRecognizer.isRecognitionAvailable(this), microphoneGranted()).enabled) { recognitionProbe() } to { surface.voiceAvailability(SpeechRecognizer.isRecognitionAvailable(this), microphoneGranted()).enabled }
        button("Cancel capture, playback & preview") { cancelDiagnostic("Cancelled by screen; nothing published", "screen") }
        label("Last diagnostic result", HEADING_SP, heading = true)
        status = label(surface.lastResult, RAW_SP).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        label("Canned preview", HEADING_SP, heading = true)
        button("Preview canned input · never send", enabled = !surface.busy) {
            if (!surface.hostAllowsInteraction || surface.busy) return@button
            preview.select("fixture-thread-1")
            preview.finalTranscript("Summarize recent work")
            report("${preview.preview}\n${preview.state}")
        }.also { captureButtons += it to { surface.hostAllowsInteraction && !surface.busy } }
        label("Runtime & provider evidence", HEADING_SP, heading = true)
        label(hostEvidence, RAW_SP)
        val roles = getSystemService(RoleManager::class.java)
        label("Assistant role available=${roles.isRoleAvailable(RoleManager.ROLE_ASSISTANT)}, held=${roles.isRoleHeld(RoleManager.ROLE_ASSISTANT)}; no role change", RAW_SP)
        label("Recognition provider=${SpeechRecognizer.isRecognitionAvailable(this)}; on-device=${SpeechRecognizer.isOnDeviceRecognitionAvailable(this)}; microphone=${microphoneGranted()}", RAW_SP)
        label(recognitionProvider(), RAW_SP)
        runtimeStatus = label("Generation=${session.generation}; phase=${session.phase}; ignored late callbacks=${session.ignoredLate}", RAW_SP)
        label("Canned fixtures · not live agents", HEADING_SP, heading = true)
        for (agent in Fixtures.agents) {
            label("FIXTURE · ${agent.employee} · ${agent.state}\n${agent.runtime} / ${agent.nativeSession}\nObserved ${agent.observedAt} · read-only", RAW_SP)
        }
        for (event in Fixtures.normalized(Fixtures.events)) label(event, RAW_SP)
    }

    private fun renderAbout() {
        label("About & privacy", TITLE_SP, heading = true)
        button("Back to home") { navigate(AutoScreen.HOME) }
        label("Holocene Auto", HEADING_SP, heading = true)
        label("This build provides diagnostic checks and canned previews. It has no live agent connection and is not approved for driving.")
        label("Microphone checks do not save audio in this app. Voice checks use the selected Android speech service, which may process audio under its own policy. Acknowledgements come from Android text-to-speech, not Vox or an agent.")
        val automotive = packageManager.hasSystemFeature(PackageManager.FEATURE_AUTOMOTIVE)
        val allowed = surface.canOpenPrivacy(automotive)
        button("Open privacy policy", enabled = allowed) { openPrivacyPolicy() }
        if (!allowed) label("The privacy browser is unavailable until the car allows interaction.")
    }

    private fun navigate(destination: AutoScreen) {
        if (surface.navigate(destination)) {
            render()
            scroll.scrollTo(0, 0)
        }
    }

    private fun updateVoiceControls() {
        val availability = surface.voiceAvailability(SpeechRecognizer.isRecognitionAvailable(this), microphoneGranted())
        homeVoice?.apply {
            isEnabled = availability.enabled
            alpha = if (isEnabled) 1f else 0.5f
        }
        homeVoiceStatus?.text = if (availability.enabled && hasRunDiagnostic && !surface.busy) {
            "Check ended. See Diagnostics for the result. No agent was contacted."
        } else availability.explanation
        runtimeStatus?.text = "Generation=${session.generation}; phase=${session.phase}; ignored late callbacks=${session.ignoredLate}"
        homeCancel?.apply {
            visibility = if (surface.busy) View.VISIBLE else View.GONE
            isEnabled = surface.busy
        }
        // The action methods also recheck these gates before touching audio resources.
        captureButtons.forEach { (control, available) -> control.isEnabled = available() }
    }

    private fun openPrivacyPolicy() {
        if (!surface.canOpenPrivacy(packageManager.hasSystemFeature(PackageManager.FEATURE_AUTOMOTIVE))) {
            report("Privacy browser unavailable: car safety state restricted or unknown")
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
            surface.updateHost(AutoHostState.UNAVAILABLE)
            render()
            return
        }
        val host = CarHost(
            onUnrestrictedChange = { free ->
                unrestricted = free
                surface.updateHost(when {
                    free && carHost?.connected == true -> AutoHostState.UNRESTRICTED
                    carHost?.connected == true -> AutoHostState.RESTRICTED
                    else -> AutoHostState.UNAVAILABLE
                })
                render()
            },
            onStatus = { message -> hostEvidence = message; probe("host_status", message) },
        )
        carHost = host
        host.connect(this, main)
    }

    private fun microphoneGranted() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun requestMicrophone() {
        if (!surface.hostAllowsInteraction || surface.busy || microphoneGranted()) return
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
        report("Microphone permission requested; explicitly retry after grant")
    }

    private fun hasMicPermission(): Boolean {
        if (surface.hostAllowsInteraction && microphoneGranted()) return true
        report("Capture unavailable: check car safety status and microphone permission in Diagnostics")
        return false
    }

    private fun requestFocus(gain: Int, usage: Int, content: Int, stopsOnLoss: Boolean): Boolean {
        val token = session.generation
        var request: AudioFocusRequest? = null
        val created = AudioFocusRequest.Builder(gain)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(usage).setContentType(content).build())
            .setOnAudioFocusChangeListener { change ->
                probe("audio_focus_change", "change=$change")
                if (change <= 0 && stopsOnLoss && session.isActive(token) && focus === request) {
                    cancelDiagnostic("Focus lost; diagnostic cancelled", "focus-loss")
                }
            }.build()
        request = created
        focus = created
        val result = audio!!.requestAudioFocus(created)
        probe("audio_focus_request", "gain=$gain result=$result")
        return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun beginDiagnostic(): Int? {
        val token = session.begin(surface.canCapture(microphoneGranted()))
        if (token == null) {
            probe("begin_refused", "phase=${session.phase} unrestricted=$unrestricted")
            report("Diagnostic busy or host restricted; use Cancel first")
            return null
        }
        hasRunDiagnostic = true
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
                        report("Actual provider transcript: $text\n${preview.state}")
                        speakAcknowledgement(token, ack)
                    }
                }
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            engine.startListening(intent)
            report("Speech check started; waiting for the Android provider")
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

    private fun releaseAll(reason: String, clearPreview: Boolean = true, recordResult: Boolean = true) {
        capturing = false
        timers.removeCallbacksAndMessages(null)
        // Detach first: synchronous/late focus or engine callbacks cannot own a new run.
        val oldRecorder = recorder
        val oldRecognizer = recognizer
        val oldSpeech = speech
        val oldFocus = focus
        recorder = null
        recognizer = null
        speech = null
        focus = null
        oldRecorder?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        oldRecognizer?.let {
            runCatching { it.cancel() }
            runCatching { it.destroy() }
        }
        oldSpeech?.let {
            runCatching { it.stop() }
            runCatching { it.shutdown() }
        }
        oldFocus?.let { runCatching { audio?.abandonAudioFocusRequest(it) } }
        if (clearPreview) preview.cancel()
        probe("released", "reason=\"$reason\"")
        if (recordResult) report(reason) else updateVoiceControls()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (StopKeys.isStop(keyCode)) {
            probe("key_stop", "key=${KeyEvent.keyCodeToString(keyCode)} simulated_diagnostic=true")
            cancelDiagnostic("Stopped by key ${KeyEvent.keyCodeToString(keyCode)}; nothing published", "key")
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() { handleBack() }

    private fun handleBack() {
        if (surface.back()) {
            render()
            scroll.scrollTo(0, 0)
        } else {
            cancelDiagnostic("Leaving home; diagnostic cancelled", "back")
            finish()
        }
    }

    override fun onResume() {
        super.onResume()
        surface.resume()
        render()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 1) render() // Permission grants never auto-start recording.
    }

    override fun onPause() {
        surface.pause()
        super.onPause()
    }

    override fun onDestroy() {
        unregisterBack()
        surface.destroy()
        main.removeCallbacksAndMessages(null)
        carHost?.disconnect()
        carHost = null
        super.onDestroy()
    }

    private companion object {
        const val TITLE_SP = 34f
        const val HEADING_SP = 26f
        const val BODY_SP = 22f
        const val RAW_SP = 18f
        const val TAG = "HoloceneProbe"
        const val PRIVACY_POLICY_URL = "https://holocene.delo.sh/auto/privacy"
        const val EXTRA_RUN_MIC = "sh.delo.holocene.extra.RUN_MIC"
        const val EXTRA_RUN_ASR = "sh.delo.holocene.extra.RUN_ASR"
        const val SAMPLE_RATE = 16000
        const val MIC_WINDOW_MS = 6000L
        const val HOST_SETTLE_MS = 1500L
        const val ASR_BOUND_MS = 15000L
        const val TTS_BOUND_MS = 10000L
    }
}
