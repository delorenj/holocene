package sh.delo.holocene.auto

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.net.URI

/** Pure policy for the embedded Agent Pad page; no android.* so it is unit-testable. */
object AgentPadPolicy {
    const val URL = "https://agent-pad.delo.sh/"
    private const val HOST = "agent-pad.delo.sh"

    private val DEV_URL = Regex("""^http://(localhost|127\.0\.0\.1):([0-9]{1,5})/?$""")

    /**
     * [devUrl] is the one extra origin a debuggable build may load (see [devPadUrlOrNull]); the
     * production check is never loosened, a null [devUrl] is exactly the release policy.
     */
    fun isPadUrl(url: String?, devUrl: String? = null): Boolean {
        if (url.isNullOrBlank()) return false
        val uri = try { URI(url.trim()) } catch (e: Exception) { return false }
        if (uri.rawUserInfo != null) return false
        if (uri.scheme.equals("https", ignoreCase = true) &&
            uri.host.equals(HOST, ignoreCase = true) &&
            (uri.port == -1 || uri.port == 443)
        ) return true
        return devUrl != null && isDevOrigin(uri, devUrl)
    }

    private fun isDevOrigin(uri: URI, devUrl: String): Boolean {
        val dev = try { URI(devUrl) } catch (e: Exception) { return false }
        return uri.scheme.equals("http", ignoreCase = true) &&
            dev.scheme == "http" &&
            uri.host != null && uri.host.equals(dev.host, ignoreCase = true) &&
            uri.port == dev.port
    }

    /**
     * Debug-only Agent Pad dev-server override (intent extra). Returns the normalized
     * `http://localhost:<port>/` or `http://127.0.0.1:<port>/`, or null when the build is not
     * debuggable or the value is anything else. Nothing is persisted by callers.
     */
    fun devPadUrlOrNull(raw: String?, debuggable: Boolean): String? {
        if (!debuggable || raw == null) return null
        val m = DEV_URL.matchEntire(raw) ?: return null
        val port = m.groupValues[2].toIntOrNull() ?: return null
        if (port !in 1..65535) return null
        return "http://${m.groupValues[1]}:$port/"
    }

    fun mayGrantAudio(
        origin: String?,
        requestsAudioOnly: Boolean,
        micPermissionGranted: Boolean,
        padVisible: Boolean,
        devUrl: String? = null,
    ): Boolean = isPadUrl(origin, devUrl) && requestsAudioOnly && micPermissionGranted && padVisible

    /** Phones always; a car host only while parked/unrestricted. */
    fun padAllowed(isCarHost: Boolean, unrestricted: Boolean): Boolean = !isCarHost || unrestricted
}

/**
 * Pure lifecycle state for [AgentPadHost]: what fills the container, whether a mic is open, and
 * whether a native-mic permission prompt belongs to the page that is still on screen.
 */
class PadState {
    enum class Surface { NONE, WEB, MESSAGE }

    var surface = Surface.NONE
        private set
    var micLive = false
    var nativePending = false
        private set

    /** A message overlay is not a page: only a live WebView means "already showing". */
    fun needsWebView(): Boolean = surface != Surface.WEB
    fun webShown() { surface = Surface.WEB }
    fun messageShown() { surface = Surface.MESSAGE }

    fun requestNative() { nativePending = true }

    /** True only if the page that asked is still the one on screen; consumed either way. */
    fun takeNativePending(): Boolean {
        val was = nativePending && surface == Surface.WEB
        nativePending = false
        return was
    }

    fun reset() {
        surface = Surface.NONE
        micLive = false
        nativePending = false
    }
}

