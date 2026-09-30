package dev.supermd.studio

import android.app.Service
import android.content.Intent
import android.os.*
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.util.concurrent.Executors

/** Python runs in an app-owned child process, never on the UI thread. A timed
 * out or runaway cell can be terminated without killing the editor or drafts. */
class PythonWorkerService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private val receiver = Messenger(Handler(Looper.getMainLooper()) { message ->
        if (message.what == 2) { Process.killProcess(Process.myPid()); return@Handler true }
        if (message.what != 1) return@Handler false
        val reply = message.replyTo
        val input = message.data.getString("input") ?: return@Handler false
        val output = message.data.getString("output") ?: return@Handler false
        executor.execute {
            try {
                val root = cacheDir.canonicalFile
                val request = File(input).canonicalFile; val target = File(output).canonicalFile
                require(request.parentFile == root && target.parentFile == root && request.name.startsWith("python-") && target.name.startsWith("python-"))
                if (!Python.isStarted()) Python.start(AndroidPlatform(applicationContext))
                val result = Python.getInstance().getModule("supermd_runner").callAttr("run", request.readText(), File(cacheDir, "matplotlib").apply { mkdirs() }.absolutePath).toString()
                if (result.length > 25_000_000) error("Python output exceeds 25 MB")
                target.writeText(result)
                reply.send(Message.obtain(null, 1))
            } catch (error: Exception) { runCatching { reply.send(Message.obtain(null, 3).apply { data = Bundle().apply { putString("error", error.message) } }) } }
        }
        true
    })
    override fun onBind(intent: Intent) = receiver.binder
    override fun onDestroy() { executor.shutdownNow(); super.onDestroy() }
}
