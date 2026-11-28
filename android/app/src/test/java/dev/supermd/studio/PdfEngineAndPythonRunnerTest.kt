package dev.supermd.studio

import android.content.ComponentName
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.Messenger
import java.io.File
import java.time.Duration
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PdfEngineAndPythonRunnerTest {
    private fun <T> awaitResult(block: suspend (CoroutineScope) -> T): Result<T> {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val outcome = AtomicReference<Result<T>?>(null)
        scope.launch {
            outcome.set(runCatching { block(this) })
        }
        val mainLooper = shadowOf(Looper.getMainLooper())
        val deadline = System.currentTimeMillis() + 5_000
        while (outcome.get() == null && System.currentTimeMillis() < deadline) {
            mainLooper.idleFor(Duration.ofMillis(25))
            Thread.sleep(10)
        }
        mainLooper.idleFor(Duration.ofMillis(25))
        scope.cancel()
        val finalOutcome = outcome.get()
        assertNotNull("Timed out waiting for coroutine completion", finalOutcome)
        return finalOutcome!!
    }

    private fun pythonTempFiles(cacheDir: File): List<File> =
        cacheDir.listFiles { file ->
            file.name.startsWith("python-") && (file.name.endsWith(".py") || file.name.endsWith(".json"))
        }?.toList().orEmpty()

    @Test
    fun markdownImageSourcesFallbackExtractsSupportedFormsAndIgnoresNonImages() {
        val markdown = """
            Regular [link](notes/intro.md) and [titled link](<docs/guide 1.md> "Guide") are ignored.
            Empty images ![]() and ![Blank](<   >) are ignored.
            Standard: ![Diagram](assets/diagram.png)
            Angle brackets with spaces: ![My Chart](<assets/my chart 1.svg>)
            Double-quoted title: ![Figure A](assets/fig-a.jpg "Figure A")
            Single-quoted title: ![Figure B](<assets/fig b.png> 'Figure B')
            Escaped brackets in alt: ![Plot \[x\] and \\](assets/plot.webp "Plot")
        """.trimIndent()

        val firstPass = JSONArray(markdownImageSourcesJson(markdown))
        val extracted = (0 until firstPass.length()).map(firstPass::getString)
        assertEquals(
            listOf(
                "assets/diagram.png",
                "assets/my chart 1.svg",
                "assets/fig-a.jpg",
                "assets/fig b.png",
                "assets/plot.webp",
            ),
            extracted,
        )

        // Second call exercises the NoClassDefFoundError fallback path after PdfEngine static init failure.
        val secondPass = JSONArray(markdownImageSourcesJson("![Repeat](<assets/repeat image.png>)"))
        assertEquals(1, secondPass.length())
        assertEquals("assets/repeat image.png", secondPass.getString(0))
    }

    @Test
    fun pythonRunnerCleansTempFilesAndUnlocksMutexWhenBindServiceFails() {
        val app = RuntimeEnvironment.getApplication()
        val component = ComponentName(app, PythonWorkerService::class.java)
        shadowOf(app).declareComponentUnbindable(component)

        val first = awaitResult { scope ->
            PythonCellRunner.run(app, scope, "print('first')")
        }
        assertTrue(first.isFailure)
        assertEquals("Cannot start Python worker", first.exceptionOrNull()?.message)
        assertEquals(emptyList<File>(), pythonTempFiles(app.cacheDir))

        // Verify pythonExecution mutex was unlocked so a subsequent StudioViewModel.python call does not deadlock.
        val key = "python-test-${UUID.randomUUID()}"
        val store = androidx.lifecycle.ViewModelStore()
        val factory = object : androidx.lifecycle.ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T =
                StudioViewModel(app, workspaceKey = key) as T
        }
        val model = androidx.lifecycle.ViewModelProvider(store, factory)[StudioViewModel::class.java]
        try {
            val second = awaitResult {
                model.python("print('second')")
            }
            assertTrue(second.isFailure)
            assertEquals("Cannot start Python worker", second.exceptionOrNull()?.message)
            assertEquals(emptyList<File>(), pythonTempFiles(app.cacheDir))
        } finally {
            store.clear()
            File(app.filesDir, "workspaces/$key.json").deleteRecursively()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
        }
    }

    @Test
    fun pythonRunnerExecutesMessengerRoundtripSendsKillAndCleansTempFiles() {
        val app = RuntimeEnvironment.getApplication()
        val component = ComponentName(app, PythonWorkerService::class.java)
        val receivedCodes = mutableListOf<Int>()
        var dead = false
        val workerHandler = Handler(Looper.getMainLooper()) { message ->
            receivedCodes += message.what
            if (message.what == 1) {
                val inputPath = message.data.getString("input")!!
                val outputPath = message.data.getString("output")!!
                val source = File(inputPath).readText()
                File(outputPath).writeText(
                    JSONObject().put("ok", true).put("stdout", "ran:$source").put("stderr", "").toString(),
                )
                dead = true
                message.replyTo.send(Message.obtain(null, 1))
            }
            true
        }
        val messenger = Messenger(workerHandler)
        val binder = object : android.os.IBinder by messenger.binder {
            override fun isBinderAlive(): Boolean = !dead
        }
        shadowOf(app).setComponentNameAndServiceForBindService(component, binder)

        val result = awaitResult { scope ->
            PythonCellRunner.run(app, scope, "2 + 2")
        }.getOrThrow()

        assertTrue(result.getBoolean("ok"))
        assertEquals("ran:2 + 2", result.getString("stdout"))
        assertTrue(receivedCodes.contains(1))
        assertTrue(receivedCodes.contains(2))
        assertEquals(emptyList<File>(), pythonTempFiles(app.cacheDir))
    }
}
