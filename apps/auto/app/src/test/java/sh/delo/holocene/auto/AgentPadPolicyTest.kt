package sh.delo.holocene.auto

import org.junit.Assert.*
import org.junit.Test

class AgentPadPolicyTest {
    @Test fun padUrlsAreAccepted() {
        for (url in listOf(
            "https://agent-pad.delo.sh/",
            "https://agent-pad.delo.sh",
            "https://agent-pad.delo.sh/assets/index.js?x=1#y",
            "HTTPS://AGENT-PAD.DELO.SH/",
            "https://agent-pad.delo.sh:443/",
        )) assertTrue(url, AgentPadPolicy.isPadUrl(url))
        assertTrue(AgentPadPolicy.isPadUrl(AgentPadPolicy.URL))
    }

    @Test fun lookalikesAndOtherSchemesAreRejected() {
        for (url in listOf(
            null, "", " ", "about:blank", "javascript:alert(1)", "file:///etc/passwd",
            "http://agent-pad.delo.sh/",
            "https://agent-pad.delo.sh@evil.com/",
            "https://user:pw@agent-pad.delo.sh/",
            "https://evil.com/agent-pad.delo.sh",
            "https://evil.com/?u=https://agent-pad.delo.sh/",
            "https://x.agent-pad.delo.sh/",
            "https://agent-pad.delo.sh.evil.com/",
            "https://evilagent-pad.delo.sh/",
            "https://agent-pad.delo.sh./",
            "https://agent-pad.delo.sh:8443/",
            "https://delo.sh/",
            "https://s3.delo.sh/holocene-auto",
            "https://agent-pad.delo.sh\\@evil.com/",
            "//agent-pad.delo.sh/",
            "agent-pad.delo.sh",
        )) assertFalse(url.toString(), AgentPadPolicy.isPadUrl(url))
    }

    @Test fun audioGrantNeedsEveryCondition() {
        val pad = AgentPadPolicy.URL
        assertTrue(AgentPadPolicy.mayGrantAudio(pad, true, true, true))
        assertFalse(AgentPadPolicy.mayGrantAudio(pad, false, true, true))
        assertFalse(AgentPadPolicy.mayGrantAudio(pad, true, false, true))
        assertFalse(AgentPadPolicy.mayGrantAudio(pad, true, true, false))
        assertFalse(AgentPadPolicy.mayGrantAudio("https://evil.com/", true, true, true))
        assertFalse(AgentPadPolicy.mayGrantAudio(null, true, true, true))
        assertFalse(AgentPadPolicy.mayGrantAudio(pad, false, false, false))
    }

    @Test fun padAllowedOnPhonesAndParkedCarsOnly() {
        assertTrue(AgentPadPolicy.padAllowed(isCarHost = false, unrestricted = false))
        assertTrue(AgentPadPolicy.padAllowed(isCarHost = false, unrestricted = true))
        assertTrue(AgentPadPolicy.padAllowed(isCarHost = true, unrestricted = true))
        assertFalse(AgentPadPolicy.padAllowed(isCarHost = true, unrestricted = false))
    }
}

class PadStateTest {
    @Test fun messageOverlayDoesNotBlockBuildingThePage() {
        val s = PadState()
        // car host not yet unrestricted: "available when parked" overlay
        s.messageShown()
        assertTrue("restricted->parked flip must be able to build the page", s.needsWebView())
        s.webShown()
        assertFalse(s.needsWebView())
        // parked -> driving -> parked
        s.reset(); s.messageShown()
        assertTrue(s.needsWebView())
    }

    @Test fun staleNativePermissionResultIsDropped() {
        val s = PadState()
        s.webShown(); s.requestNative()
        s.reset(); s.webShown() // page torn down and rebuilt while the prompt was open
        assertFalse(s.takeNativePending())
    }

    @Test fun nativePermissionResultIsConsumedOnce() {
        val s = PadState()
        s.webShown(); s.requestNative()
        assertTrue(s.takeNativePending())
        assertFalse(s.takeNativePending())
    }

    @Test fun resetClearsMic() {
        val s = PadState()
        s.webShown(); s.micLive = true
        s.reset()
        assertFalse(s.micLive)
        assertEquals(PadState.Surface.NONE, s.surface)
    }
}
