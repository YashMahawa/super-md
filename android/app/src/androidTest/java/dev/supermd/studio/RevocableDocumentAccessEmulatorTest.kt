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
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.test.SemanticsNodeInteractionCollection
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
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
        val launchedTreeIntentRef = AtomicReference<Intent?>(null)
        val folderPickerResultRef = AtomicReference<(() -> Uri?)?>(null)
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
                } else if (contract is ActivityResultContracts.OpenDocumentTree) {
                    launchedTreeIntentRef.set(contract.createIntent(app, input as? Uri))
                    val chosenTree = folderPickerResultRef.get()?.invoke()
                    if (chosenTree != null) {
                        dispatchResult(requestCode, Activity.RESULT_OK, Intent().setData(chosenTree))
                    } else {
                        dispatchResult(requestCode, Activity.RESULT_CANCELED, null)
                    }
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

            // Pass 3: Shared folder grant via workspace link selection scopes returning write access strictly to notes
            // inside the granted folder tree (leaving read-only folder grants and outside-folder notes write-blocked).
            scenario.onActivity { model!!.reading(autosave = false) }
            val vaultTreeUri = RevocableTestDocumentsProvider.treeUri(app, "vault")
            val vaultHubUri = RevocableTestDocumentsProvider.putMarkdown(
                app,
                "vault/Index.md",
                "# Vault Index\n\n[[Sub Note#Deep Section]]\n",
            )
            val vaultSubUri = RevocableTestDocumentsProvider.putMarkdown(
                app,
                "vault/Specs/Sub Note.md",
                "# Sub Note\n\n## Deep Section\n",
            )
            val outsideRevokedUri = RevocableTestDocumentsProvider.putMarkdown(
                app,
                "outside/OutsideRevoked.md",
                "# Outside Vault\n",
            )
            RevocableTestDocumentsProvider.grantReadWrite(vaultHubUri)
            RevocableTestDocumentsProvider.grantReadWrite(vaultSubUri)
            RevocableTestDocumentsProvider.grantReadWrite(outsideRevokedUri)

            val outsideId = openAndAwait(scenario, model!!, outsideRevokedUri)
            val vaultSubId = openAndAwait(scenario, model!!, vaultSubUri)
            val linkedDraft = "# Sub Note\n\n## Deep Section\n\nUnsaved linked draft in vault.\n"
            editAndAwait(scenario, model!!, vaultSubId, linkedDraft)
            val vaultHubId = openAndAwait(scenario, model!!, vaultHubUri)
            waitForNodeText("Saved")

            scenario.moveToState(Lifecycle.State.CREATED)
            RevocableTestDocumentsProvider.revokeAll(vaultHubUri)
            RevocableTestDocumentsProvider.grantReadOnly(vaultHubUri)
            RevocableTestDocumentsProvider.revokeAll(vaultSubUri)
            RevocableTestDocumentsProvider.revokeAll(outsideRevokedUri)
            scenario.moveToState(Lifecycle.State.RESUMED)

            waitForCondition {
                !model!!.isRefreshExternalActive() &&
                    model!!.documentWriteNeedsAccess(vaultHubId) &&
                    model!!.documentWriteNeedsAccess(vaultSubId) &&
                    model!!.documentWriteNeedsAccess(outsideId)
            }
            waitForNodeText("Local draft · restore file access")

            // Trigger workspace link prompt from vault/Index.md -> [[Sub Note#Deep Section]] and grant READ-ONLY folder first.
            folderPickerResultRef.set {
                RevocableTestDocumentsProvider.grantReadOnly(vaultTreeUri)
                vaultTreeUri
            }
            CoroutineScope(Dispatchers.Main).launch {
                model!!.openWorkspaceLink(vaultHubUri.toString(), "Sub Note", "Deep Section", wikilink = true)
            }
            waitForNodeText("Allow folder access for note links")
            compose.onNodeWithText("Choose folder").assertIsDisplayed().performClick()

            waitForCondition {
                launchedTreeIntentRef.get() != null &&
                    model!!.state.value.folderAccessPrompt == null &&
                    model!!.state.value.active.id == vaultSubId
            }
            awaitReaderSnapshotPumpingCompose(model!!, vaultSubId)
            assertEquals(Intent.ACTION_OPEN_DOCUMENT_TREE, launchedTreeIntentRef.get()!!.action)
            assertEquals(linkedDraft, model!!.state.value.tabs.single { it.id == vaultSubId }.content)
            assertTrue("Read-only folder grant must keep target note write-blocked", model!!.documentWriteNeedsAccess(vaultSubId))
            assertTrue("Read-only folder grant must keep hub note write-blocked", model!!.documentWriteNeedsAccess(vaultHubId))
            assertTrue("Outside note must remain write-blocked", model!!.documentWriteNeedsAccess(outsideId))
            waitForNodeText("Local draft · restore file access")

            // Upgrade vaultTreeUri to read+write and apply shared folder: vault notes unblock and save cleanly,
            // while outside/OutsideRevoked.md remains write-blocked.
            RevocableTestDocumentsProvider.grantReadWrite(vaultTreeUri)
            scenario.onActivity {
                model!!.reading(autosave = true)
                model!!.setFolder(vaultTreeUri)
            }
            waitForCondition {
                !model!!.documentWriteNeedsAccess(vaultHubId) &&
                    !model!!.documentWriteNeedsAccess(vaultSubId) &&
                    !model!!.state.value.tabs.single { it.id == vaultSubId }.dirty
            }
            assertEquals(
                linkedDraft,
                RevocableTestDocumentsProvider.fileForDocId(app, "vault/Specs/Sub Note.md").readText(Charsets.UTF_8),
            )
            waitForNodeText("Saved")

            assertTrue("Note outside granted folder must stay write-blocked", model!!.documentWriteNeedsAccess(outsideId))
            selectAndAwait(scenario, model!!, outsideId)
            waitForNodeText("Local draft · restore file access")
        }
    }

    @Test
    fun renameNoteDialogRoutesRevokedAndDowngradedGrantsToRestoreAccessWithoutAutoReplay() {
        val workspaceKey = "emu-rename-${UUID.randomUUID().toString().take(8)}".also(workspaceKeys::add)
        val directBaseline = "# Direct Rename Baseline\n"
        val directUri = RevocableTestDocumentsProvider.putMarkdown(app, "DirectRename.md", directBaseline)
        RevocableTestDocumentsProvider.grantReadWrite(directUri)

        val treeUri = RevocableTestDocumentsProvider.treeUri(app, "renamevault")
        val treeBaseline = "# Vault Rename Baseline\n"
        RevocableTestDocumentsProvider.putMarkdown(app, "renamevault/TreeRename.md", treeBaseline)
        RevocableTestDocumentsProvider.grantReadWrite(treeUri)
        val treeDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "renamevault/TreeRename.md")

        val accessPickerResultRef = AtomicReference<((Uri?) -> Uri?)?>(null)
        MainActivity.defaultActivityResultRegistryOwnerForTest = object : ActivityResultRegistryOwner {
            override val activityResultRegistry: ActivityResultRegistry = object : ActivityResultRegistry() {
                override fun <I, O> onLaunch(
                    requestCode: Int,
                    contract: ActivityResultContract<I, O>,
                    input: I,
                    options: ActivityOptionsCompat?,
                ) {
                    if (contract is RestoreDocumentAccess) {
                        val callback = accessPickerResultRef.get()
                        val result = callback?.invoke(input as? Uri)
                        dispatchResult(requestCode, result)
                    } else {
                        dispatchResult(requestCode, Activity.RESULT_CANCELED, null)
                    }
                }
            }
        }

        val launchIntent = Intent(app, MainActivity::class.java)
            .putExtra("workspace", workspaceKey)

        ActivityScenario.launch<MainActivity>(launchIntent).use { scenario ->
            var model: StudioViewModel? = null
            scenario.onActivity { activity ->
                model = ViewModelProvider(activity)[StudioViewModel::class.java]
            }
            awaitActiveReader(model!!)

            // Part 1: Direct grant — ordinary provider error stays inline; downgraded/revoked grant routes to
            // Restore file access, preserves draft without auto-replaying rename, and pre-fills target name on retry.
            val directId = openAndAwait(scenario, model!!, directUri)
            val directDraft = "# Direct Rename Baseline\n\nUnsaved local draft preserved across rename denial.\n"
            editAndAwait(scenario, model!!, directId, directDraft)
            waitForNodeText("Unsaved")

            RevocableTestDocumentsProvider.setOrdinaryRenameError("DirectRename.md", true)
            compose.onNodeWithContentDescription("More actions").performClick()
            waitForNodeText("Rename note")
            compose.onNodeWithText("Rename note").performClick()
            waitForNodeText("Note name")
            compose.onNode(hasSetTextAction()).performTextReplacement("RenamedDirect")
            compose.onNodeWithText("Rename").performClick()

            waitForNodeText("Simulated transient provider rename error for DirectRename.md")
            assertFalse("Ordinary provider error must not mark write-blocked", model!!.documentWriteNeedsAccess(directId))
            assertNull(model!!.documentAccessRequests.value)
            assertEquals(directDraft, model!!.state.value.tabs.single { it.id == directId }.content)
            RevocableTestDocumentsProvider.setOrdinaryRenameError("DirectRename.md", false)
            compose.onNodeWithText("Cancel").performClick()
            waitForCondition { !compose.onAllNodesWithText("Note name").hasAnyNode() }

            // Downgrade direct grant to read-only right before submitting Rename note.
            RevocableTestDocumentsProvider.revokeAll(directUri)
            RevocableTestDocumentsProvider.grantReadOnly(directUri)
            compose.onNodeWithContentDescription("More actions").performClick()
            waitForNodeText("Rename note")
            compose.onNodeWithText("Rename note").performClick()
            waitForNodeText("Note name")
            compose.onNode(hasSetTextAction()).performTextReplacement("RenamedDirect")
            compose.onNodeWithText("Rename").performClick()

            waitForNodeText("Restore file access")
            assertFalse("Rename note dialog should hand off cleanly to Restore file access", compose.onAllNodesWithText("Note name").hasAnyNode())
            assertTrue(model!!.documentWriteNeedsAccess(directId))
            assertNull(model!!.state.value.error)
            assertEquals("DirectRename.md", model!!.state.value.tabs.single { it.id == directId }.name)
            assertEquals(directDraft, model!!.state.value.tabs.single { it.id == directId }.content)

            val attemptsBeforeRestore = RevocableTestDocumentsProvider.renameAttempts("DirectRename.md")
            accessPickerResultRef.set {
                RevocableTestDocumentsProvider.grantReadWrite(directUri)
                directUri
            }
            compose.onNodeWithText("Choose original file").performClick()
            waitForCondition {
                !model!!.documentWriteNeedsAccess(directId) &&
                    model!!.documentAccessRequests.value == null
            }
            assertEquals("Restore must not auto-replay rename", attemptsBeforeRestore, RevocableTestDocumentsProvider.renameAttempts("DirectRename.md"))
            assertEquals("DirectRename.md", model!!.state.value.tabs.single { it.id == directId }.name)
            assertEquals(directDraft, model!!.state.value.tabs.single { it.id == directId }.content)
            assertTrue(RevocableTestDocumentsProvider.fileForDocId(app, "DirectRename.md").exists())
            assertFalse(RevocableTestDocumentsProvider.fileForDocId(app, "RenamedDirect.md").exists())

            // Explicit user retry re-opens Rename note with the previously typed target name preserved.
            compose.onNodeWithContentDescription("More actions").performClick()
            waitForNodeText("Rename note")
            compose.onNodeWithText("Rename note").performClick()
            waitForCondition { compose.onAllNodes(hasSetTextAction() and hasText("RenamedDirect")).hasAnyNode() }
            compose.onNodeWithText("Rename").performClick()
            waitForCondition {
                model!!.state.value.tabs.single { it.id == directId }.name == "RenamedDirect.md"
            }
            assertEquals(directDraft, model!!.state.value.tabs.single { it.id == directId }.content)
            assertEquals(directBaseline, RevocableTestDocumentsProvider.fileForDocId(app, "RenamedDirect.md").readText(Charsets.UTF_8))

            // Part 2: Containing-folder tree grant downgraded (read-only) & revoked -> Rename routes to Restore file
            // access, preserves draft, does not auto-replay when folder RW returns, and succeeds on explicit retry.
            scenario.onActivity { model!!.setFolder(treeUri) }
            waitForCondition {
                model!!.state.value.folder == treeUri.toString() &&
                    model!!.state.value.files.any { it.name == "TreeRename.md" }
            }
            val treeTabId = openAndAwait(scenario, model!!, treeDocUri, relative = "TreeRename.md")
            val treeDraft = "# Vault Rename Baseline\n\nUnsaved folder note draft.\n"
            editAndAwait(scenario, model!!, treeTabId, treeDraft)

            RevocableTestDocumentsProvider.revokeAll(treeUri)
            RevocableTestDocumentsProvider.grantReadOnly(treeUri)
            compose.onNodeWithContentDescription("More actions").performClick()
            waitForNodeText("Rename note")
            compose.onNodeWithText("Rename note").performClick()
            waitForNodeText("Note name")
            compose.onNode(hasSetTextAction()).performTextReplacement("RenamedVaultNote")
            compose.onNodeWithText("Rename").performClick()

            waitForNodeText("Restore file access")
            assertTrue(model!!.documentWriteNeedsAccess(treeTabId))
            assertNull(model!!.state.value.error)
            assertEquals("TreeRename.md", model!!.state.value.tabs.single { it.id == treeTabId }.name)
            assertEquals(treeDraft, model!!.state.value.tabs.single { it.id == treeTabId }.content)
            compose.onNodeWithText("Not now").performClick()

            RevocableTestDocumentsProvider.revokeAll(treeUri)
            compose.onNodeWithContentDescription("More actions").performClick()
            waitForNodeText("Rename note")
            compose.onNodeWithText("Rename note").performClick()
            waitForCondition { compose.onAllNodes(hasSetTextAction() and hasText("RenamedVaultNote")).hasAnyNode() }
            compose.onNodeWithText("Rename").performClick()

            waitForNodeText("Restore file access")
            assertTrue(model!!.documentWriteNeedsAccess(treeTabId))
            assertNull(model!!.state.value.error)
            assertEquals("TreeRename.md", model!!.state.value.tabs.single { it.id == treeTabId }.name)
            assertEquals(treeDraft, model!!.state.value.tabs.single { it.id == treeTabId }.content)

            compose.onNodeWithText("Not now").performClick()
            RevocableTestDocumentsProvider.grantReadWrite(treeUri)
            scenario.onActivity { model!!.setFolder(treeUri) }
            waitForCondition {
                !model!!.documentWriteNeedsAccess(treeTabId) &&
                    model!!.state.value.files.any { it.name == "TreeRename.md" }
            }
            assertEquals("Folder regrant must not auto-replay rename", "TreeRename.md", model!!.state.value.tabs.single { it.id == treeTabId }.name)
            assertFalse(RevocableTestDocumentsProvider.fileForDocId(app, "renamevault/RenamedVaultNote.md").exists())

            compose.onNodeWithContentDescription("More actions").performClick()
            waitForNodeText("Rename note")
            compose.onNodeWithText("Rename note").performClick()
            waitForCondition { compose.onAllNodes(hasSetTextAction() and hasText("RenamedVaultNote")).hasAnyNode() }
            compose.onNodeWithText("Rename").performClick()
            waitForCondition {
                model!!.state.value.tabs.single { it.id == treeTabId }.name == "RenamedVaultNote.md"
            }
            assertEquals(treeDraft, model!!.state.value.tabs.single { it.id == treeTabId }.content)
            assertEquals(treeBaseline, RevocableTestDocumentsProvider.fileForDocId(app, "renamevault/RenamedVaultNote.md").readText(Charsets.UTF_8))
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
