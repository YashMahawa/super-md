package dev.supermd.studio

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.webkit.ValueCallback
import android.webkit.WebView
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ReaderFlushHandoffTest {
    private lateinit var app: android.app.Application
    private lateinit var shareDir: File
    private lateinit var authority: String
    private lateinit var firstUri: Uri
    private lateinit var secondUri: Uri
    private var previousWelcomed: Boolean = false
    private var previousRecent: String? = null
    private var previousAutosave: Boolean = true
    private val workspaceKeys = mutableListOf<String>()
    private val stores = mutableListOf<ViewModelStore>()
    private val scopes = mutableListOf<CoroutineScope>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        shareDir = Files.createTempDirectory("reader-flush-handoff").toFile()
        File(shareDir, "first.md").writeText("# First External Open\n\nFirst body.\n")
        File(shareDir, "second.md").writeText("# Second External Open\n\nSecond body.\n")
        authority = "dev.supermd.test.share.${System.nanoTime()}"
        val provider = ShareTestProvider(shareDir).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        firstUri = DocumentsContract.buildDocumentUri(authority, "share/first.md")
        secondUri = DocumentsContract.buildDocumentUri(authority, "share/second.md")
        app.grantUriPermission(app.packageName, firstUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        app.grantUriPermission(app.packageName, secondUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)

        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        previousWelcomed = prefs.getBoolean("welcomed", false)
        previousRecent = prefs.getString("recent", null)
        previousAutosave = prefs.getBoolean("autosave", true)
        prefs.edit().putBoolean("autosave", false).commit()
    }

    @After fun tearDown() {
        scopes.forEach { it.cancel() }
        stores.forEach { it.clear() }
        ShadowContentResolver.reset()
        shareDir.deleteRecursively()
        workspaceKeys.forEach {
            File(app.filesDir, "workspaces/$it.json").delete()
            File(app.filesDir, "workspaces/$it").deleteRecursively()
        }
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().apply {
            if (previousWelcomed) putBoolean("welcomed", true) else remove("welcomed")
            if (previousRecent == null) remove("recent") else putString("recent", previousRecent)
            putBoolean("autosave", previousAutosave)
        }.commit()
    }

    private data class LoadedReaderNote(val id: String, val content: String)

    private class SimulatedReaderHarness(
        app: android.app.Application,
        val model: StudioViewModel,
        val scope: CoroutineScope,
        private val loadDelayMs: Long = 45L,
        var holdLoads: Boolean = false,
    ) {
        val loaded = AtomicReference<LoadedReaderNote?>(null)
        val flushTargets = java.util.concurrent.CopyOnWriteArrayList<String>()
        var forceFlushConflictOnNoteId: String? = null
        private val mainHandler = Handler(Looper.getMainLooper())
        lateinit var bridge: ReaderBridge
            private set

        fun deliverCurrentActiveLoad() {
            val latest = model.state.value.active
            loaded.set(LoadedReaderNote(latest.id, latest.content))
        }

        val web: WebView = object : WebView(app) {
            override fun post(action: Runnable?): Boolean =
                action?.let { mainHandler.post(it) } ?: false

            override fun evaluateJavascript(script: String, resultCallback: ValueCallback<String>?) {
                val flushIndex = script.indexOf("supermdFlush")
                if (flushIndex >= 0) {
                    val jsonStart = script.indexOf('{', flushIndex)
                    val jsonEnd = script.lastIndexOf('}')
                    if (jsonStart >= 0 && jsonEnd > jsonStart) {
                        var candidate = script.substring(jsonStart, jsonEnd + 1)
                        while (candidate.isNotEmpty() && runCatching { JSONObject(candidate) }.isFailure) {
                            candidate = candidate.dropLast(1)
                        }
                        val operation = JSONObject(candidate)
                        if (operation.optString("action") == "android_flush") {
                            val target = operation.getString("target")
                            val token = operation.getString("token")
                            flushTargets += target
                            val current = loaded.get()
                            val reply = when {
                                current == null || current.id != target -> JSONObject()
                                    .put("id", current?.id ?: "")
                                    .put("token", token)
                                    .put("error", "The active note changed before its edit flush")
                                forceFlushConflictOnNoteId == target -> JSONObject()
                                    .put("id", current.id)
                                    .put("token", token)
                                    .put("error", "Edit acknowledgement failed. Your unsent text is still in the editor; save/close was stopped.")
                                else -> JSONObject()
                                    .put("id", current.id)
                                    .put("token", token)
                                    .put("content", current.content)
                            }
                            bridge.post("flush-$token", "document_flushed", reply.toString())
                        }
                    }
                }
                resultCallback?.onReceiveValue("true")
            }
        }

        init {
            bridge = ReaderBridge(web, model, scope, ready = {}, assetCapabilities = ReaderAssetCapabilities())
            model.readerFlushRequester = { noteId -> bridge.requestFlush(noteId, timeoutMillis = 2_000) }
            model.attachReaderOpenHandler { uri, relative -> model.open(uri, relative) }
            // Mirror Compose's asynchronous LaunchedEffect(state.active) -> supermdLoad delivery.
            var lastScheduledId: String? = null
            var lastScheduledContent: String? = null
            scope.launch {
                model.state.collect { state ->
                    val active = state.active
                    if (active.id != lastScheduledId || active.content != lastScheduledContent) {
                        lastScheduledId = active.id
                        lastScheduledContent = active.content
                        val snapshot = LoadedReaderNote(active.id, active.content)
                        mainHandler.postDelayed({
                            if (!holdLoads) {
                                val latest = model.state.value.active
                                if (latest.id == snapshot.id) {
                                    loaded.set(LoadedReaderNote(latest.id, latest.content))
                                }
                            }
                        }, loadDelayMs)
                    }
                }
            }
        }
    }

    private fun newHarness(loadDelayMs: Long = 45L, holdLoads: Boolean = false): SimulatedReaderHarness {
        val store = ViewModelStore().also(stores::add)
        val workspace = "handoff-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, workspace).also { store.put("model-$workspace", it) }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).also(scopes::add)
        return SimulatedReaderHarness(app, model, scope, loadDelayMs, holdLoads)
    }

    private fun awaitMainLooper(timeoutMs: Long = 2_500, condition: () -> Boolean) {
        val mainLooper = shadowOf(Looper.getMainLooper())
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            mainLooper.idle()
            if (condition()) return
            mainLooper.idleFor(Duration.ofMillis(10))
            if (condition()) return
            Thread.sleep(5)
        }
        mainLooper.idle()
        val state = stores.toString()
        assertTrue("Condition was not satisfied within ${timeoutMs}ms ($state)", condition())
    }

    @Test fun consecutiveExternalOpensActivateSecondTabBeforeWebViewLoadsFirstTab() {
        val harness = newHarness(loadDelayMs = 45L)
        val model = harness.model
        model.welcomeDone()
        // Allow initial Welcome tab supermdLoad to settle before opening firstUri,
        // matching MainActivity where reader_ready + initial Welcome load precedes firstUri completion.
        awaitMainLooper { harness.loaded.get()?.id == model.state.value.active.id }

        model.requestInitialOpen(firstUri)
        awaitMainLooper { model.state.value.active.uri == firstUri.toString() }
        val firstId = model.state.value.active.id

        // Exact StudioUiTest.externalOpenActivatesNewAndAlreadyOpenFileTabs race (line 295 -> 297):
        // model.state.value.active is already firstId, while WebView JS has NOT yet processed supermdLoad(firstId).
        assertFalse(
            "Expected WebView reader to still hold previous note before next Compose frame",
            harness.loaded.get()?.id == firstId,
        )
        model.requestOpen(secondUri)

        awaitMainLooper {
            val state = model.state.value
            state.active.uri == secondUri.toString() && state.tabs.any { it.uri == firstUri.toString() }
        }
        assertNull("Handoff wait must not report a reader barrier failure", model.state.value.message)
        val secondId = model.state.value.active.id

        // Switching back to firstId and immediately re-requesting secondUri also succeeds without dropping focus.
        model.select(firstId)
        awaitMainLooper { model.state.value.active.id == firstId }
        model.requestOpen(secondUri)
        awaitMainLooper { model.state.value.active.id == secondId }
        assertEquals(1, model.state.value.tabs.count { it.uri == secondUri.toString() })
    }

    @Test fun initialExternalOpenSucceedsEvenBeforeInitialSupermdLoadLands() {
        val harness = newHarness(loadDelayMs = 45L, holdLoads = true)
        val model = harness.model
        model.welcomeDone()
        val welcomeId = model.state.value.active.id

        model.requestInitialOpen(firstUri)
        // Wait until open(firstUri) actually sends its first flush while loaded == null.
        awaitMainLooper { harness.flushTargets.contains(welcomeId) }
        assertNull("Expected flush to fire before initial supermdLoad landed", harness.loaded.get())

        harness.holdLoads = false
        harness.deliverCurrentActiveLoad()
        awaitMainLooper { model.state.value.active.uri == firstUri.toString() }
        assertNull(model.state.value.message)
    }

    @Test fun retiringBridgeDuringHandoffFailsClosedImmediately() {
        val harness = newHarness(loadDelayMs = 45L, holdLoads = true)
        val model = harness.model
        model.welcomeDone()
        val welcomeId = model.state.value.active.id

        model.requestInitialOpen(firstUri)
        awaitMainLooper { harness.flushTargets.contains(welcomeId) }
        harness.bridge.retire()

        awaitMainLooper {
            model.state.value.message?.contains("The reader could not confirm its latest edits") == true
        }
        assertEquals(welcomeId, model.state.value.active.id)
    }

    @Test fun genuineFlushConflictOnLoadedActiveTabFailsClosedImmediately() {
        val harness = newHarness(loadDelayMs = 10L)
        val model = harness.model
        model.welcomeDone()
        awaitMainLooper { harness.loaded.get()?.id == model.state.value.active.id }

        model.requestInitialOpen(firstUri)
        awaitMainLooper {
            val active = model.state.value.active
            active.uri == firstUri.toString() && harness.loaded.get()?.id == active.id
        }
        val firstId = model.state.value.active.id
        harness.forceFlushConflictOnNoteId = firstId

        model.requestOpen(secondUri)
        awaitMainLooper {
            model.state.value.message?.contains("The reader could not confirm its latest edits") == true
        }
        assertEquals("Active draft tab must stay focused on genuine flush failure", firstId, model.state.value.active.id)
        assertFalse("Second file must not steal focus or discard unconfirmed edits", model.state.value.tabs.any { it.uri == secondUri.toString() })
    }
}

private class ShareTestProvider(private val directory: File) : ContentProvider() {
    fun attach(context: Context, authority: String) {
        val info = ProviderInfo().apply {
            this.authority = authority
            exported = true
            grantUriPermissions = true
        }
        attachInfo(context, info)
    }

    override fun onCreate(): Boolean = true

    private fun resolveFile(uri: Uri): File {
        val name = DocumentsContract.getDocumentId(uri).substringAfterLast('/')
        return File(directory, name)
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val file = resolveFile(uri)
        val columns = projection?.toList() ?: listOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns.toTypedArray()).apply {
            addRow(columns.map { column ->
                when (column) {
                    OpenableColumns.DISPLAY_NAME -> file.name
                    OpenableColumns.SIZE -> file.length()
                    else -> null
                }
            }.toTypedArray<Any?>())
        }
    }

    override fun getType(uri: Uri): String = "text/markdown"
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(resolveFile(uri), ParcelFileDescriptor.MODE_READ_ONLY)
}
