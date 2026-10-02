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
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.concurrent.thread
import kotlin.math.abs

class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val preview = VoicePreview()
    private lateinit var body: LinearLayout
    private lateinit var status: TextView
    private var car: Car? = null
    private var ux: CarUxRestrictionsManager? = null
    private var unrestricted = false
    private var recognizer: SpeechRecognizer? = null
    private var recorder: AudioRecord? = null
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

    private fun report(message: String) {
        Log.i("HoloceneProbe", message)
        status.text = message
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
        button("Probe microphone for 2 seconds (no audio saved)") { microphoneProbe() }
        button("Probe final ASR (parked screen activation)") { recognitionProbe() }
        button("Cancel diagnostic capture / unsent preview") { stopCapture("Cancelled; nothing published") }
        for (event in Fixtures.normalized(Fixtures.events)) label(event)
    }

    private fun connectHost() {
        try {
            car = Car.createCar(this, main, Car.CAR_WAIT_TIMEOUT_DO_NOT_WAIT) { connectedCar, ready ->
                if (!ready) {
                    unrestricted = false
                    stopCapture("Car service unavailable")
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
            preview.invalidateRoute()
            stopCapture("Host restricted; stopped")
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

    private fun acquireFocus(): Boolean {
        stopCapture("Preparing intentional capture")
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setOnAudioFocusChangeListener { change ->
                Log.i("HoloceneProbe", "audioFocusChange=$change")
                if (change <= 0) stopCapture("Focus lost; capture cancelled")
            }.build()
        focus = request
        val result = audio!!.requestAudioFocus(request)
        report("Capture audio focus result=$result")
        if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            stopCapture("Capture focus denied")
            return false
        }
        return true
    }

    private fun microphoneProbe() {
        if (!hasMicPermission() || !acquireFocus()) return
        try {
            val minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val record = AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.MIC)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(16000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(maxOf(minimum, 6400)).build()
            recorder = record
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                stopCapture("AudioRecord initialization failed")
                return
            }
            capturing = true
            record.startRecording()
            report("AudioRecord started; bounded 2-second capture; no persistence/upload")
            thread(name = "holocene-mic-probe") {
                var samples = 0
                var peak = 0
                var readError = 0
                val buffer = ShortArray(1600)
                try {
                    while (capturing && samples < 32000) {
                        val count = record.read(buffer, 0, buffer.size)
                        if (count <= 0) { readError = count; break }
                        samples += count
                        for (i in 0 until count) peak = maxOf(peak, abs(buffer[i].toInt()))
                    }
                } catch (error: Exception) { readError = AudioRecord.ERROR_INVALID_OPERATION }
                main.post {
                    if (recorder === record) stopCapture("Mic capture samples=$samples, peak=$peak, readError=$readError; silence is not real speech")
                }
            }
            main.postDelayed({ if (recorder === record) stopCapture("Mic probe timed out; no transcript") }, 3000)
        } catch (error: SecurityException) {
            stopCapture("Microphone permission revoked or unavailable")
        } catch (error: Exception) { stopCapture("Mic blocked: ${error.javaClass.simpleName}") }
    }

    private fun recognitionProbe() {
        if (!hasMicPermission()) return
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            report("ASR blocked: no installed recognition provider")
            return
        }
        if (!acquireFocus()) return
        preview.select("fixture-thread-1")
        try {
            val speech = SpeechRecognizer.createSpeechRecognizer(this)
            recognizer = speech
            speech.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) { report("ASR ready; intentional diagnostic capture") }
                override fun onBeginningOfSpeech() { report("Speech began") }
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() { report("ASR endpoint reported; awaiting final transcript") }
                override fun onError(error: Int) { stopCapture("ASR error=$error; no transcript/dispatch") }
                override fun onResults(results: Bundle?) {
                    val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                    val accepted = preview.finalTranscript(text)
                    stopCapture("ASR final result accepted=$accepted; diagnostic only", false)
                    if (accepted) status.text = "Actual provider transcript: $text\n${preview.state}"
                }
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            speech.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM).putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false))
            main.postDelayed({ if (recognizer === speech) stopCapture("ASR 15-second timeout; no final transcript") }, 15000)
        } catch (error: Exception) { stopCapture("ASR blocked: ${error.javaClass.simpleName}") }
    }

    private fun stopCapture(reason: String, clearPreview: Boolean = true) {
        capturing = false
        recorder?.let {
            try { it.stop() } catch (error: IllegalStateException) { Log.i("HoloceneProbe", "Recorder already stopped") }
            it.release()
        }
        recorder = null
        recognizer?.cancel()
        recognizer?.destroy()
        recognizer = null
        focus?.let { audio?.abandonAudioFocusRequest(it) }
        focus = null
        if (clearPreview) preview.cancel()
        if (::status.isInitialized) report(reason)
    }

    override fun onPause() {
        stopCapture("Activity paused; capture cancelled")
        super.onPause()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        stopCapture("Activity destroyed")
        ux?.unregisterListener()
        car?.disconnect()
        super.onDestroy()
    }
}
