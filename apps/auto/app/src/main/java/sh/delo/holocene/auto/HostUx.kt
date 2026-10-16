package sh.delo.holocene.auto

/**
 * What the car host asks of the UI right now, as plain values (no android.car types): CarHost.kt is the
 * only file allowed to touch the car library and hands this out. The flag values mirror
 * android.car.drivingstate.CarUxRestrictions.UX_RESTRICTIONS_*.
 */
data class HostUx(
    val requiresDo: Boolean,
    val mask: Int,
    val maxStringLength: Int = 0,
    val maxItems: Int = 0,
    val maxDepth: Int = 0,
) {
    /** Parked: nothing is restricted. Anything else is driving (or unknown) and gets the driving layout. */
    val unrestricted: Boolean get() = !requiresDo && mask == NONE

    val noVideo: Boolean get() = mask and NO_VIDEO != 0
    val noText: Boolean get() = mask and (NO_TEXT_MESSAGE or NO_VOICE_TRANSCRIPTION) != 0
    val noKeyboard: Boolean get() = mask and (NO_KEYBOARD or NO_DIALPAD or NO_FILTERING) != 0
    val noSetup: Boolean get() = mask and NO_SETUP != 0
    val limitContent: Boolean get() = mask and LIMIT_CONTENT != 0

    /** Longest label to show, or 0 for no limit. Only meaningful when LIMIT_STRING_LENGTH is active. */
    val maxLabel: Int get() = if (mask and LIMIT_STRING_LENGTH != 0 && maxStringLength > 0) maxStringLength else 0

    companion object {
        const val NONE = 0
        const val NO_DIALPAD = 1
        const val NO_FILTERING = 1 shl 1
        const val LIMIT_STRING_LENGTH = 1 shl 2
        const val NO_KEYBOARD = 1 shl 3
        const val NO_VIDEO = 1 shl 4
        const val LIMIT_CONTENT = 1 shl 5
        const val NO_SETUP = 1 shl 6
        const val NO_TEXT_MESSAGE = 1 shl 7
        const val NO_VOICE_TRANSCRIPTION = 1 shl 8
        const val FULLY_RESTRICTED = 0x1ff

        /** Not connected, car service missing, or the callback failed: assume the strictest state. */
        val UNKNOWN = HostUx(requiresDo = true, mask = FULLY_RESTRICTED)

        /** A phone or an unrestricted (parked) host. */
        val PARKED = HostUx(requiresDo = false, mask = NONE)
    }
}

/** The two Agent Pad layouts. Driving is the safe default whenever a car host is not provably parked. */
enum class PadMode { PARKED, DRIVING }

object PadModes {
    /** Phones are always PARKED; a car host is PARKED only while it reports no restrictions at all. */
    fun of(isCarHost: Boolean, ux: HostUx): PadMode =
        if (!isCarHost || ux.unrestricted) PadMode.PARKED else PadMode.DRIVING

    /** Diagnostics (probes, key inspector, settings) are for a stopped car or a desk phone only. */
    fun diagnosticsAllowed(mode: PadMode): Boolean = mode == PadMode.PARKED
}
