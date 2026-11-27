package dev.supermd.studio

import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

// All windows share one killable Python worker. A per-window lock would allow
// one cell's cleanup/timeout to kill another window's in-flight execution.
private val pythonExecution = Mutex()

internal object PythonCellRunner {
    suspend fun run(app: Application, callbackScope: CoroutineScope, code: String): JSONObject = withContext(Dispatchers.IO) {
        pythonExecution.lock()
        val token = UUID.randomUUID().toString()
        val input = File(app.cacheDir, "python-$token.py")
        val output = File(app.cacheDir, "python-$token.json")
        var remote: Messenger? = null
        var connection: ServiceConnection? = null
        try {
            input.writeText(code)
            withTimeout(115_000) {
                suspendCancellableCoroutine<JSONObject> { continuation ->
                    val reply = Messenger(Handler(Looper.getMainLooper()) { message ->
                        if (continuation.isActive) {
                            if (message.what == 1) {
                                callbackScope.launch(Dispatchers.IO) {
                                    try {
                                        val result = JSONObject(output.readText())
                                        if (continuation.isActive) continuation.resumeWith(Result.success(result))
                                    } catch (error: Exception) {
                                        if (continuation.isActive) continuation.resumeWith(Result.failure(error))
                                    }
                                }
                            } else {
                                continuation.resumeWith(
                                    Result.failure(IllegalStateException(message.data.getString("error") ?: "Python failed")),
                                )
                            }
                        }
                        true
                    })
                    val service = object : ServiceConnection {
                        override fun onServiceConnected(name: ComponentName?, binder: IBinder) {
                            remote = Messenger(binder)
                            runCatching {
                                remote!!.send(
                                    Message.obtain(null, 1).apply {
                                        replyTo = reply
                                        data = Bundle().apply {
                                            putString("input", input.absolutePath)
                                            putString("output", output.absolutePath)
                                        }
                                    },
                                )
                            }.onFailure {
                                if (continuation.isActive) continuation.resumeWith(Result.failure(it))
                            }
                        }

                        override fun onServiceDisconnected(name: ComponentName?) {
                            if (continuation.isActive) {
                                continuation.resumeWith(Result.failure(IllegalStateException("Python worker stopped")))
                            }
                        }
                    }
                    connection = service
                    if (!app.bindService(Intent(app, PythonWorkerService::class.java), service, Context.BIND_AUTO_CREATE)) {
                        continuation.resumeWith(Result.failure(IllegalStateException("Cannot start Python worker")))
                    }
                }
            }
        } finally {
            withContext(NonCancellable) {
                // Release worker resources before another window can bind. Even
                // cancellation must complete this barrier and unlock the queue.
                runCatching { remote?.send(Message.obtain(null, 2)) }
                remote?.binder?.let { binder ->
                    withTimeoutOrNull(2000) {
                        while (binder.isBinderAlive) delay(10)
                    }
                }
                connection?.let { runCatching { app.unbindService(it) } }
                input.delete()
                output.delete()
                pythonExecution.unlock()
            }
        }
    }
}
