package dev.supermd.studio

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.ui.test.SemanticsNodeInteractionCollection
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.core.app.ActivityOptionsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class RevocableDocumentAccessEmulatorTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val app: Application
        get() = ApplicationProvider.getApplicationContext()

    private val workspaceKeys = mutableListOf<String>()
    private var savedPrefsSnapshot: Map<String, Any?> = emptyMap()

    @Before
    fun setUp() {
        MainActivity.defaultActivityResultRegistryOwnerForTest = null
        RevocableTestDocumentsProvider.reset(app)
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        savedPrefsSnapshot = HashMap(prefs.all)
        prefs.edit()
            .putBoolean("welcomed", true)
            .putString("startup", "restore")
            .putBoolean("autosave", false)
            .commit()
    }

    @After
    fun tearDown() {
        MainActivity.defaultActivityResultRegistryOwnerForTest = null
        TestAuthorityGrants.unregisterAuthority(RevocableTestDocumentsProvider.authority(app))
        workspaceKeys.forEach { key ->
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            File(app.filesDir, "workspaces/$key.json").delete()
            File(app.filesDir, "deleted-drafts/$key").deleteRecursively()
            app.getSharedPreferences("studio-$key", Context.MODE_PRIVATE).edit().clear().commit()
            app.getSharedPreferences("studio-window-$key", Context.MODE_PRIVATE).edit().clear().commit()
        }
        val prefsEditor = app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().clear()
        for ((key, value) in savedPrefsSnapshot) {
            when (value) {
                is Boolean -> prefsEditor.putBoolean(key, value)
                is Float -> prefsEditor.putFloat(key, value)
                is Int -> prefsEditor.putInt(key, value)
                is Long -> prefsEditor.putLong(key, value)
                is String -> prefsEditor.putString(key, value)
                is Set<*> -> {
                    @Suppress("UNCHECKED_CAST")
                    prefsEditor.putStringSet(key, value as Set<String>)
                }
            }
        }
        prefsEditor.commit()
        RevocableTestDocumentsProvider.reset(app)
        TestAuthorityGrants.clear()
    }

    @Test
    fun startupWithRevokedGrantShowsRestoreAccessPreservesCachedTextAndDraftsWhileValidDirectAndFolderGrantsShowSaved() {
        val workspace = UUID.randomUUID().toString().also(workspaceKeys::add)
        val cleanRevokedUri = RevocableTestDocumentsProvider.putMarkdown(
            app,
            "RevokedClean.md",
            "# Cached clean note\nPreserved across startup revocation.\n",
        )
        val draftRevokedUri = RevocableTestDocumentsProvider.putMarkdown(
            app,
            "RevokedDraft.md",
            "# Baseline before draft\n",
        )
        val directValidUri = RevocableTestDocumentsProvider.putMarkdown(
            app,
            "DirectValid.md",
            "# Direct grant stays valid\n",
        )
        val vaultTreeUri = RevocableTestDocumentsProvider.treeUri(app, "vault")
        val folderCoveredPlainUri = RevocableTestDocumentsProvider.putMarkdown(
            app,
            "vault/FolderCovered.md",
            "# Covered by folder grant\n",
        )

        RevocableTestDocumentsProvider.grantReadWrite(cleanRevokedUri)
        RevocableTestDocumentsProvider.grantReadWrite(draftRevokedUri)
        RevocableTestDocumentsProvider.grantReadWrite(directValidUri)
        RevocableTestDocumentsProvider.grantReadWrite(vaultTreeUri)
        RevocableTestDocumentsProvider.grantReadWrite(folderCoveredPlainUri)

        val unsavedDraftText = "# Baseline before draft\nUnsaved local study notes that must survive.\n"
        var cleanRevokedId = ""
        var draftRevokedId = ""
        var directValidId = ""
        var folderCoveredId = ""

        // Session 1: Open the four notes, configure the containing folder, edit the draft, and flush workspace state.
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).putExtra("workspace", workspace)).use { initial ->
            var model: StudioViewModel? = null
            initial.onActivity { activity ->
                model = ViewModelProvider(activity)[StudioViewModel::class.java]
                model!!.reading(autosave = false)
                model!!.setFolder(vaultTreeUri)
            }
            waitForCondition {
                model != null && model!!.state.value.files.any { it.name == "FolderCovered.md" }
            }
            directValidId = openAndAwait(initial, model!!, directValidUri)
            folderCoveredId = openAndAwait(initial, model!!, folderCoveredPlainUri, relative = "FolderCovered.md")
            draftRevokedId = openAndAwait(initial, model!!, draftRevokedUri)
            editAndAwait(initial, model!!, draftRevokedId, unsavedDraftText)
            cleanRevokedId = openAndAwait(initial, model!!, cleanRevokedUri)

            assertEquals(unsavedDraftText, model!!.state.value.tabs.single { it.id == draftRevokedId }.content)
            assertTrue(flushRecoveryPumpingCompose(model!!))
            assertTrue(File(app.filesDir, "workspaces/$workspace.json").isFile)
        }

        // Revoke grants before cold workspace startup:
        // - cleanRevokedUri and draftRevokedUri lose all grants.
        // - folderCoveredPlainUri loses its direct grant, while vaultTreeUri retains read+write folder access.
        // - directValidUri retains its direct read+write grant.
        RevocableTestDocumentsProvider.revokeAll(cleanRevokedUri)
        RevocableTestDocumentsProvider.revokeAll(draftRevokedUri)
        RevocableTestDocumentsProvider.revokeAll(folderCoveredPlainUri)

        // Session 2: Launch MainActivity restoring from workspace snapshot.
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).putExtra("workspace", workspace)).use { restored ->
            var model: StudioViewModel? = null
            restored.onActivity { activity ->
                model = ViewModelProvider(activity)[StudioViewModel::class.java]
            }
            awaitActiveReader(model!!)
            waitForCondition {
                model!!.documentWriteNeedsAccess(cleanRevokedId) &&
                    model!!.documentWriteNeedsAccess(draftRevokedId) &&
                    !model!!.isRefreshExternalActive() &&
                    !model!!.isStartupAccessSeedActive()
            }

            // 1. Active clean note with revoked grant shows restore-access status (never "Saved") and keeps cached text.
            waitForNodeText("Local draft · restore file access")
            assertEquals(0, compose.onAllNodesWithText("Saved").fetchSemanticsNodes().size)
            assertNull("Startup seeding must not pop an unsolicited modal dialog", model!!.documentAccessRequests.value)
            val cleanTab = model!!.state.value.tabs.single { it.id == cleanRevokedId }
            assertEquals("# Cached clean note\nPreserved across startup revocation.\n", cleanTab.content)
            assertFalse(cleanTab.dirty)

            // 2. Dirty draft note with revoked grant keeps both unsaved draft and saved baseline intact.
            selectAndAwait(restored, model!!, draftRevokedId)
            waitForNodeText("Local draft · restore file access")
            val draftTab = model!!.state.value.tabs.single { it.id == draftRevokedId }
            assertEquals(unsavedDraftText, draftTab.content)
            assertEquals("# Baseline before draft\n", draftTab.saved)
            assertTrue(draftTab.dirty)

            // 3. Note with valid direct grant still shows Saved.
            assertFalse(model!!.documentWriteNeedsAccess(directValidId))
            selectAndAwait(restored, model!!, directValidId)
            waitForNodeText("Saved")

            // 4. Note whose direct grant was revoked but whose containing folder tree grant is valid still shows Saved.
            assertFalse(model!!.documentWriteNeedsAccess(folderCoveredId))
            selectAndAwait(restored, model!!, folderCoveredId)
            waitForNodeText("Saved")
        }
    }

    @Test
    fun resumeWithRevokedGrantTransitionsFromSavedToRestoreAccessKeepsOrdinaryErrorsDistinctAndReauthorizesViaPicker() {
        val workspace = UUID.randomUUID().toString().also(workspaceKeys::add)
        val resumeUri = RevocableTestDocumentsProvider.putMarkdown(
            app,
            "ResumeTarget.md",
            "# Saved before backgrounding\n",
        )
        val ordinaryErrorUri = RevocableTestDocumentsProvider.putMarkdown(
            app,
            "OrdinaryError.md",
            "# Stays saved on transient I/O error\n",
        )
        RevocableTestDocumentsProvider.grantReadWrite(resumeUri)
        RevocableTestDocumentsProvider.grantReadWrite(ordinaryErrorUri)

        val launchedIntentRef = AtomicReference<Intent?>(null)
        val interceptorRegistry = object : ActivityResultRegistry() {
            override fun <I, O> onLaunch(
                requestCode: Int,
                contract: ActivityResultContract<I, O>,
                input: I,
                options: ActivityOptionsCompat?,
            ) {
                if (contract is RestoreDocumentAccess && input is Uri) {
                    launchedIntentRef.set(contract.createIntent(app, input))
                    RevocableTestDocumentsProvider.grantReadWrite(input)
                    dispatchResult(requestCode, Activity.RESULT_OK, Intent().setData(input))
                } else {
                    dispatchResult(requestCode, Activity.RESULT_CANCELED, null)
                }
            }
        }
        MainActivity.defaultActivityResultRegistryOwnerForTest = object : ActivityResultRegistryOwner {
            override val activityResultRegistry: ActivityResultRegistry = interceptorRegistry
        }

        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).putExtra("workspace", workspace)).use { scenario ->
            var model: StudioViewModel? = null
            scenario.onActivity { activity ->
                model = ViewModelProvider(activity)[StudioViewModel::class.java]
                model!!.reading(autosave = false)
            }
            val ordinaryId = openAndAwait(scenario, model!!, ordinaryErrorUri)
            val resumeId = openAndAwait(scenario, model!!, resumeUri)
            waitForNodeText("Saved")

            // Pass 1: Ordinary provider I/O error on resume must stay distinct from permission denial.
            selectAndAwait(scenario, model!!, ordinaryId)
            waitForCondition { !model!!.isRefreshExternalActive() }
            waitForNodeText("Saved")

            val attemptsBeforeResume = RevocableTestDocumentsProvider.openReadAttempts("OrdinaryError.md")
            scenario.moveToState(Lifecycle.State.CREATED)
            RevocableTestDocumentsProvider.setOrdinaryReadIoError("OrdinaryError.md", true)
            scenario.moveToState(Lifecycle.State.RESUMED)

            waitForCondition {
                RevocableTestDocumentsProvider.openReadAttempts("OrdinaryError.md") > attemptsBeforeResume &&
                    !model!!.isRefreshExternalActive()
            }
            assertFalse("Ordinary I/O error must not block writes", model!!.documentWriteNeedsAccess(ordinaryId))
            assertNull(model!!.documentAccessRequests.value)
            waitForNodeText("Saved")
            assertEquals(
                "# Stays saved on transient I/O error\n",
                model!!.state.value.tabs.single { it.id == ordinaryId }.content,
            )
            RevocableTestDocumentsProvider.setOrdinaryReadIoError("OrdinaryError.md", false)

            // Pass 2: Revoking the SAF grant while backgrounded updates status on resume without losing cached text or drafts.
            selectAndAwait(scenario, model!!, resumeId)
            waitForCondition { !model!!.isRefreshExternalActive() }
            waitForNodeText("Saved")

            scenario.moveToState(Lifecycle.State.CREATED)
            RevocableTestDocumentsProvider.revokeAll(resumeUri)
            scenario.moveToState(Lifecycle.State.RESUMED)

            waitForCondition { model!!.documentWriteNeedsAccess(resumeId) }
            waitForNodeText("Local draft · restore file access")
            assertEquals(0, compose.onAllNodesWithText("Saved").fetchSemanticsNodes().size)
            assertEquals(
                "# Saved before backgrounding\n",
                model!!.state.value.tabs.single { it.id == resumeId }.content,
            )

            // Local draft edits made while revoked are preserved and reauthorizing via RestoreDocumentAccess saves cleanly.
            val editedDraft = "# Saved before backgrounding\nEdited after revocation.\n"
            scenario.onActivity { model!!.reading(autosave = true) }
            editAndAwait(scenario, model!!, resumeId, editedDraft)
            waitForNodeText("Local draft · restore file access")

            compose.onNodeWithText("Local draft · restore file access").performClick()
            waitForNodeText("Restore file access")
            compose.onNodeWithText("Choose original file").assertIsDisplayed().performClick()

            waitForCondition {
                launchedIntentRef.get() != null &&
                    !model!!.documentWriteNeedsAccess(resumeId) &&
                    !model!!.state.value.tabs.single { it.id == resumeId }.dirty
            }
            val pickerIntent = launchedIntentRef.get()!!
            assertEquals(Intent.ACTION_OPEN_DOCUMENT, pickerIntent.action)
            assertEquals(
                resumeUri,
                @Suppress("DEPRECATION")
                pickerIntent.getParcelableExtra(DocumentsContract.EXTRA_INITIAL_URI),
            )
            val expectedFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            assertEquals(expectedFlags, pickerIntent.flags and expectedFlags)
            assertEquals(
                editedDraft,
                RevocableTestDocumentsProvider.fileForDocId(app, "ResumeTarget.md").readText(Charsets.UTF_8),
            )
            waitForNodeText("Saved")
        }
    }

    private fun awaitActiveReader(model: StudioViewModel) {
        waitForCondition(30_000L, "reader bridge ready") {
            model.state.value.active.id.isNotEmpty() &&
                compose.onAllNodes(hasContentDescription("Export") and isEnabled()).hasAnyNode()
        }
        awaitReaderSnapshotPumpingCompose(model, model.state.value.active.id)
    }

    private fun openAndAwait(
        scenario: ActivityScenario<MainActivity>,
        model: StudioViewModel,
        uri: Uri,
        relative: String? = null,
    ): String {
        awaitActiveReader(model)
        scenario.onActivity { activity -> activity.requestOpen(uri, relative) }
        var openedId = ""
        waitForCondition(30_000L, "open($uri)") {
            val match = model.state.value.tabs.firstOrNull {
                it.uri != null && sameDocument(Uri.parse(it.uri), uri)
            }
            if (match != null && model.state.value.active.id == match.id) {
                openedId = match.id
                true
            } else {
                false
            }
        }
        awaitReaderSnapshotPumpingCompose(model, openedId)
        return openedId
    }

    private fun selectAndAwait(
        scenario: ActivityScenario<MainActivity>,
        model: StudioViewModel,
        targetId: String,
    ) {
        awaitActiveReader(model)
        scenario.onActivity { model.select(targetId) }
        waitForCondition(30_000L, "select($targetId)") {
            model.state.value.active.id == targetId
        }
        awaitReaderSnapshotPumpingCompose(model, targetId)
    }

    private fun editAndAwait(
        scenario: ActivityScenario<MainActivity>,
        model: StudioViewModel,
        noteId: String,
        content: String,
    ) {
        scenario.onActivity { model.edit(noteId, content) }
        waitForCondition(30_000L, "edit($noteId)") {
            model.state.value.tabs.single { it.id == noteId }.content == content
        }
        if (model.state.value.active.id == noteId) {
            awaitReaderSnapshotPumpingCompose(model, noteId)
        }
    }

    private fun awaitReaderSnapshotPumpingCompose(
        model: StudioViewModel,
        noteId: String,
        timeoutMs: Long = 30_000L,
    ) {
        compose.waitForIdle()
        val done = AtomicBoolean(false)
        val job = CoroutineScope(Dispatchers.Main).launch {
            while (isActive && !done.get()) {
                if (model.state.value.active.id == noteId && model.awaitReaderSnapshot(noteId, 2_500L)) {
                    done.set(true)
                    break
                }
                delay(40)
            }
        }
        try {
            waitForCondition(timeoutMs, "awaitReaderSnapshot($noteId)") { done.get() }
        } finally {
            job.cancel()
        }
    }

    private fun flushRecoveryPumpingCompose(
        model: StudioViewModel,
        timeoutMs: Long = 15_000L,
    ): Boolean {
        val flushed = AtomicBoolean(false)
        val finished = AtomicBoolean(false)
        val job = CoroutineScope(Dispatchers.Main).launch {
            flushed.set(model.flushRecoveryAndAwait())
            finished.set(true)
        }
        try {
            waitForCondition(timeoutMs, "flushRecoveryAndAwait") { finished.get() }
        } finally {
            job.cancel()
        }
        return flushed.get()
    }

    private fun waitForNodeText(text: String, timeoutMs: Long = 30_000L) {
        waitForCondition(timeoutMs, "nodeWithText($text)") {
            compose.onAllNodesWithText(text).hasAnyNode()
        }
        compose.onNodeWithText(text).assertIsDisplayed()
    }

    private fun SemanticsNodeInteractionCollection.hasAnyNode(): Boolean =
        runCatching { fetchSemanticsNodes().isNotEmpty() }.getOrDefault(false)

    private fun waitForCondition(
        timeoutMs: Long = 30_000L,
        description: String = "condition",
        condition: () -> Boolean,
    ) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            compose.waitForIdle()
            if (condition()) return
            Thread.sleep(25)
        }
        compose.waitForIdle()
        assertTrue("Timed out after ${timeoutMs}ms waiting for $description", condition())
    }
}
