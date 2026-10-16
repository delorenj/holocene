package sh.delo.holocene.auto

import android.content.Context

/**
 * A tiny durable key/value store for the Agent Pad page, kept native because the WebView's own localStorage does not
 * survive a cold start of this app: the process is killed (ignition off, `am force-stop`, the sim restarts) and the
 * next page load sees an empty storage even though the file on disk had the value. The pad's "last reply played"
 * marker lived there, so every start replayed the newest replies and re-published audio.memo.played for them.
 *
 * Only keys in [KEYS] are accepted and values are capped, so the page cannot use the bridge as general storage.
 * No android.* in [PadPrefs] itself: [Store] is the seam the JUnit test fakes.
 */
class PadPrefs(private val store: Store) {
    interface Store {
        fun get(key: String): String?
        /** Must be durable when it returns (SharedPreferences.commit), because the process can be killed any moment. */
        fun put(key: String, value: String)
    }

    fun get(key: String): String = if (allowed(key)) store.get(key).orEmpty() else ""

    fun set(key: String, value: String): Boolean {
        if (!allowed(key) || value.length > MAX_VALUE) return false
        store.put(key, value)
        return true
    }

    companion object {
        const val MAX_VALUE = 2048
        const val PREFS_NAME = "pad"
        val KEYS = setOf("agentpad.lastDoneReply")

        fun allowed(key: String) = key in KEYS

        fun forContext(context: Context): PadPrefs {
            val sp = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            return PadPrefs(object : Store {
                override fun get(key: String): String? = sp.getString(key, null)
                override fun put(key: String, value: String) { sp.edit().putString(key, value).commit() }
            })
        }
    }
}
