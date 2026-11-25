package dev.supermd.studio

import android.net.Uri
import android.os.Looper
import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.Random
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.zip.Deflater
import java.util.zip.GZIPOutputStream

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PortableUnchangedAssetSaveTest {
    private val pngSignature = byteArrayOf(
        0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    )

    private fun syntheticPngBytes(payloadBytes: Int, seed: Long): ByteArray {
        val out = ByteArray(pngSignature.size + payloadBytes)
        System.arraycopy(pngSignature, 0, out, 0, pngSignature.size)
        val random = Random(seed)
        val tail = ByteArray(payloadBytes)
        random.nextBytes(tail)
        System.arraycopy(tail, 0, out, pngSignature.size, payloadBytes)
        return out
    }

    private fun svgBytes(label: String, repeatCount: Int = 64): ByteArray {
        val body = buildString {
            append("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 100'>")
            repeat(repeatCount) { idx ->
                append("<text x='10' y='${16 + (idx % 5) * 14}'>$label-$idx</text>")
            }
            append("</svg>")
        }
        return body.toByteArray(Charsets.UTF_8)
    }

    private fun dataUrl(mime: String, bytes: ByteArray): String =
        "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun pumpMainLooper(advanceMs: Long = 25) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(advanceMs))
    }

    private fun awaitJob(job: Job, timeoutMs: Long = 8_000) {
        val deadlineNs = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (!job.isCompleted && System.nanoTime() < deadlineNs) {
            pumpMainLooper(25)
            Thread.sleep(10)
        }
        pumpMainLooper(25)
        assertTrue("Job did not complete within ${timeoutMs}ms", job.isCompleted)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    private fun <T> awaitSuspend(timeoutMs: Long = 8_000, block: suspend () -> T): T {
        val deferred = CoroutineScope(Dispatchers.Default).async { block() }
        awaitJob(deferred, timeoutMs)
        return deferred.getCompleted()
    }

    private fun awaitCondition(timeoutMs: Long = 8_000, predicate: () -> Boolean) {
        val deadlineNs = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (!predicate() && System.nanoTime() < deadlineNs) {
            pumpMainLooper(30)
            Thread.sleep(12)
        }
        pumpMainLooper(30)
        assertTrue("Condition did not complete within ${timeoutMs}ms", predicate())
    }

    private inline fun withStudioModel(
        autosave: Boolean = false,
        block: (app: android.app.Application, tempDir: File, bundlesRoot: File, baselineDirs: Set<String>, model: StudioViewModel) -> Unit,
    ) {
        val app = RuntimeEnvironment.getApplication()
        val bundlesRoot = File(app.filesDir, "portable-assets").apply { mkdirs() }
        val baselineDirs = bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty()
        val tempDir = Files.createTempDirectory("portable-unchanged-save").toFile()
        val workspaceKey = "test-${UUID.randomUUID()}"
        val store = androidx.lifecycle.ViewModelStore()
        val factory = object : androidx.lifecycle.ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T =
                StudioViewModel(app, workspaceKey).apply {
                    reading(autosave = autosave)
                    readerFlushRequester = { true }
                } as T
        }
        val model = androidx.lifecycle.ViewModelProvider(store, factory)[StudioViewModel::class.java]
        try {
            block(app, tempDir, bundlesRoot, baselineDirs, model)
        } finally {
            val openDirs = model.state.value.tabs.mapNotNull { it.assetDirectory }
            store.clear()
            openDirs.forEach { File(bundlesRoot, it).deleteRecursively() }
            File(app.filesDir, "workspaces/$workspaceKey.json").deleteRecursively()
            File(app.filesDir, "workspaces/$workspaceKey").deleteRecursively()
            tempDir.deleteRecursively()
        }
    }

    @Test
    fun repeatPortableSavesAvoidUnchangedAssetBase64AndDirectoryReextraction() = withStudioModel(autosave = false) { app, tempDir, bundlesRoot, baselineDirs, model ->
        assertEquals(3, PORTABLE_GZIP_LEVEL)

        val assetBytes = linkedMapOf(
            "assets/fig-1.png" to ("image/png" to syntheticPngBytes(48_000, 101L)),
            "assets/fig-2.png" to ("image/png" to syntheticPngBytes(48_000, 102L)),
            "assets/fig-3.png" to ("image/png" to syntheticPngBytes(48_000, 103L)),
            "assets/diagram-1.svg" to ("image/svg+xml" to svgBytes("alpha", 80)),
            "assets/diagram-2.svg" to ("image/svg+xml" to svgBytes("beta", 80)),
            "assets/diagram-3.svg" to ("image/svg+xml" to svgBytes("gamma", 80)),
        )
        val initialAssets = JSONObject()
        assetBytes.forEach { (key, spec) -> initialAssets.put(key, dataUrl(spec.first, spec.second)) }
        val imageLinks = assetBytes.keys.joinToString("\n") { "![Image]($it)" }
        val initialMd = "# Lecture 1\n\n$imageLinks\n"

        val smdFile = File(tempDir, "Lecture.smd")
        val seedMedia = MediaStorage(app)
        smdFile.outputStream().use { seedMedia.writeFmd(it, initialMd, initialAssets) }

        model.media.resetPortableCounters()
        awaitJob(model.open(Uri.fromFile(smdFile)))
        val noteId = model.state.value.active.id
        val initialDir = model.state.value.active.assetDirectory!!
        assertEquals(6, model.media.portableBase64Decodes.get())
        assertEquals(0, model.media.portableBase64Encodes.get())
        assertEquals(6, model.media.portableAssetExtractions.get())

        // 1. Manual save after editing Markdown reprocesses 0 unchanged assets and reuses assetDirectory.
        val secondMd = "# Lecture 1 (edited)\n\nAdded summary paragraph.\n\n$imageLinks\n"
        model.edit(noteId, secondMd)
        model.media.resetPortableCounters()
        model.saveManual(noteId = noteId)
        awaitCondition { !model.state.value.active.dirty && !model.state.value.busy }
        assertNull(model.state.value.error)
        assertEquals(0, model.media.portableBase64Decodes.get())
        assertEquals(0, model.media.portableBase64Encodes.get())
        assertEquals(0, model.media.portableAssetExtractions.get())
        assertEquals(initialDir, model.state.value.active.assetDirectory)
        assertEquals(baselineDirs + initialDir, bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty())

        // Verify independent reader opens updated Markdown and exact original asset bytes.
        val verifyMedia = MediaStorage(app)
        val openedAfterManual = smdFile.inputStream().use(verifyMedia::openFmd)
        try {
            assertEquals(secondMd, openedAfterManual.markdown)
            assetBytes.forEach { (key, spec) ->
                assertArrayEquals(spec.second, verifyMedia.local(key, openedAfterManual.directory)!!.readBytes())
            }
        } finally {
            File(bundlesRoot, openedAfterManual.directory).deleteRecursively()
        }

        // 2. Reader bridge writePortable passing fresh String copies of unchanged data URLs still performs 0 Base64 decodes.
        val freshBridgeAssets = JSONObject()
        assetBytes.forEach { (key, spec) ->
            val freshCopy = String(dataUrl(spec.first, spec.second).toCharArray())
            freshBridgeAssets.put(key, freshCopy)
        }
        val thirdMd = "# Lecture 1 (reader bridge save)\n\n$imageLinks\n"
        model.edit(noteId, thirdMd)
        model.media.resetPortableCounters()
        awaitSuspend {
            model.writePortable(noteId, thirdMd, freshBridgeAssets, save = true, originalContent = thirdMd)
        }
        assertEquals(0, model.media.portableBase64Decodes.get())
        assertEquals(0, model.media.portableBase64Encodes.get())
        assertEquals(0, model.media.portableAssetExtractions.get())
        assertEquals(initialDir, model.state.value.active.assetDirectory)

        // 3. Adding 1 new image alongside 6 unchanged images decodes and extracts ONLY the 1 new image.
        val addedPng = syntheticPngBytes(24_000, 999L)
        val sevenAssets = JSONObject(freshBridgeAssets.toString())
            .put("assets/fig-added.png", String(dataUrl("image/png", addedPng).toCharArray()))
        val fourthMd = "$thirdMd\n![Added](assets/fig-added.png)\n"
        model.edit(noteId, fourthMd)
        model.media.resetPortableCounters()
        awaitSuspend {
            model.writePortable(noteId, fourthMd, sevenAssets, save = true, originalContent = fourthMd)
        }
        assertEquals(1, model.media.portableBase64Decodes.get())
        assertEquals(0, model.media.portableBase64Encodes.get())
        assertEquals(1, model.media.portableAssetExtractions.get())
        val sevenAssetDir = model.state.value.active.assetDirectory!!
        assertNotEquals(initialDir, sevenAssetDir)

        // 4. Autosave (writeLocalPortable) after a text edit performs 0 Base64 decodes and 0 Base64 encodes.
        model.reading(autosave = true)
        val fifthMd = "$fourthMd\nAutosaved note line.\n"
        model.media.resetPortableCounters()
        model.edit(noteId, fifthMd)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1_500))
        awaitCondition { !model.state.value.active.dirty }
        assertEquals(0, model.media.portableBase64Decodes.get())
        assertEquals(0, model.media.portableBase64Encodes.get())
        assertEquals(0, model.media.portableAssetExtractions.get())
        model.reading(autosave = false)

        // 5. Agent in-place portable save after text edit performs 0 Base64 decodes, 0 encodes, and 0 extractions.
        val sixthMd = "$fifthMd\nAgent paragraph.\n"
        model.edit(noteId, sixthMd)
        model.media.resetPortableCounters()
        awaitSuspend {
            model.saveAgentPortable(noteId, agentContentRevision(sixthMd))
        }
        assertFalse(model.state.value.active.dirty)
        assertEquals(0, model.media.portableBase64Decodes.get())
        assertEquals(0, model.media.portableBase64Encodes.get())
        assertEquals(0, model.media.portableAssetExtractions.get())
        assertEquals(sevenAssetDir, model.state.value.active.assetDirectory)

        // 6. Agent attach action adds 1 relay-validated SVG without re-decoding the 7 unchanged assets.
        val relaySvg = svgBytes("relay-attached", 16)
        model.media.resetPortableCounters()
        val attachResult = awaitSuspend {
            model.agentAssetAction(
                JSONObject()
                    .put("tabId", noteId)
                    .put("assetAction", "attach")
                    .put("expectedRevision", agentContentRevision(sixthMd))
                    .put("assetName", "relay.svg")
                    .put("mimeType", "image/svg+xml")
                    .put("body", Base64.encodeToString(relaySvg, Base64.NO_WRAP)),
            )
        }
        assertTrue(attachResult.getBoolean("saved"))
        assertEquals(0, model.media.portableBase64Decodes.get())
        assertEquals(0, model.media.portableBase64Encodes.get())
        assertEquals(1, model.media.portableAssetExtractions.get())
        val eightAssetDir = model.state.value.active.assetDirectory!!
        assertArrayEquals(relaySvg, model.media.local("assets/relay.svg", eightAssetDir)!!.readBytes())
        File(bundlesRoot, initialDir).deleteRecursively()
        File(bundlesRoot, sevenAssetDir).deleteRecursively()
    }

    @Test
    fun multiMegabyteRepeatSaveMeasurementAndLegacyLevelNineCompatibility() = withStudioModel(autosave = false) { app, tempDir, bundlesRoot, _, model ->
        val assets = JSONObject()
        val links = StringBuilder()
        repeat(8) { index ->
            val key = "assets/chart-$index.png"
            val bytes = syntheticPngBytes(380_000, 5_000L + index)
            assets.put(key, dataUrl("image/png", bytes))
            links.append("![Chart $index]($key)\n")
        }
        val markdown = "# Multi-MB Benchmark Note\n\n$links"
        val smdFile = File(tempDir, "Benchmark.smd")

        // Write a legacy Deflater.BEST_COMPRESSION (level 9) archive to verify backward compatibility.
        val legacyOut = ByteArrayOutputStream()
        object : GZIPOutputStream(legacyOut, 8192) {
            init {
                def.setLevel(Deflater.BEST_COMPRESSION)
            }
        }.writer(Charsets.UTF_8).use { writer ->
            val envelope = JSONObject()
                .put("format", "supermd-smd")
                .put("version", 1)
                .put("markdown", markdown)
                .put("assets", assets)
            writer.write(envelope.toString())
        }
        smdFile.writeBytes(legacyOut.toByteArray())

        awaitJob(model.open(Uri.fromFile(smdFile)))
        val noteId = model.state.value.active.id
        assertTrue(model.media.portableEnvelopeMatches(ByteArrayInputStream(smdFile.readBytes()), markdown, model.media.portableAssets(model.state.value.active.assetDirectory)))

        val editedMarkdown = "$markdown\n## Summary\n\nUpdated conclusion without touching embedded charts.\n"
        model.edit(noteId, editedMarkdown)
        model.media.resetPortableCounters()
        val startedNs = System.nanoTime()
        model.saveManual(noteId = noteId)
        awaitCondition { !model.state.value.active.dirty && !model.state.value.busy }
        val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNs)

        assertEquals(0, model.media.portableBase64Decodes.get())
        assertEquals(0, model.media.portableBase64Encodes.get())
        assertEquals(0, model.media.portableAssetExtractions.get())
        assertTrue("Expected repeat 3MB portable save to finish well under 5s, took ${elapsedMs}ms", elapsedMs < 5_000)

        val checkMedia = MediaStorage(app)
        val reopened = smdFile.inputStream().use(checkMedia::openFmd)
        try {
            assertEquals(editedMarkdown, reopened.markdown)
            assertEquals(8, checkMedia.portableAssets(reopened.directory).length())
        } finally {
            File(bundlesRoot, reopened.directory).deleteRecursively()
        }
    }

    @Test
    fun archiveValidationPreservesMalformedBase64MimeAggregateSizeAndEnvelopeChecks() {
        val app = RuntimeEnvironment.getApplication()
        val media = MediaStorage(app)

        // 1. Malformed Base64 payloads are rejected on writeFmd, openFmd, and portableEnvelopeMatches.
        val malformedPayloads = listOf(
            "data:image/png;base64,@@@@",
            "data:image/png;base64,ABC",
            "data:image/png;base64,A===",
            "data:image/png;base64,AB=C",
        )
        for (bad in malformedPayloads) {
            assertThrows("Expected writeFmd to reject $bad", IllegalArgumentException::class.java) {
                media.writeFmd(ByteArrayOutputStream(), "# Bad", JSONObject().put("assets/bad.png", bad))
            }
            val rawEnvelope = JSONObject()
                .put("format", "supermd-smd")
                .put("version", 1)
                .put("markdown", "# Bad")
                .put("assets", JSONObject().put("assets/bad.png", bad))
                .toString()
                .toByteArray(Charsets.UTF_8)
            assertThrows("Expected openFmd to reject $bad", IllegalArgumentException::class.java) {
                media.openFmd(ByteArrayInputStream(rawEnvelope))
            }
            assertThrows("Expected portableEnvelopeMatches to reject $bad", IllegalArgumentException::class.java) {
                media.portableEnvelopeMatches(ByteArrayInputStream(rawEnvelope), "# Bad", JSONObject())
            }
        }

        // 2. Cached valid PNG data URL mapped under a .jpg asset name is still rejected.
        val validPngUrl = dataUrl("image/png", syntheticPngBytes(256, 7L))
        media.writeFmd(ByteArrayOutputStream(), "# Warm cache", JSONObject().put("assets/ok.png", validPngUrl))
        assertThrows(IllegalArgumentException::class.java) {
            media.writeFmd(
                ByteArrayOutputStream(),
                "# Mismatched extension",
                JSONObject().put("assets/wrong.jpg", validPngUrl),
                JSONObject().put("assets/wrong.jpg", validPngUrl),
            )
        }

        // 3. Aggregate 75 MB cap is enforced even when reusing a cached 20 MB asset 4 times (0 Base64 decodes needed).
        val twentyMbPng = dataUrl("image/png", ByteArray(20_000_000).also { System.arraycopy(pngSignature, 0, it, 0, pngSignature.size) })
        media.writeFmd(ByteArrayOutputStream(), "# Single 20MB", JSONObject().put("assets/one.png", twentyMbPng))
        media.resetPortableCounters()
        val eightyMbAssets = JSONObject()
            .put("assets/a.png", twentyMbPng)
            .put("assets/b.png", twentyMbPng)
            .put("assets/c.png", twentyMbPng)
            .put("assets/d.png", twentyMbPng)
        val ex = assertThrows(IllegalArgumentException::class.java) {
            media.writeFmd(ByteArrayOutputStream(), "# Too big total", eightyMbAssets, eightyMbAssets)
        }
        assertTrue(ex.message.orEmpty().contains("75 MB"))
        assertEquals(0, media.portableBase64Decodes.get())

        // 4. Unknown fields and trailing bytes after gzip stream are rejected by portableEnvelopeMatches.
        val unknownFieldBytes = """{"format":"supermd-smd","version":1,"markdown":"# Hi","assets":{},"extra":1}""".toByteArray(Charsets.UTF_8)
        assertThrows(IllegalStateException::class.java) {
            media.portableEnvelopeMatches(ByteArrayInputStream(unknownFieldBytes), "# Hi", JSONObject())
        }
        val validCompressed = ByteArrayOutputStream().also { media.writeFmd(it, "# Hi", JSONObject()) }.toByteArray()
        assertThrows(Exception::class.java) {
            media.portableEnvelopeMatches(ByteArrayInputStream(validCompressed + byteArrayOf(0x42)), "# Hi", JSONObject())
        }
    }

    @Test
    fun externalConflictsRollbackAndAssetReplacementInvalidateCacheCleanly() = withStudioModel(autosave = false) { app, tempDir, bundlesRoot, baselineDirs, model ->
        val svgOne = svgBytes("version-one", 8)
        val svgTwo = svgBytes("version-two", 8)
        val svgThree = svgBytes("version-three", 8)
        val markdown = "# Diagram Note\n\n![Diagram](assets/diagram.svg)\n"
        val smdFile = File(tempDir, "Diagram.smd")
        smdFile.outputStream().use {
            model.media.writeFmd(it, markdown, JSONObject().put("assets/diagram.svg", dataUrl("image/svg+xml", svgOne)))
        }

        awaitJob(model.open(Uri.fromFile(smdFile)))
        val noteId = model.state.value.active.id
        val initialDir = model.state.value.active.assetDirectory!!

        // 1. replacePortableAsset invalidates localFileCache and writes updated bytes to disk.
        val importFile = File(app.filesDir, "attachments/import-${UUID.randomUUID()}.svg").apply {
            parentFile?.mkdirs()
            writeBytes(svgTwo)
        }
        try {
            val replaceRes = awaitSuspend {
                model.replacePortableAsset(
                    id = noteId,
                    assetName = "assets/diagram.svg",
                    replacementPath = "assets/${importFile.name}",
                    expectedRevision = agentContentRevision(markdown),
                )
            }
            assertTrue(replaceRes.getBoolean("changed"))
            assertTrue(replaceRes.getBoolean("saved"))
            assertEquals(dataUrl("image/svg+xml", svgTwo), model.media.portableAssets(initialDir).getString("assets/diagram.svg"))

            val verifyMedia = MediaStorage(app)
            val afterReplace = smdFile.inputStream().use(verifyMedia::openFmd)
            try {
                assertArrayEquals(svgTwo, verifyMedia.local("assets/diagram.svg", afterReplace.directory)!!.readBytes())
            } finally {
                File(bundlesRoot, afterReplace.directory).deleteRecursively()
            }
        } finally {
            importFile.delete()
        }

        // 2. External embedded-asset modification on disk blocks both saveAgentPortable and saveManual without leaking temp dirs.
        val editedDraft = "# Diagram Note\n\nUpdated text.\n\n![Diagram](assets/diagram.svg)\n"
        model.edit(noteId, editedDraft)
        val externalBytes = ByteArrayOutputStream().also {
            MediaStorage(app).writeFmd(it, markdown, JSONObject().put("assets/diagram.svg", dataUrl("image/svg+xml", svgThree)))
        }.toByteArray()
        smdFile.writeBytes(externalBytes)

        assertThrows(IllegalArgumentException::class.java) {
            awaitSuspend {
                model.saveAgentPortable(noteId, agentContentRevision(editedDraft))
            }
        }
        assertArrayEquals("External file bytes must remain untouched on conflict", externalBytes, smdFile.readBytes())

        model.saveManual(noteId = noteId)
        awaitCondition { model.state.value.pendingSaveConflictNoteId == noteId }
        assertTrue(model.state.value.activeConflicted)
        assertEquals(baselineDirs + initialDir, bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty())

        // 3. Canonical filesDir symlink aliases resolve cleanly while unexpected stray entries force rematerialization.
        val alias = File(tempDir, "files-dir-alias")
        java.nio.file.Files.createSymbolicLink(alias.toPath(), app.filesDir.canonicalFile.toPath())
        val aliasedMedia = MediaStorage(
            object : android.content.ContextWrapper(app) {
                override fun getFilesDir(): File = alias
            },
        )
        val expectedLocalAssets = aliasedMedia.portableAssets(initialDir)
        assertTrue(aliasedMedia.hasExactLocalPortableAssets(initialDir, expectedLocalAssets))
        val strayTmp = File(File(bundlesRoot, initialDir), ".staging.tmp").apply { writeText("stray") }
        try {
            org.junit.Assert.assertFalse(aliasedMedia.hasExactLocalPortableAssets(initialDir, expectedLocalAssets))
        } finally {
            strayTmp.delete()
        }
    }

    @Test
    fun replacementDuringReadNeverCachesStaleBytesUnderNewerStateAndScopesCacheToAppStorage() {
        val app = RuntimeEnvironment.getApplication()
        val tempDir = Files.createTempDirectory("supermd-cache-race").toFile()
        val media = MediaStorage(app)
        val bundleDir = media.createEmptyPortableDirectory()
        val bundlesRoot = File(app.filesDir, "portable-assets")
        val bundleRoot = File(bundlesRoot, bundleDir)
        try {
            // Same-length payloads so even identical byte size cannot mask a mid-read replacement.
            val oldSvg = svgBytes("race-aaaa", 12)
            val newSvg = svgBytes("race-bbbb", 12)
            val thirdSvg = svgBytes("race-cccc", 12)
            assertEquals(oldSvg.size, newSvg.size)
            assertEquals(newSvg.size, thirdSvg.size)

            val assetFile = File(bundleRoot, "diagram.svg").apply { writeBytes(oldSvg) }

            // 1. Atomic replacement during read (matching StudioViewModel.replacePortableAsset's renameTo):
            //    reader captures old bytes before replacement completes; cache must NOT store old bytes
            //    under the newer file's stamp, and the very next read must return newSvg.
            var atomicHookFired = false
            media.localFileBytesReader = { target ->
                val capturedOldBytes = target.readBytes()
                if (!atomicHookFired) {
                    atomicHookFired = true
                    val staged = File(bundleRoot, ".diagram-replacement.tmp").apply { writeBytes(newSvg) }
                    check(staged.renameTo(target)) { "Atomic rename replacement failed" }
                }
                capturedOldBytes
            }
            val duringAtomicReplace = media.data(assetFile)
            assertEquals(dataUrl("image/svg+xml", oldSvg), duringAtomicReplace)
            assertEquals("Unstable mid-read replacement must not populate localFileCache", 0, media.cachedLocalAssetCount())

            media.localFileBytesReader = { it.readBytes() }
            media.resetPortableCounters()
            val afterAtomicReplace = media.data(assetFile)
            assertEquals(dataUrl("image/svg+xml", newSvg), afterAtomicReplace)
            assertEquals("Next stable read must re-encode the replaced file", 1, media.portableBase64Encodes.get())
            assertEquals("Stable read on app-owned asset populates cache", 1, media.cachedLocalAssetCount())

            // Subsequent unchanged read hits the cache with 0 encodes.
            media.resetPortableCounters()
            assertEquals(dataUrl("image/svg+xml", newSvg), media.data(assetFile))
            assertEquals(0, media.portableBase64Encodes.get())

            // 2. Concurrent invalidateLocalAsset + in-place mutation during read:
            //    even if a file is overwritten in-place while a reader is in flight and invalidated,
            //    the finishing reader must NOT repopulate stale bytes into localFileCache.
            media.invalidateLocalAsset(assetFile)
            assertEquals(0, media.cachedLocalAssetCount())

            var inPlaceHookFired = false
            media.localFileBytesReader = { target ->
                val capturedBytes = target.readBytes()
                if (!inPlaceHookFired) {
                    inPlaceHookFired = true
                    val previousMtime = target.lastModified()
                    target.writeBytes(thirdSvg)
                    target.setLastModified(previousMtime + 2_000L)
                    media.invalidateLocalAsset(target)
                }
                capturedBytes
            }
            val duringInPlaceUpdate = media.data(assetFile)
            assertEquals(dataUrl("image/svg+xml", newSvg), duringInPlaceUpdate)
            assertEquals("Invalidated/changed in-flight read must not cache stale bytes", 0, media.cachedLocalAssetCount())

            media.localFileBytesReader = { it.readBytes() }
            assertEquals(dataUrl("image/svg+xml", thirdSvg), media.portableAssets(bundleDir).getString("assets/diagram.svg"))
            assertEquals(1, media.cachedLocalAssetCount())

            // 3. Externally editable files outside app-owned storage (filesDir/portable-assets & filesDir/attachments)
            //    are never cached, even if overwritten in-place with identical size and coarse mtime.
            media.invalidateLocalAsset(bundleRoot)
            assertEquals(0, media.cachedLocalAssetCount())

            val externalFile = File(tempDir, "external.svg").apply { writeBytes(oldSvg) }
            val pinnedMtime = externalFile.lastModified()
            assertEquals(dataUrl("image/svg+xml", oldSvg), media.data(externalFile))
            assertEquals("Files outside app-controlled storage must not enter localFileCache", 0, media.cachedLocalAssetCount())

            externalFile.writeBytes(newSvg)
            externalFile.setLastModified(pinnedMtime)
            assertEquals(
                "External file overwritten with identical size and mtime must still read fresh bytes",
                dataUrl("image/svg+xml", newSvg),
                media.data(externalFile),
            )
            assertEquals(0, media.cachedLocalAssetCount())
        } finally {
            media.localFileBytesReader = { it.readBytes() }
            media.invalidateLocalAsset(bundleRoot)
            bundleRoot.deleteRecursively()
            tempDir.deleteRecursively()
        }
    }
}
