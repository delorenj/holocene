package sh.delo.holocene.auto

import org.junit.Assert.*
import org.junit.Test

class CarHostLifecycleTest {
    @Test fun callbacksAreAcceptedBeforeRelease() {
        val gate = HostGate()
        assertFalse(gate.released)
        assertTrue(gate.accept())
    }

    @Test fun callbacksAreDiscardedAfterRelease() {
        val gate = HostGate()
        gate.release()
        assertTrue(gate.released)
        assertFalse(gate.accept())
    }

    @Test fun repeatedReleaseKeepsHostClosed() {
        val gate = HostGate()
        gate.release()
        gate.release()
        assertTrue(gate.released)
        assertFalse(gate.accept())
    }

    @Test fun queuedCallbackRechecksReleaseWhenDelivered() {
        val gate = HostGate()
        val acceptQueuedCallback = { gate.accept() }
        assertTrue(acceptQueuedCallback())
        gate.release()
        assertFalse(acceptQueuedCallback())
    }
}
