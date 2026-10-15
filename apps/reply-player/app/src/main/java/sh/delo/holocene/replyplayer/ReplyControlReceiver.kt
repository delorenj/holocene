package sh.delo.holocene.replyplayer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Routes PAUSE/RESUME/STOP broadcasts into the running service. */
class ReplyControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val svc = Intent(context, ReplyWatcherService::class.java).setAction(intent.action)
        context.startService(svc)
    }
}