/** Owns one WebView showing Agent Pad inside [container]; torn down whenever the pad is not allowed or visible. */
class AgentPadHost(
    private val activity: Activity,
    private val container: FrameLayout,
    /** Debug-only validated dev-server origin from [AgentPadPolicy.devPadUrlOrNull]; null in release. */
    private val devUrl: String? = null,
) {
    private var web: WebView? = null
    private var held: PermissionRequest? = null
    private var visible = false
    private val state = PadState()
    private val recorder = NativeRecorder(activity.applicationContext).also { rec ->
        rec.onAutoStopped = { activity.runOnUiThread { finishNative() } }
    }

    fun show() {
        if (!state.needsWebView()) return
        // A "parked only" or "unreachable" message is not a page; drop it before building one.
        if (state.surface == PadState.Surface.MESSAGE) teardown()
        val view = try {
            makeWebView()
        } catch (e: Exception) {
            Log.w(TAG, "WebView unavailable: ${e.javaClass.simpleName}")
            message("Agent Pad needs the Android System WebView, which is not available on this device.", retry = false)
            return
        }
        web = view
        state.webShown()
        container.removeAllViews()
        container.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        visible = true
        view.loadUrl(devUrl ?: AgentPadPolicy.URL)
    }

    fun message(text: String, retry: Boolean) {
        teardown()
        val box = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            setBackgroundColor(Color.rgb(11, 16, 32))
            addView(TextView(activity).apply {
                this.text = text
                textSize = 20f
                gravity = Gravity.CENTER
                setTextColor(Color.rgb(238, 243, 255))
            })
            if (retry) addView(Button(activity).apply {
                this.text = "Retry"
                isAllCaps = false
                minHeight = 56
                setOnClickListener { teardown(); show() }
            })
        }
        state.messageShown()
        container.removeAllViews()
        container.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    fun teardown() {
        visible = false
        state.reset()
        recorder.cancel()
        held?.let { try { it.deny() } catch (e: RuntimeException) { Log.i(TAG, "Held request already gone") } }
        held = null
        web?.let {
            try {
                it.stopLoading()
                it.loadUrl("about:blank")
                it.onPause()
                it.removeAllViews()
                // destroy() on a still-attached WebView logs a warning and kills the renderer mid-frame.
                (it.parent as? ViewGroup)?.removeView(it)
                it.destroy()
            } catch (e: RuntimeException) { Log.i(TAG, "WebView teardown: ${e.javaClass.simpleName}") }
        }
        web = null
        container.removeAllViews()
    }

    fun onResume() {
        val view = web ?: return
        view.onResume()
        view.resumeTimers()
        visible = true
    }

    /** Backgrounding must not leave the mic open: drop the page if it was capturing, else just pause it. */
    fun onPause() {
        val view = web ?: return
        visible = false
        if (state.micLive) { teardown(); return }
        // No pauseTimers(): it is process-global and a teardown while paused would leave a later
        // page with frozen timers (the 15s reply poll). onPause() already stops rendering.
        view.onPause()
    }

    fun destroy() = teardown()

    fun goBack(): Boolean {
        val view = web ?: return false
        if (!view.canGoBack()) return false
        view.goBack()
        return true
    }

    fun onPermissionsResult(requestCode: Int, grants: IntArray) {
        if (requestCode == REQUEST_NATIVE_MIC) {
            val ok = grants.isNotEmpty() && grants[0] == PackageManager.PERMISSION_GRANTED
            // Only the page that asked (still on screen) gets an answer; a stale result is dropped.
            if (!state.takeNativePending() || web == null) return
            if (ok) startNative()
            else js("window.__hnStarted && window.__hnStarted(false, 'permission_denied')")
            return
        }
        if (requestCode != REQUEST_AUDIO) return
        val request = held ?: return
        held = null
        val granted = grants.isNotEmpty() && grants[0] == PackageManager.PERMISSION_GRANTED
        // The system dialog paused the activity (visible=false) and the result is delivered before
        // onResume, so judge by "page still alive", not by the momentary visible flag.
        resolve(request, granted, web != null)
    }

    private fun resolve(request: PermissionRequest, micGranted: Boolean, padAlive: Boolean = visible && web != null) {
        val ok = AgentPadPolicy.mayGrantAudio(request.origin.toString(), audioOnly(request), micGranted, padAlive, devUrl)
        try {
            if (ok) { state.micLive = true; request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) } else request.deny()
        } catch (e: RuntimeException) { Log.i(TAG, "Permission request already resolved") }
    }

    private fun js(script: String) { web?.evaluateJavascript(script, null) }

    private fun startNative() {
        val err = recorder.start()
        state.micLive = err == null
        js("window.__hnStarted && window.__hnStarted(${err == null}, '${err ?: ""}')")
    }

    /** Native capture for the pad: WebView getUserMedia loops on AAudio disconnects on the Honda audio stack. */
    private inner class NativeBridge {
        @JavascriptInterface fun start() {
            activity.runOnUiThread {
                if (web == null) return@runOnUiThread
                if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startNative()
                else {
                    state.requestNative()
                    activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_NATIVE_MIC)
                }
            }
        }

        @JavascriptInterface fun stop() {
            activity.runOnUiThread { finishNative() }
        }

        /** Fallback getUserMedia path: the page reports its stream closed so backgrounding stops reloading it. */
        @JavascriptInterface fun micClosed() {
            activity.runOnUiThread { state.micLive = false }
        }
    }

    private fun finishNative() {
        val bytes = recorder.stop()
        state.micLive = false
        val b64 = if (bytes == null) "" else Base64.encodeToString(bytes, Base64.NO_WRAP)
        js("window.__hnStopped && window.__hnStopped('$b64', 'audio/ogg')")
    }

    private fun audioOnly(request: PermissionRequest) =
        request.resources.size == 1 && request.resources[0] == PermissionRequest.RESOURCE_AUDIO_CAPTURE

    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWebView(): WebView = WebView(activity).apply {
        // Debuggable builds only: lets chrome://inspect on the host attach to this WebView.
        if (activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        setBackgroundColor(Color.rgb(11, 16, 32))
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        addJavascriptInterface(NativeBridge(), "HoloceneNative")
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !AgentPadPolicy.isPadUrl(request.url.toString(), devUrl)

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) failed("error ${error.errorCode}")
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame) failed("HTTP ${response.statusCode}")
            }

            /** Without this a renderer crash or OOM-kill takes the whole app down; show Retry instead. */
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "Agent Pad renderer gone, crashed=${detail.didCrash()}")
                if (view === web) container.post { if (web === view) message("Agent Pad stopped unexpectedly", retry = true) }
                return true
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                activity.runOnUiThread {
                    val ok = AgentPadPolicy.isPadUrl(request.origin.toString(), devUrl) && audioOnly(request) && visible && web != null
                    if (!ok) { request.deny(); return@runOnUiThread }
                    held?.deny()
                    if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        resolve(request, true)
                    } else {
                        held = request
                        activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_AUDIO)
                    }
                }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (held === request) held = null
            }
        }
    }

    private fun failed(why: String) {
        Log.w(TAG, "Agent Pad load failed: $why")
        container.post { if (web != null) message("Agent Pad unreachable ($why)", retry = true) }
    }

    companion object {
        const val REQUEST_AUDIO = 2
        const val REQUEST_NATIVE_MIC = 3
        private const val TAG = "HoloceneAgentPad"
    }
}
