package sh.delo.holocene.auto

internal enum class AutoScreen { HOME, DIAGNOSTICS, ABOUT }
internal enum class AutoHostState { UNKNOWN, UNAVAILABLE, RESTRICTED, UNRESTRICTED }

internal data class VoiceAvailability(val enabled: Boolean, val explanation: String)

/** The same navigation/lifecycle boundary used by the Activity and the JVM regressions. */
internal class AutoSurface(
    private val session: DiagnosticSession,
    private val releaseResources: (String, Boolean) -> Unit,
) {
    var lastResult = "No diagnostic run yet"
        private set

    fun recordResult(message: String) { lastResult = message }

    var screen = AutoScreen.HOME
        private set
    var host = AutoHostState.UNKNOWN
        private set
    var foreground = false
        private set

    val hostAllowsInteraction get() = foreground && host == AutoHostState.UNRESTRICTED
    val busy get() = session.phase == DiagnosticPhase.CAPTURING || session.phase == DiagnosticPhase.ACKNOWLEDGING

    fun voiceAvailability(providerAvailable: Boolean, microphoneGranted: Boolean): VoiceAvailability = when {
        host == AutoHostState.UNKNOWN -> VoiceAvailability(false, "Waiting for car safety status. Voice is unavailable.")
        host == AutoHostState.UNAVAILABLE -> VoiceAvailability(false, "Car safety status is unavailable. Voice is disabled on this device.")
        host == AutoHostState.RESTRICTED -> VoiceAvailability(false, "The car is restricting interaction. Voice is unavailable.")
        !foreground -> VoiceAvailability(false, "Voice is unavailable while the app is away.")
        !providerAvailable -> VoiceAvailability(false, "No Android speech service is available. See Diagnostics.")
        !microphoneGranted -> VoiceAvailability(false, "Microphone permission is needed. Open Diagnostics to allow it.")
        busy -> VoiceAvailability(false, if (session.phase == DiagnosticPhase.CAPTURING) "Listening. Cancel to stop the check." else "Playing the local acknowledgement. Cancel to stop.")
        else -> VoiceAvailability(true, "Uses Android speech and a local acknowledgement. Does not contact agents.")
    }

    fun canCapture(microphoneGranted: Boolean) = hostAllowsInteraction && microphoneGranted && !busy

    fun canOpenPrivacy(isAutomotive: Boolean) = foreground && (!isAutomotive || host == AutoHostState.UNRESTRICTED)

    fun navigate(destination: AutoScreen): Boolean {
        if (destination == screen) return false
        stop("Screen changed; diagnostic cancelled")
        screen = destination
        return true
    }

    fun back(): Boolean = if (screen == AutoScreen.HOME) false else navigate(AutoScreen.HOME)

    fun updateHost(state: AutoHostState) {
        host = state
        if (state != AutoHostState.UNRESTRICTED) {
            val wasActive = busy
            session.restricted()
            release("Car restricted or unavailable; diagnostic stopped", wasActive)
        }
    }

    fun resume() { foreground = true }

    fun pause() {
        foreground = false
        stop("Activity paused; diagnostic cancelled")
    }

    fun destroy() {
        foreground = false
        host = AutoHostState.UNKNOWN
        val wasActive = busy
        session.restricted()
        release("Activity destroyed; diagnostic cancelled", wasActive)
    }

    private fun release(reason: String, wasActive: Boolean) {
        if (wasActive) recordResult(reason)
        releaseResources(reason, wasActive)
    }

    private fun stop(reason: String) {
        val wasActive = session.cancel()
        release(reason, wasActive)
    }
}
