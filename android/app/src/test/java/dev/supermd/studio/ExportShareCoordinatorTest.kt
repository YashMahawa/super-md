package dev.supermd.studio

import android.app.Application
import android.content.Intent
import android.content.pm.ProviderInfo
import android.os.Bundle
import android.os.Looper
import android.util.Base64
import androidx.core.content.FileProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
import java.time.Duration
import java.util.UUID
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ExportShareCoordinatorTest {
    private lateinit var app: Application

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        val authority = "${app.packageName}.share"
        val provider = FileProvider().apply {
            attachInfo(app, ProviderInfo().apply {
                this.authority = authority; exported = false; grantUriPermissions = true
                metaData = Bundle().apply { putInt("android.support.FILE_PROVIDER_PATHS", R.xml.share_paths) }
            })
        }
        ShadowContentResolver.registerProviderInternal(authority, provider)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    private fun <T> awaitSuspend(block: suspend () -> T): T {
        val deferred = CoroutineScope(Dispatchers.Default).async { block() }
        val deadlineNs = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
        while (!deferred.isCompleted && System.nanoTime() < deadlineNs) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(25)); Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(25))
        assertTrue("Coroutine timed out", deferred.isCompleted)
        return deferred.getCompleted()
    }

    @Test fun prepareShareValidatesFormatsBusyGuardAndPdfCancellationClearsShareState() {
        val model = StudioViewModel(app, "export-share-${UUID.randomUUID()}")
        assertFalse(model.prepareShare("docx"))
        assertFalse(model.state.value.busy)
        assertTrue(model.prepareShare("pdf"))
        assertTrue(model.state.value.busy)
        assertTrue(model.outputUri!!.path!!.endsWith(".pdf"))
        assertFalse(model.prepareShare("md"))
        model.pdfExportCancelled()
        assertFalse(model.state.value.busy)
        assertNull(model.outputUri)
        assertEquals("PDF export cancelled", model.state.value.message)
        assertTrue(model.prepareShare("smd"))
        assertTrue(model.portableOutput!!.path!!.endsWith(".smd"))
        model.busy(false)
        assertTrue(model.prepareShare("md"))
        model.busy(false)
        assertTrue(model.prepareShare("mdzip"))
    }

    @Test fun shareMarkdownDispatchesSendMultipleForCompanionAssetsAndSendForZipArchive() {
        val model = StudioViewModel(app, "export-share-${UUID.randomUUID()}")
        val noteId = model.state.value.active.id
        val svg = "<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><circle cx='8' cy='8' r='5'/></svg>".toByteArray()
        val assets = JSONObject().put("assets/plot.svg", "data:image/svg+xml;base64," + Base64.encodeToString(svg, Base64.NO_WRAP))
        val intents = mutableListOf<Intent>()
        model.shareReady = { intents += it }

        assertTrue(model.prepareMarkdownExport(sharing = true, archive = false))
        awaitSuspend { model.shareMarkdown(noteId, "# Lecture\n\n![Plot](assets/plot.svg)\n", assets, archive = false) }
        assertEquals(Intent.ACTION_SEND_MULTIPLE, intents[0].action)
        assertEquals(2, intents[0].clipData?.itemCount)
        assertTrue((intents[0].flags and Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0)
        assertEquals("Share copy ready", model.state.value.message)

        assertTrue(model.prepareMarkdownExport(sharing = true, archive = true))
        awaitSuspend { model.shareMarkdown(noteId, "# Lecture\n\n![Plot](assets/plot.svg)\n", assets, archive = true) }
        assertEquals(Intent.ACTION_SEND, intents[1].action)
        assertEquals("application/zip", intents[1].type)
        val zipUri = intents[1].clipData?.getItemAt(0)?.uri!!
        assertEquals("${app.packageName}.share", zipUri.authority)
        val entries = mutableSetOf<String>()
        java.util.zip.ZipInputStream(app.contentResolver.openInputStream(zipUri)!!).use { zip ->
            while (true) { val entry = zip.nextEntry ?: break; entries += entry.name }
        }
        val expectedMd = ExportFilename.suggestedName(model.state.value.active.name, NativeExportFormat.MARKDOWN)
        assertEquals(setOf(expectedMd, "assets/plot.svg"), entries)
    }

    @Test fun failClearsPendingShareFileSoSubsequentExportDoesNotTriggerFinishShare() {
        val model = StudioViewModel(app, "export-share-${UUID.randomUUID()}")
        val noteId = model.state.value.active.id
        model.edit(noteId, "# Clean\n")
        var shareCalls = 0
        model.shareReady = { shareCalls++ }
        assertTrue(model.prepareShare("smd"))
        val shareTarget = model.portableOutput!!
        val exportedSmd = java.io.File(shareTarget.path!!)
        model.fail("Simulated reader failure")
        assertNull(model.portableOutput)
        model.setPortableDestination(shareTarget)
        awaitSuspend { model.writePortable(noteId, "# Clean\n", JSONObject(), save = false, originalContent = "# Clean\n") }
        assertEquals(0, shareCalls)
        assertEquals("Portable .smd exported", model.state.value.message)
        assertTrue(ExportFilename.hasExpectedHeader(exportedSmd.readBytes().let { it.copyOf(minOf(it.size, 64)) }, NativeExportFormat.PORTABLE_SMD))
    }

    @Test fun initWithUnlistableRestoredFolderHandlesImmediateFailureBeforeCoordinatorAccess() {
        runBlocking { repeat(8) { launch(Dispatchers.IO) {} } }
        val clearMethod = StudioViewModel::class.java.getDeclaredMethod("onCleared").apply { isAccessible = true }
        repeat(40) { index ->
            val key = "export-share-init-$index-${UUID.randomUUID()}"
            app.getSharedPreferences("studio-window-$key", 0)
                .edit()
                .putBoolean("folderMigrated", true)
                .putString("folder", "file:///nonexistent-${UUID.randomUUID()}")
                .commit()
            val model = StudioViewModel(app, key)
            try {
                val deadlineNs = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
                while (model.state.value.error == null && System.nanoTime() < deadlineNs) {
                    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(10)); Thread.sleep(5)
                }
                assertTrue(model.state.value.error?.startsWith("Could not list folder:") == true)
            } finally {
                clearMethod.invoke(model)
            }
        }
    }
}
