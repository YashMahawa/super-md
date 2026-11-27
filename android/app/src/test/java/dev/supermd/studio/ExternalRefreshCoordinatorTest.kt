package dev.supermd.studio

import android.app.Application
import android.net.Uri
import android.os.Looper
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ExternalRefreshCoordinatorTest {
    private lateinit var app: Application
    private lateinit var tempDir: File
    private lateinit var baselinePortableDirs: Set<String>
    private var previousAutosave: Boolean? = null
    private var previousRecent: String? = null
    private val stores = mutableListOf<ViewModelStore>()
    private val keys = mutableListOf<String>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        tempDir = Files.createTempDirectory("ext-refresh-coord").toFile()
        baselinePortableDirs = File(app.filesDir, "portable-assets").listFiles()?.map { it.name }?.toSet().orEmpty()
        val prefs = app.getSharedPreferences("studio", 0)
        previousAutosave = prefs.getBoolean("autosave", true)
        previousRecent = prefs.getString("recent", null)
        prefs.edit().putBoolean("autosave", false).commit()
    }

    @After fun tearDown() {
        shadowOf(Looper.getMainLooper()).idle()
        stores.forEach { it.clear() }
        shadowOf(Looper.getMainLooper()).idle()
        tempDir.deleteRecursively()
        app.getSharedPreferences("studio", 0).edit().apply {
            putBoolean("autosave", previousAutosave ?: true)
            if (previousRecent == null) remove("recent") else putString("recent", previousRecent)
        }.commit()
        keys.forEach { k ->
            File(app.filesDir, "workspaces/$k.json").delete()
            File(app.filesDir, "workspaces/$k").deleteRecursively()
            File(app.filesDir, "closed-notes/$k").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$k")
        }
        File(app.filesDir, "portable-assets").listFiles()?.forEach { if (it.name !in baselinePortableDirs) it.deleteRecursively() }
    }

    private fun await(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < deadline && !predicate()) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(25)); Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(25))
        assertTrue("Condition timed out", predicate())
    }

    @Test fun refreshAdoptsCleanNotesFlagsDirtyConflictAndCleansOnlyUnreferencedPortableDirs() {
        val key = "erc-${UUID.randomUUID()}".also(keys::add)
        val model = StudioViewModel(app, key).also {
            it.readerFlushRequester = { true }; ViewModelStore().also(stores::add).put("vm", it)
        }
        val closedSmd = File(tempDir, "Closed.smd").also { it.outputStream().use { s -> model.media.writeFmd(s, "# Closed\n", JSONObject().put("assets/c.svg", SVG_A)) } }
        val cleanMd = File(tempDir, "Clean.md").apply { writeText("# Clean v1\n") }
        val cleanSmd = File(tempDir, "Clean.smd").also { it.outputStream().use { s -> model.media.writeFmd(s, "# Portable v1\n", JSONObject().put("assets/p.svg", SVG_A)) } }
        val dirtyMd = File(tempDir, "Dirty.md").apply { writeText("# Dirty v1\n") }

        model.open(Uri.fromFile(closedSmd))
        await { model.state.value.tabs.any { it.uri == Uri.fromFile(closedSmd).toString() } }
        val closedTab = model.state.value.tabs.single { it.uri == Uri.fromFile(closedSmd).toString() }
        val closedDir = closedTab.assetDirectory!!
        model.close(closedTab.id)
        await { model.state.value.closedTabs.any { it.id == closedTab.id } }

        listOf(cleanMd, cleanSmd, dirtyMd).forEach { model.open(Uri.fromFile(it)) }
        await { model.state.value.tabs.count { it.uri != null } == 3 }
        val cleanMdId = model.state.value.tabs.single { it.uri == Uri.fromFile(cleanMd).toString() }.id
        val cleanSmdTab = model.state.value.tabs.single { it.uri == Uri.fromFile(cleanSmd).toString() }
        val initialSmdDir = cleanSmdTab.assetDirectory!!
        val dirtyMdId = model.state.value.tabs.single { it.uri == Uri.fromFile(dirtyMd).toString() }.id
        model.edit(dirtyMdId, "# Unsaved local draft\n")

        cleanMd.writeText("\uFEFF# Clean v2\n")
        cleanSmd.outputStream().use { model.media.writeFmd(it, "# Portable v2\n", JSONObject().put("assets/p.svg", SVG_B)) }
        dirtyMd.writeText("# Disk overwrite\n")
        model.refreshExternal(immediate = true)
        await {
            !model.isRefreshExternalActive() &&
                model.state.value.tabs.single { it.id == cleanMdId }.content == "# Clean v2\n" &&
                model.state.value.tabs.single { it.id == cleanSmdTab.id }.content == "# Portable v2\n" &&
                dirtyMdId in model.state.value.conflictedTabIds
        }

        val refreshedSmdDir = model.state.value.tabs.single { it.id == cleanSmdTab.id }.assetDirectory!!
        assertEquals("# Clean v2\n", model.state.value.tabs.single { it.id == cleanMdId }.saved)
        assertEquals("# Portable v2\n", model.state.value.tabs.single { it.id == cleanSmdTab.id }.saved)
        assertNotEquals(initialSmdDir, refreshedSmdDir)
        assertEquals(SVG_B, model.media.portableAssets(refreshedSmdDir).optString("assets/p.svg"))
        assertEquals("# Unsaved local draft\n", model.state.value.tabs.single { it.id == dirtyMdId }.content)
        assertFalse(model.isPortableDirectoryReferenced(initialSmdDir))
        assertTrue(model.isPortableDirectoryReferenced(refreshedSmdDir))
        assertTrue(model.isPortableDirectoryReferenced(closedDir))
        await { !File(app.filesDir, "portable-assets/$initialSmdDir").exists() }
        assertTrue(File(app.filesDir, "portable-assets/$refreshedSmdDir").isDirectory)
        assertTrue(File(app.filesDir, "portable-assets/$closedDir").isDirectory)
    }

    companion object {
        private const val SVG_A = "data:image/svg+xml;base64,PHN2ZyBpZD0iYSIvPg=="
        private const val SVG_B = "data:image/svg+xml;base64,PHN2ZyBpZD0iYiIvPg=="
    }
}
