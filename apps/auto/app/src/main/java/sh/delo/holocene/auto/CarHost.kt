package sh.delo.holocene.auto

import android.car.Car
import android.car.drivingstate.CarUxRestrictions
import android.car.drivingstate.CarUxRestrictionsManager
import android.content.Context
import android.content.pm.PackageManager

/** Monotonic release gate shared by connection and UX callbacks. */
internal class HostGate {
    @Volatile
    var released: Boolean = false
        private set

    fun release() {
        released = true
    }

    fun accept(): Boolean = !released
}

/**
 * Optional car-host adapter.
 *
 * All `android.car.*` types are referenced ONLY inside this class. The manifest
 * declares `<uses-library android:name="android.car" android:required="false"/>`
 * so on non-automotive devices the car library is absent from the app
 * classloader; keeping every car type behind this boundary lets
 * [MainActivity] load and run on phones without a verifier failure, while the
 * car host remains fail-closed ([connected] == false) when the library or the
 * car service is unavailable.
 */
class CarHost(
    private val onUnrestrictedChange: (Boolean) -> Unit,
    private val onStatus: (String) -> Unit,
) {
    companion object {
        fun isCarHostAvailable(context: Context): Boolean = try {
            if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_AUTOMOTIVE)) {
                false
            } else {
                Class.forName("android.car.Car", false, context.classLoader)
                true
            }
        } catch (_: Exception) {
            false
        } catch (_: LinkageError) {
            false
        }
    }

    private val gate = HostGate()
    private var car: Car? = null
    private var ux: CarUxRestrictionsManager? = null
    private var disconnecting = false

    @Volatile
    var connected: Boolean = false
        get() = gate.accept() && field
        private set

    fun connect(activity: android.app.Activity, handler: android.os.Handler) {
        if (!gate.accept()) return
        try {
            val createdCar = Car.createCar(activity, handler, Car.CAR_WAIT_TIMEOUT_DO_NOT_WAIT) { connectedCar, ready ->
                if (!gate.accept()) {
                    disconnectCar(connectedCar)
                    return@createCar
                }
                if (!ready) {
                    teardown()
                    onStatus("Car service unavailable")
                    onUnrestrictedChange(false)
                    return@createCar
                }
                try {
                    val manager = connectedCar.getCarManager(Car.CAR_UX_RESTRICTION_SERVICE) as CarUxRestrictionsManager
                    ux = manager
                    manager.registerListener { restrictions -> apply(restrictions) }
                    if (!gate.accept()) {
                        teardown()
                        disconnectCar(connectedCar)
                        return@createCar
                    }
                    connected = true
                    apply(manager.currentCarUxRestrictions)
                } catch (error: Exception) {
                    if (!gate.accept()) return@createCar
                    teardown()
                    onStatus("Host UX unavailable: ${error.javaClass.simpleName}")
                    onUnrestrictedChange(false)
                } catch (error: LinkageError) {
                    if (!gate.accept()) return@createCar
                    teardown()
                    onStatus("Host UX unavailable: ${error.javaClass.simpleName}")
                    onUnrestrictedChange(false)
                }
            }
            if (gate.accept()) {
                car = createdCar
            } else {
                disconnectCar(createdCar)
            }
        } catch (error: Exception) {
            if (!gate.accept()) return
            teardown()
            onStatus("Car connection blocked: ${error.javaClass.simpleName}")
            onUnrestrictedChange(false)
        } catch (error: LinkageError) {
            if (!gate.accept()) return
            teardown()
            onStatus("Car connection blocked: ${error.javaClass.simpleName}")
            onUnrestrictedChange(false)
        }
    }

    fun apply(restrictions: CarUxRestrictions) {
        if (!gate.accept()) return
        val unrestricted = !restrictions.isRequiresDistractionOptimization &&
            restrictions.activeRestrictions == CarUxRestrictions.UX_RESTRICTIONS_BASELINE
        onStatus(
            "Host UX requiresDO=${restrictions.isRequiresDistractionOptimization}, " +
            "mask=${restrictions.activeRestrictions}; unrestricted=$unrestricted",
        )
        if (!gate.accept()) return
        onUnrestrictedChange(unrestricted)
    }

    fun disconnect() {
        gate.release()
        teardown()
    }

    private fun teardown() {
        gate.release()
        connected = false
        // Detach before cleanup so a re-entrant teardown cannot reuse these handles.
        val manager = ux
        val connection = car
        ux = null
        car = null
        try {
            manager?.unregisterListener()
        } catch (_: Throwable) {
            // listener or optional car library already released
        }
        disconnectCar(connection)
    }

    private fun disconnectCar(connectedCar: Car?) {
        if (connectedCar == null || disconnecting) return
        // disconnect() may synchronously deliver another lifecycle callback.
        disconnecting = true
        try {
            connectedCar.disconnect()
        } catch (_: Throwable) {
            // car service or optional library already gone
        } finally {
            disconnecting = false
        }
    }
}
