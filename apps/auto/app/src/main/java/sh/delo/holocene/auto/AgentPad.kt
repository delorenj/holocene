package sh.delo.holocene.auto

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Color
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
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

    fun isPadUrl(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        val uri = try { URI(url.trim()) } catch (e: Exception) { return false }
        return uri.scheme.equals("https", ignoreCase = true) &&
            uri.rawUserInfo == null &&
            uri.host.equals(HOST, ignoreCase = true) &&
            (uri.port == -1 || uri.port == 443)
    }

    fun mayGrantAudio(origin: String?, requestsAudioOnly: Boolean, micPermissionGranted: Boolean, padVisible: Boolean): Boolean =
        isPadUrl(origin) && requestsAudioOnly && micPermissionGranted && padVisible

    /** Phones always; a car host only while parked/unrestricted. */
    fun padAllowed(isCarHost: Boolean, unrestricted: Boolean): Boolean = !isCarHost || unrestricted
}

/** Owns one WebView showing Agent Pad inside [container]; torn down whenever the pad is not allowed or visible. */
class AgentPadHost(private val activity: Activity, private val container: FrameLayout) {
    private var web: WebView? = null
    private var overlay: View? = null
    private var held: PermissionRequest? = null
    private var micLive = false
    private var visible = false

    val showing get() = web != null || overlay != null

    fun show() {
        if (showing) return
        val view = try {
            makeWebView()
        } catch (e: Exception) {
            Log.w(TAG, "WebView unavailable: ${e.javaClass.simpleName}")
            message("Agent Pad needs the Android System WebView, which is not available on this device.", retry = false)
            return
        }
        web = view
        container.removeAllViews()
        container.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        visible = true
        view.loadUrl(AgentPadPolicy.URL)
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
        overlay = box
        container.removeAllViews()
        container.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    fun teardown() {
        visible = false
        micLive = false
        held?.let { try { it.deny() } catch (e: RuntimeException) { Log.i(TAG, "Held request already gone") } }
        held = null
        web?.let {
            try {
                it.stopLoading()
                it.loadUrl("about:blank")
                it.onPause()
                it.removeAllViews()
                it.destroy()
            } catch (e: RuntimeException) { Log.i(TAG, "WebView teardown: ${e.javaClass.simpleName}") }
        }
        web = null
        overlay = null
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
        if (micLive) { teardown(); return }
        view.onPause()
        view.pauseTimers()
    }

    fun destroy() = teardown()

    fun goBack(): Boolean {
        val view = web ?: return false
        if (!view.canGoBack()) return false
        view.goBack()
        return true
    }

    fun onPermissionsResult(requestCode: Int, grants: IntArray) {
        if (requestCode != REQUEST_AUDIO) return
        val request = held ?: return
        held = null
        val granted = grants.isNotEmpty() && grants[0] == PackageManager.PERMISSION_GRANTED
        resolve(request, granted)
    }

    private fun resolve(request: PermissionRequest, micGranted: Boolean) {
        val ok = AgentPadPolicy.mayGrantAudio(request.origin.toString(), audioOnly(request), micGranted, visible && web != null)
        try {
            if (ok) { micLive = true; request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) } else request.deny()
        } catch (e: RuntimeException) { Log.i(TAG, "Permission request already resolved") }
    }

    private fun audioOnly(request: PermissionRequest) =
        request.resources.size == 1 && request.resources[0] == PermissionRequest.RESOURCE_AUDIO_CAPTURE

    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWebView(): WebView = WebView(activity).apply {
        setBackgroundColor(Color.rgb(11, 16, 32))
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !AgentPadPolicy.isPadUrl(request.url.toString())

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) failed("error ${error.errorCode}")
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame) failed("HTTP ${response.statusCode}")
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                activity.runOnUiThread {
                    val ok = AgentPadPolicy.isPadUrl(request.origin.toString()) && audioOnly(request) && visible && web != null
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
        private const val TAG = "HoloceneAgentPad"
    }
}
