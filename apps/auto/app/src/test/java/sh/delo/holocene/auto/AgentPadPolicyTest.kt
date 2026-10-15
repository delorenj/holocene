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

    @Test fun devUrlAcceptedOnlyWhenDebuggableAndLocal() {
        assertEquals("http://localhost:5173/", AgentPadPolicy.devPadUrlOrNull("http://localhost:5173/", true))
        assertEquals("http://localhost:5173/", AgentPadPolicy.devPadUrlOrNull("http://localhost:5173", true))
        assertEquals("http://127.0.0.1:8080/", AgentPadPolicy.devPadUrlOrNull("http://127.0.0.1:8080/", true))
        assertNull(AgentPadPolicy.devPadUrlOrNull("http://localhost:5173/", false))
        assertNull(AgentPadPolicy.devPadUrlOrNull(null, true))
    }

    @Test fun hostileDevUrlsAreRejected() {
        for (raw in listOf(
            "", "http://localhost/", "http://localhost:0/", "http://localhost:65536/", "http://localhost:99999999999/",
            "https://localhost:5173/", "http://localhost:5173/x", "http://localhost:5173/?a=1",
            "http://localhost:5173/#f", "http://user@localhost:5173/", "http://localhost:5173@evil.com/",
            "http://evil.com:5173/", "http://localhost.evil.com:5173/", "http://evillocalhost:5173/",
            "http://127.0.0.1.evil.com:5173/", "http://127.0.0.2:5173/", "http://0.0.0.0:5173/",
            "http://[::1]:5173/", "http://10.0.2.2:5173/", "http://localhost:5173\\@evil.com/",
            "http://localhost:5173/\n", " http://localhost:5173/", "javascript:alert(1)", "file:///etc/passwd", "https://agent-pad.delo.sh/",
        )) assertNull(raw, AgentPadPolicy.devPadUrlOrNull(raw, true))
    }

    @Test fun devOriginIsAcceptedOnlyWhenThreadedThrough() {
        val dev = "http://localhost:5173/"
        assertTrue(AgentPadPolicy.isPadUrl("http://localhost:5173/", dev))
        assertTrue(AgentPadPolicy.isPadUrl("http://localhost:5173/src/main.tsx?t=1", dev))
        assertTrue(AgentPadPolicy.isPadUrl(AgentPadPolicy.URL, dev))
        assertFalse(AgentPadPolicy.isPadUrl("http://localhost:5173/"))
        assertFalse(AgentPadPolicy.isPadUrl("http://localhost:5173/", null))
        assertFalse(AgentPadPolicy.isPadUrl("http://localhost:5174/", dev))
        assertFalse(AgentPadPolicy.isPadUrl("http://127.0.0.1:5173/", dev))
        assertFalse(AgentPadPolicy.isPadUrl("https://localhost:5173/", dev))
        assertFalse(AgentPadPolicy.isPadUrl("http://user@localhost:5173/", dev))
        assertFalse(AgentPadPolicy.isPadUrl("http://evil.com:5173/", dev))
    }

    @Test fun audioGrantHonorsDevOriginOnlyWhenGiven() {
        val dev = "http://localhost:5173/"
        assertTrue(AgentPadPolicy.mayGrantAudio(dev, true, true, true, dev))
        assertFalse(AgentPadPolicy.mayGrantAudio(dev, true, true, true))
        assertFalse(AgentPadPolicy.mayGrantAudio("http://localhost:5174/", true, true, true, dev))
        assertFalse(AgentPadPolicy.mayGrantAudio(dev, false, true, true, dev))
    }
}
