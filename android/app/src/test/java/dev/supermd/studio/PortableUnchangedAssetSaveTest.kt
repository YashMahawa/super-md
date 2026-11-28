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

        // 5. 1..150 new-asset filename cap alongside 1..159 compatibility read/export/re-save path.
        val maxNewFilename = "a".repeat(146) + ".png"
        val compatMidFilename = "a".repeat(147) + ".png"
        val compatMaxFilename = "a".repeat(155) + ".png"
        val overCompatFilename = "a".repeat(156) + ".png"
        val maxNewKey = "assets/$maxNewFilename"
        val compatMidKey = "assets/$compatMidFilename"
        val compatMaxKey = "assets/$compatMaxFilename"
        val overCompatKey = "assets/$overCompatFilename"
        assertTrue(isValidPortableAssetFilename(maxNewFilename))
        assertTrue(isValidPortableAssetKey(maxNewKey))
        for ((compatName, compatKey) in listOf(compatMidFilename to compatMidKey, compatMaxFilename to compatMaxKey)) {
            assertFalse(isValidPortableAssetFilename(compatName))
            assertFalse(isValidPortableAssetKey(compatKey))
            assertTrue(isValidCompatPortableAssetFilename(compatName))
            assertTrue(media.validKey(compatKey))
            val compatArchive = ByteArrayOutputStream().also {
                media.writeFmd(it, "# Legacy\n\n![Img](<$compatKey>)\n", JSONObject().put(compatKey, validPngUrl))
            }.toByteArray()
            val reopenedCompat = media.openFmd(ByteArrayInputStream(compatArchive))
            try {
                assertEquals("# Legacy\n\n![Img](<$compatKey>)\n", reopenedCompat.markdown)
                assertTrue(media.portableAssets(reopenedCompat.directory).has(compatKey))
            } finally {
                File(app.filesDir, "portable-assets/${reopenedCompat.directory}").deleteRecursively()
            }
        }
        val relayClient = AgentRelayClient()
        val relayPngBody = Base64.encodeToString(syntheticPngBytes(64, 9L), Base64.NO_WRAP)
        fun attachRequest(assetName: String) = JSONObject()
            .put("requestId", "asset_cap")
            .put("action", "asset_action")
            .put("tabId", "tab:device:workspace:1")
            .put("expectedRevision", "a".repeat(64))
            .put("assetAction", "attach")
            .put("assetName", assetName)
            .put("mimeType", "image/png")
            .put("body", relayPngBody)
        relayClient.validateRequest(attachRequest(maxNewKey))
        relayClient.validateRequest(attachRequest(maxNewFilename))
        for (compatRejectedNew in listOf(compatMidKey, compatMidFilename, compatMaxKey, compatMaxFilename)) {
            assertThrows(IllegalArgumentException::class.java) {
                relayClient.validateRequest(attachRequest(compatRejectedNew))
            }
        }
        for (badKey in listOf(overCompatKey, "assets/.", "assets/..")) {
            assertFalse("Expected validKey to reject $badKey", media.validKey(badKey))
            assertThrows(IllegalArgumentException::class.java) {
                media.writeFmd(ByteArrayOutputStream(), "# Bad key", JSONObject().put(badKey, validPngUrl))
            }
            val badEnvelope = JSONObject()
                .put("format", "supermd-smd")
                .put("version", 1)
                .put("markdown", "# Bad key")
                .put("assets", JSONObject().put(badKey, validPngUrl))
                .toString()
                .toByteArray(Charsets.UTF_8)
            assertThrows(IllegalArgumentException::class.java) {
                media.openFmd(ByteArrayInputStream(badEnvelope))
            }
            assertThrows(IllegalArgumentException::class.java) {
                relayClient.validateRequest(attachRequest(badKey))
            }
        }
        for (badName in listOf(overCompatFilename, ".", "..")) {
            assertThrows(IllegalArgumentException::class.java) {
                relayClient.validateRequest(attachRequest(badName))
            }
        }
    }

    @Test
    fun existingCompatAssetBundleOpensExportsAndResavesWithoutLosingAssetOrReference() = withStudioModel(autosave = false) { app, tempDir, bundlesRoot, _, model ->
        val compatKey = "assets/" + "a".repeat(155) + ".svg"
        assertEquals(159, compatKey.removePrefix("assets/").length)
        val svg = svgBytes("compat-159", 12)
        val svgDataUrl = dataUrl("image/svg+xml", svg)
        val initialMd = "# Existing Compat Note\n\n![Legacy](<$compatKey>)\n"
        val smdFile = File(tempDir, "LegacyCompat.smd")
        val seedMedia = MediaStorage(app)
        smdFile.outputStream().use { seedMedia.writeFmd(it, initialMd, JSONObject().put(compatKey, svgDataUrl)) }

        // 1. Open existing bundle with 159-char basename.
        awaitJob(model.open(Uri.fromFile(smdFile)))
        val noteId = model.state.value.active.id
        assertEquals(initialMd, model.state.value.active.content)
        val openedAssets = model.media.portableAssets(model.state.value.active.assetDirectory)
        assertTrue(openedAssets.has(compatKey))
        assertArrayEquals(svg, model.media.local(compatKey, model.state.value.active.assetDirectory)!!.readBytes())

        // 2. Export existing bundle to portable .smd and Markdown ZIP without losing its asset or reference.
        val exportDir = File(tempDir, "exports").apply { mkdirs() }
        val authority = "dev.supermd.test.portable.compat.${UUID.randomUUID()}"
        val provider = PortableOpaqueSafProvider(app, exportDir).also { it.attach(app, authority) }
        org.robolectric.shadows.ShadowContentResolver.registerProviderInternal(authority, provider)
        val treeUri = android.provider.DocumentsContract.buildTreeDocumentUri(authority, PortableOpaqueSafProvider.ROOT_ID)
        app.grantUriPermission(
            app.packageName,
            treeUri,
            android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
        val studioPrefs = app.getSharedPreferences("studio", 0)
        val previousNoteLocation = studioPrefs.getString("newNoteLocation", null)
        studioPrefs.edit().putString("newNoteLocation", treeUri.toString()).apply()
        try {
            val (exportedSmdUri, _) = awaitSuspend {
                model.writeAgentExport(initialMd, openedAssets, "smd", "ExportedCompat.smd", "{}")
            }
            val reopenedExport = app.contentResolver.openInputStream(exportedSmdUri)!!.use(seedMedia::openFmd)
            try {
                assertEquals(initialMd, reopenedExport.markdown)
                assertArrayEquals(svg, seedMedia.local(compatKey, reopenedExport.directory)!!.readBytes())
            } finally {
                File(bundlesRoot, reopenedExport.directory).deleteRecursively()
            }

            val (exportedZipUri, _) = awaitSuspend {
                model.writeAgentExport(initialMd, openedAssets, "mdzip", "ExportedCompat.zip", "{}")
            }
            val zipEntries = linkedMapOf<String, ByteArray>()
            java.util.zip.ZipInputStream(app.contentResolver.openInputStream(exportedZipUri)!!).use { zis ->
                while (true) {
                    val entry = zis.nextEntry ?: break
                    zipEntries[entry.name] = zis.readBytes()
                    zis.closeEntry()
                }
            }
            assertEquals(initialMd, zipEntries["ExportedCompat.md"]!!.toString(Charsets.UTF_8))
            assertArrayEquals(svg, zipEntries[compatKey])
        } finally {
            studioPrefs.edit().apply {
                if (previousNoteLocation == null) remove("newNoteLocation") else putString("newNoteLocation", previousNoteLocation)
            }.apply()
        }

        // 3. Reject attaching a new asset exceeding the 150-char cap (including extensionless stem -> 151 chars), then edit and re-save intact.
        val tooLongAttach = JSONObject()
            .put("tabId", noteId)
            .put("assetAction", "attach")
            .put("expectedRevision", agentContentRevision(initialMd))
            .put("assetName", "b".repeat(147))
            .put("mimeType", "image/svg+xml")
            .put("body", Base64.encodeToString(svg, Base64.NO_WRAP))
        assertThrows(IllegalArgumentException::class.java) {
            awaitSuspend { model.agentAssetAction(tooLongAttach) }
        }

        val editedMd = "$initialMd\nPreserved after re-save.\n"
        model.edit(noteId, editedMd)
        model.saveManual(noteId = noteId)
        awaitCondition { !model.state.value.active.dirty && !model.state.value.busy }
        assertNull(model.state.value.error)

        val reopenedResaved = smdFile.inputStream().use(seedMedia::openFmd)
        try {
            assertEquals(editedMd, reopenedResaved.markdown)
            assertTrue(reopenedResaved.markdown.contains(compatKey))
            assertArrayEquals(svg, seedMedia.local(compatKey, reopenedResaved.directory)!!.readBytes())
        } finally {
            File(bundlesRoot, reopenedResaved.directory).deleteRecursively()
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

    @Test
    fun providerAwareRenamePinnedRecentsAndSaveAsPreserveUnchangedAssetFastPath() = withStudioModel(autosave = false) { app, tempDir, bundlesRoot, _, model ->
        val authority = "dev.supermd.test.portable.opaque.${UUID.randomUUID()}"
        val provider = PortableOpaqueSafProvider(app, tempDir).also { it.attach(app, authority) }
        org.robolectric.shadows.ShadowContentResolver.registerProviderInternal(authority, provider)
        val treeUri = android.provider.DocumentsContract.buildTreeDocumentUri(authority, PortableOpaqueSafProvider.ROOT_ID)
        app.grantUriPermission(
            app.packageName,
            treeUri,
            android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )

        val pngOne = syntheticPngBytes(32_000, 701L)
        val svgOne = svgBytes("opaque-saf-diagram", 48)
        val seedAssets = JSONObject()
            .put("assets/chart.png", dataUrl("image/png", pngOne))
            .put("assets/flow.svg", dataUrl("image/svg+xml", svgOne))
        val initialMd = "# Workbook\n\n![Chart](assets/chart.png)\n![Flow](assets/flow.svg)\n"

        val mathDir = File(tempDir, "Sem1/Math").apply { mkdirs() }
        val seedFile = File(mathDir, "Workbook.smd")
        seedFile.outputStream().use { MediaStorage(app).writeFmd(it, initialMd, seedAssets) }

        val previousRecentJson = app.getSharedPreferences("studio", 0).getString("recent", "[]")
        try {
            model.setFolder(treeUri)
            awaitCondition { model.state.value.folder == treeUri.toString() }
            model.listFolder(treeUri, "Sem1/Math")
            awaitCondition {
                model.state.value.folderRelative == "Sem1/Math" &&
                    model.state.value.files.any { it.name == "Workbook.smd" }
            }
            val workbookEntry = model.state.value.files.single { it.name == "Workbook.smd" }
            val initialUri = Uri.parse(workbookEntry.uri)
            assertFalse(
                "Expected opaque documentId without path hierarchy",
                android.provider.DocumentsContract.getDocumentId(initialUri).contains('/'),
            )

            awaitJob(model.open(initialUri, workbookEntry.relative))
            val noteId = model.state.value.active.id
            val initialAssetDir = model.state.value.active.assetDirectory!!
            assertEquals("Sem1/Math/Workbook.smd", model.state.value.active.relative)

            model.pinRecent(initialUri.toString())
            assertTrue(model.recent.value.any { it.uri == initialUri.toString() && it.pinned && it.relative == "Sem1/Math/Workbook.smd" })

            // 1. Provider-aware tab rename rotates opaque ID, keeps pin + relative, and preserves 0-decode portable save.
            model.rename(noteId, "1.1 Linear Workbook")
            awaitCondition {
                model.state.value.active.name == "1.1 Linear Workbook.smd" &&
                    model.state.value.active.relative == "Sem1/Math/1.1 Linear Workbook.smd" &&
                    model.state.value.active.uri != initialUri.toString()
            }
            val renamedFileUri = model.state.value.active.uri!!
            assertTrue(
                "Pinned recent entry must track provider-rotated URI and relative path",
                model.recent.value.any {
                    it.uri == renamedFileUri &&
                        it.pinned &&
                        it.name == "1.1 Linear Workbook.smd" &&
                        it.relative == "Sem1/Math/1.1 Linear Workbook.smd"
                },
            )

            val afterTabRenameMd = "$initialMd\nAdded theorem notes after tab rename.\n"
            model.edit(noteId, afterTabRenameMd)
            model.media.resetPortableCounters()
            model.saveManual(noteId = noteId)
            awaitCondition { !model.state.value.active.dirty && !model.state.value.busy }
            assertNull(model.state.value.error)
            assertEquals(0, model.media.portableBase64Decodes.get())
            assertEquals(0, model.media.portableBase64Encodes.get())
            assertEquals(0, model.media.portableAssetExtractions.get())
            assertEquals(initialAssetDir, model.state.value.active.assetDirectory)
            assertEquals("Sem1/Math/1.1 Linear Workbook.smd", model.state.value.active.relative)
            assertTrue(
                "Portable save must preserve pinned recent entry and relative path",
                model.recent.value.any {
                    it.uri == renamedFileUri &&
                        it.pinned &&
                        it.relative == "Sem1/Math/1.1 Linear Workbook.smd"
                },
            )

            // 2. Provider-aware directory rename rotates subtree opaque IDs and preserves 0-decode portable save.
            model.listFolder(treeUri, "Sem1")
            awaitCondition {
                model.state.value.folderRelative == "Sem1" &&
                    model.state.value.files.any { it.directory && it.name == "Math" }
            }
            val sem1DocId = provider.docIdForExistingFile(File(tempDir, "Sem1"))
            val mathUri = Uri.parse(model.state.value.files.single { it.directory && it.name == "Math" }.uri)
            val renameRotatedLatch = java.util.concurrent.CountDownLatch(1)
            provider.afterRenameDocument = { renameRotatedLatch.countDown() }
            provider.afterChildrenQuery = { parentDocId ->
                if (parentDocId == sem1DocId) {
                    renameRotatedLatch.await(150, TimeUnit.MILLISECONDS)
                }
            }
            model.listFolder(treeUri, "Sem1/Math")
            model.renameFolderEntry(mathUri, "Sem1/Math", isDirectory = true, requested = "PureMath")
            awaitCondition {
                model.state.value.folderRelative == "Sem1/PureMath" &&
                    model.state.value.active.relative == "Sem1/PureMath/1.1 Linear Workbook.smd" &&
                    model.state.value.active.uri != renamedFileUri &&
                    model.state.value.files.any {
                        it.name == "1.1 Linear Workbook.smd" &&
                            it.uri == model.state.value.active.uri &&
                            it.relative == "Sem1/PureMath/1.1 Linear Workbook.smd"
                    }
            }
            provider.afterChildrenQuery = null
            provider.afterRenameDocument = null
            val rotatedDirNoteUri = model.state.value.active.uri!!
            assertTrue(
                "Any in-flight retired ID read during concurrent listing + rename must be a previously provider-issued ID",
                provider.snapshotRetiredIds().containsAll(provider.snapshotRetiredIdReads()),
            )
            assertEquals("Expected zero writes against retired documentIds", emptyList<String>(), provider.snapshotRetiredIdWrites())
            provider.clearRetiredIdReads()
            assertTrue(
                "Directory rename must preserve pinned recent entry with rotated child URI",
                model.recent.value.any {
                    it.uri == rotatedDirNoteUri &&
                        it.pinned &&
                        it.relative == "Sem1/PureMath/1.1 Linear Workbook.smd"
                },
            )

            val afterDirRenameMd = "$afterTabRenameMd\nAdded corollary after folder rename.\n"
            model.edit(noteId, afterDirRenameMd)
            val bridgeAssets = JSONObject()
                .put("assets/chart.png", String(dataUrl("image/png", pngOne).toCharArray()))
                .put("assets/flow.svg", String(dataUrl("image/svg+xml", svgOne).toCharArray()))
            model.media.resetPortableCounters()
            awaitSuspend {
                model.writePortable(noteId, afterDirRenameMd, bridgeAssets, save = true, originalContent = afterDirRenameMd)
            }
            assertEquals(0, model.media.portableBase64Decodes.get())
            assertEquals(0, model.media.portableBase64Encodes.get())
            assertEquals(0, model.media.portableAssetExtractions.get())
            assertEquals(initialAssetDir, model.state.value.active.assetDirectory)
            assertEquals("Sem1/PureMath/1.1 Linear Workbook.smd", model.state.value.active.relative)
            assertEquals("Sem1/PureMath", model.state.value.folderRelative)
            assertTrue(
                model.recent.value.any {
                    it.uri == rotatedDirNoteUri &&
                        it.pinned &&
                        it.relative == "Sem1/PureMath/1.1 Linear Workbook.smd"
                },
            )

            // 3. Portable Save As inside the open opaque SAF folder resolves openRel without re-decoding unchanged assets.
            val pureMathDocId = provider.docIdForExistingFile(File(tempDir, "Sem1/PureMath"))
            val pureMathDocUri = android.provider.DocumentsContract.buildDocumentUriUsingTree(treeUri, pureMathDocId)
            val saveAsTarget = android.provider.DocumentsContract.createDocument(
                app.contentResolver,
                pureMathDocUri,
                "application/vnd.supermd.smd",
                "Workbook Copy.smd",
            )!!
            val saveAsMd = "$afterDirRenameMd\nSaved as copy.\n"
            model.edit(noteId, saveAsMd)
            model.media.resetPortableCounters()
            model.completePortableSaveAs(saveAsTarget, noteId)
            awaitCondition {
                model.state.value.active.uri == saveAsTarget.toString() &&
                    !model.state.value.active.dirty &&
                    !model.state.value.busy
            }
            assertEquals(0, model.media.portableBase64Decodes.get())
            assertEquals(0, model.media.portableBase64Encodes.get())
            assertEquals("Workbook Copy.smd", model.state.value.active.name)
            assertEquals("Sem1/PureMath/Workbook Copy.smd", model.state.value.active.relative)
            assertEquals("Sem1/PureMath", model.state.value.folderRelative)
            assertTrue(
                "Reloaded folder must include newly saved copy without stale entries",
                model.state.value.files.any {
                    it.name == "Workbook Copy.smd" &&
                        it.uri == saveAsTarget.toString() &&
                        it.relative == "Sem1/PureMath/Workbook Copy.smd"
                },
            )
            assertEquals("Expected zero guessed documentId queries", emptyList<String>(), provider.snapshotGuessedIds())
            assertEquals("Expected zero writes against retired documentIds", emptyList<String>(), provider.snapshotRetiredIdWrites())
            assertEquals("Expected zero retired documentId reads after rename settled", emptyList<String>(), provider.snapshotRetiredIdReads())

            val saveAsCopyAssetDir = model.state.value.active.assetDirectory!!
            val verifyMedia = MediaStorage(app)
            val reopenedCopy = File(tempDir, "Sem1/PureMath/Workbook Copy.smd").inputStream().use(verifyMedia::openFmd)
            try {
                assertEquals(saveAsMd, reopenedCopy.markdown)
                assertArrayEquals(pngOne, verifyMedia.local("assets/chart.png", reopenedCopy.directory)!!.readBytes())
                assertArrayEquals(svgOne, verifyMedia.local("assets/flow.svg", reopenedCopy.directory)!!.readBytes())
            } finally {
                File(bundlesRoot, reopenedCopy.directory).deleteRecursively()
            }

            // 4. Standalone picker grant Save As (non-tree document URI) preserves the exact picker grant,
            //    derives openRel from the provider when inside the open folder, and clears relative when outside.
            val pickerInTreeFile = File(tempDir, "Sem1/PureMath/Picker Copy.smd")
            val pickerInTreeUri = provider.createPickerDocument(pickerInTreeFile)
            assertTrue(!android.provider.DocumentsContract.isTreeUri(pickerInTreeUri))
            val pickerInTreeMd = "$saveAsMd\nSaved via standalone picker grant inside open folder.\n"
            model.edit(noteId, pickerInTreeMd)
            model.media.resetPortableCounters()
            model.completePortableSaveAs(pickerInTreeUri, noteId)
            awaitCondition {
                model.state.value.active.uri == pickerInTreeUri.toString() &&
                    !model.state.value.active.dirty &&
                    !model.state.value.busy
            }
            assertEquals(0, model.media.portableBase64Decodes.get())
            assertEquals(0, model.media.portableBase64Encodes.get())
            assertEquals(pickerInTreeUri.toString(), model.state.value.active.uri)
            assertEquals("Picker Copy.smd", model.state.value.active.name)
            assertEquals("Sem1/PureMath/Picker Copy.smd", model.state.value.active.relative)
            assertEquals("Expected zero guessed documentId queries", emptyList<String>(), provider.snapshotGuessedIds())
            assertEquals("Expected zero writes against retired documentIds", emptyList<String>(), provider.snapshotRetiredIdWrites())
            val pickerInTreeAssetDir = model.state.value.active.assetDirectory!!

            val pickerFollowupMd = "$pickerInTreeMd\nFollow-up in-place save on standalone grant.\n"
            model.edit(noteId, pickerFollowupMd)
            model.media.resetPortableCounters()
            model.saveManual(noteId = noteId)
            awaitCondition { !model.state.value.active.dirty && !model.state.value.busy }
            assertEquals(0, model.media.portableBase64Decodes.get())
            assertEquals(0, model.media.portableBase64Encodes.get())
            assertEquals(0, model.media.portableAssetExtractions.get())
            assertEquals(pickerInTreeUri.toString(), model.state.value.active.uri)
            assertEquals("Sem1/PureMath/Picker Copy.smd", model.state.value.active.relative)
            assertEquals("Expected zero guessed documentId queries", emptyList<String>(), provider.snapshotGuessedIds())
            assertEquals("Expected zero writes against retired documentIds", emptyList<String>(), provider.snapshotRetiredIdWrites())

            val outsideDir = Files.createTempDirectory("opaque-outside-save-as").toFile()
            try {
                val pickerOutsideFile = File(outsideDir, "Outside Copy.smd")
                val pickerOutsideUri = provider.createPickerDocument(pickerOutsideFile)
                val pickerOutsideMd = "$pickerFollowupMd\nSaved via standalone picker grant outside open folder.\n"
                model.edit(noteId, pickerOutsideMd)
                model.media.resetPortableCounters()
                model.completePortableSaveAs(pickerOutsideUri, noteId)
                awaitCondition {
                    model.state.value.active.uri == pickerOutsideUri.toString() &&
                        !model.state.value.active.dirty &&
                        !model.state.value.busy
                }
                assertEquals(0, model.media.portableBase64Decodes.get())
                assertEquals(0, model.media.portableBase64Encodes.get())
                assertEquals(pickerOutsideUri.toString(), model.state.value.active.uri)
                assertEquals("Outside Copy.smd", model.state.value.active.name)
                assertNull("Save As outside open folder must clear stale folder-relative path", model.state.value.active.relative)
                assertEquals("Expected zero guessed documentId queries", emptyList<String>(), provider.snapshotGuessedIds())
                assertEquals("Expected zero writes against retired documentIds", emptyList<String>(), provider.snapshotRetiredIdWrites())
            } finally {
                outsideDir.deleteRecursively()
            }

            File(bundlesRoot, saveAsCopyAssetDir).deleteRecursively()
            File(bundlesRoot, pickerInTreeAssetDir).deleteRecursively()
            File(bundlesRoot, initialAssetDir).deleteRecursively()
        } finally {
            app.getSharedPreferences("studio", 0).edit().putString("recent", previousRecentJson).apply()
        }
    }

    @Test
    fun inFlightRetiredOpaqueIdReadDuringRenameDistinguishedFromGuessedIdAndKeepsFolderAndSavedNoteCurrent() = withStudioModel { app, tempDir, bundlesRoot, _, model ->
        val authority = "dev.supermd.test.opaque.portable.retired.${UUID.randomUUID().toString().replace("-", "")}"
        val provider = PortableOpaqueSafProvider(app, tempDir)
        provider.attach(app, authority)
        org.robolectric.shadows.ShadowContentResolver.registerProviderInternal(authority, provider)

        val treeUri = android.provider.DocumentsContract.buildTreeDocumentUri(authority, PortableOpaqueSafProvider.ROOT_ID)
        app.grantUriPermission(
            app.packageName,
            treeUri,
            android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )

        val pngOne = syntheticPngBytes(28_000, 911L)
        val svgOne = svgBytes("retired-vs-guessed", 40)
        val seedAssets = JSONObject()
            .put("assets/chart.png", dataUrl("image/png", pngOne))
            .put("assets/flow.svg", dataUrl("image/svg+xml", svgOne))
        val initialMd = "# Workbook\n\n![Chart](assets/chart.png)\n![Flow](assets/flow.svg)\n"

        val mathDir = File(tempDir, "Sem1/Math").apply { mkdirs() }
        val seedFile = File(mathDir, "Workbook.smd")
        seedFile.outputStream().use { MediaStorage(app).writeFmd(it, initialMd, seedAssets) }

        val previousRecentJson = app.getSharedPreferences("studio", 0).getString("recent", "[]")
        val vmProjectedLatch = java.util.concurrent.CountDownLatch(1)
        val detachedProjectedLatch = java.util.concurrent.CountDownLatch(1)
        val allowChildQueryLatch = java.util.concurrent.CountDownLatch(1)
        val rotationCommittedLatch = java.util.concurrent.CountDownLatch(1)
        try {
            model.setFolder(treeUri)
            awaitCondition { model.state.value.folder == treeUri.toString() }
            awaitJob(model.listFolder(treeUri, "Sem1/Math"))
            val workbookEntry = model.state.value.files.single { it.name == "Workbook.smd" }
            val initialUri = Uri.parse(workbookEntry.uri)

            awaitJob(model.open(initialUri, workbookEntry.relative))
            val noteId = model.state.value.active.id
            val initialAssetDir = model.state.value.active.assetDirectory!!
            model.pinRecent(initialUri.toString())

            awaitJob(model.listFolder(treeUri, "Sem1"))
            val sem1DocId = provider.docIdForExistingFile(File(tempDir, "Sem1"))
            val mathEntry = model.state.value.files.single { it.directory && it.name == "Math" }
            val mathUri = Uri.parse(mathEntry.uri)
            val mathDocId = android.provider.DocumentsContract.getDocumentId(mathUri)

            // Pause an in-flight Sem1/Math listing right after Sem1/children returns mathDocId (opaque:item-2),
            // then rotate Sem1/Math -> Sem1/PureMath so in-flight projection deterministically queries retired mathDocId.
            // Release model.listFolder immediately if cancelled so pre-rename job joins (#142) never deadlock, while
            // a detached SAF projection guarantees the retired opaque ID read is exercised across rotation.
            val isDetachedProjection = ThreadLocal.withInitial { false }
            val vmHookArmed = java.util.concurrent.atomic.AtomicBoolean(true)
            val detachedHookArmed = java.util.concurrent.atomic.AtomicBoolean(true)
            var inFlightListJobRef: kotlinx.coroutines.Job? = null
            provider.onChildrenProjected = { parentDocId, childIds ->
                if (parentDocId == sem1DocId && mathDocId in childIds) {
                    if (isDetachedProjection.get() == true) {
                        if (detachedHookArmed.compareAndSet(true, false)) {
                            detachedProjectedLatch.countDown()
                            assertTrue(
                                "Timed out waiting for subtree rotation before resuming detached child query",
                                allowChildQueryLatch.await(5, TimeUnit.SECONDS),
                            )
                        }
                    } else if (vmHookArmed.compareAndSet(true, false)) {
                        vmProjectedLatch.countDown()
                        val waitDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                        while (allowChildQueryLatch.count > 0 &&
                            inFlightListJobRef?.isCancelled != true &&
                            System.nanoTime() < waitDeadline
                        ) {
                            allowChildQueryLatch.await(10, TimeUnit.MILLISECONDS)
                        }
                    }
                }
            }
            provider.onSubtreeRotated = {
                rotationCommittedLatch.countDown()
                allowChildQueryLatch.countDown()
            }

            val inFlightListJob = model.listFolder(treeUri, "Sem1/Math").also { inFlightListJobRef = it }
            val detachedListJob = CoroutineScope(Dispatchers.IO).async {
                isDetachedProjection.set(true)
                try {
                    runCatching {
                        listSafFolderListing(app.contentResolver, DocumentAccess(app), treeUri, "Sem1/Math")
                    }
                } finally {
                    isDetachedProjection.remove()
                }
            }
            val projectedDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while ((vmProjectedLatch.count > 0 || detachedProjectedLatch.count > 0) && System.nanoTime() < projectedDeadline) {
                pumpMainLooper(20)
                Thread.sleep(10)
            }
            assertEquals("Expected in-flight ViewModel listing to project Sem1 children", 0L, vmProjectedLatch.count)
            assertEquals("Expected detached SAF listing to project Sem1 children", 0L, detachedProjectedLatch.count)

            val concurrentMd = "$initialMd\nSaved concurrently across subtree rotation.\n"
            model.edit(noteId, concurrentMd)
            val bridgeAssets = JSONObject()
                .put("assets/chart.png", String(dataUrl("image/png", pngOne).toCharArray()))
                .put("assets/flow.svg", String(dataUrl("image/svg+xml", svgOne).toCharArray()))
            model.media.resetPortableCounters()

            val renameJob = model.renameFolderEntry(mathUri, "Sem1/Math", isDirectory = true, requested = "PureMath")
            val rotatedDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (rotationCommittedLatch.count > 0 && System.nanoTime() < rotatedDeadline) {
                pumpMainLooper(20)
                Thread.sleep(10)
            }
            assertEquals("Expected directory rename to rotate subtree IDs", 0L, rotationCommittedLatch.count)

            // Start a portable save right as subtree IDs have rotated on IO so write synchronization must wait for remapped note metadata.
            val concurrentSave = CoroutineScope(Dispatchers.Default).async {
                model.writePortable(noteId, concurrentMd, bridgeAssets, save = true, originalContent = concurrentMd)
            }
            runCatching { awaitJob(inFlightListJob) }
            awaitJob(detachedListJob)
            awaitJob(renameJob)
            awaitJob(concurrentSave)
            awaitCondition {
                model.state.value.folderRelative == "Sem1/PureMath" &&
                    !model.state.value.active.dirty &&
                    !model.state.value.busy &&
                    model.state.value.files.any { it.name == "Workbook.smd" }
            }

            // Deterministically confirm the retired opaque:item-2 read was recorded as retired (NOT guessed), with zero retired writes.
            assertTrue(
                "Expected in-flight listing to record retired mathDocId read ($mathDocId)",
                mathDocId in provider.snapshotRetiredIdReads(),
            )
            assertEquals("Expected zero guessed documentId queries", emptyList<String>(), provider.snapshotGuessedIds())
            assertEquals("Expected zero writes against retired documentIds", emptyList<String>(), provider.snapshotRetiredIdWrites())

            val rotatedNoteUri = model.state.value.active.uri!!
            assertNotEquals(initialUri.toString(), rotatedNoteUri)
            assertEquals("Sem1/PureMath/Workbook.smd", model.state.value.active.relative)
            assertEquals(concurrentMd, model.state.value.active.saved)
            assertEquals(initialAssetDir, model.state.value.active.assetDirectory)
            assertEquals(0, model.media.portableBase64Decodes.get())
            assertEquals(0, model.media.portableBase64Encodes.get())
            assertEquals(0, model.media.portableAssetExtractions.get())
            assertTrue(
                "Pinned recent must track rotated child URI and Sem1/PureMath relative path",
                model.recent.value.any {
                    it.uri == rotatedNoteUri &&
                        it.pinned &&
                        it.relative == "Sem1/PureMath/Workbook.smd"
                },
            )
            assertTrue(
                "Reloaded folder entries must match the current rotated child URI and relative path",
                model.state.value.files.any {
                    it.name == "Workbook.smd" &&
                        it.uri == rotatedNoteUri &&
                        it.relative == "Sem1/PureMath/Workbook.smd"
                },
            )
            val retiredSnapshot = provider.snapshotRetiredIds()
            assertTrue(
                "Reloaded folder must contain zero retired document IDs",
                model.state.value.files.none { android.provider.DocumentsContract.getDocumentId(Uri.parse(it.uri)) in retiredSnapshot },
            )

            // Clear in-flight retired reads and verify Save As inside and outside the open folder stays current with zero retired reads.
            provider.clearRetiredIdReads()
            val pureMathDocId = provider.docIdForExistingFile(File(tempDir, "Sem1/PureMath"))
            val pureMathDocUri = android.provider.DocumentsContract.buildDocumentUriUsingTree(treeUri, pureMathDocId)
            val saveAsInFolder = android.provider.DocumentsContract.createDocument(
                app.contentResolver,
                pureMathDocUri,
                "application/vnd.supermd.smd",
                "Workbook Copy.smd",
            )!!
            val saveAsMd = "$concurrentMd\nSaved as copy in PureMath.\n"
            model.edit(noteId, saveAsMd)
            model.media.resetPortableCounters()
            model.completePortableSaveAs(saveAsInFolder, noteId)
            awaitCondition {
                model.state.value.active.uri == saveAsInFolder.toString() &&
                    !model.state.value.active.dirty &&
                    !model.state.value.busy
            }
            val copyAssetDir = model.state.value.active.assetDirectory!!
            assertEquals(0, model.media.portableBase64Decodes.get())
            assertEquals(0, model.media.portableBase64Encodes.get())
            assertEquals("Workbook Copy.smd", model.state.value.active.name)
            assertEquals("Sem1/PureMath/Workbook Copy.smd", model.state.value.active.relative)
            assertTrue(
                model.state.value.files.any {
                    it.name == "Workbook Copy.smd" &&
                        it.uri == saveAsInFolder.toString() &&
                        it.relative == "Sem1/PureMath/Workbook Copy.smd"
                },
            )
            assertEquals("Expected zero post-settle retired documentId reads", emptyList<String>(), provider.snapshotRetiredIdReads())
            assertEquals("Expected zero guessed documentId queries", emptyList<String>(), provider.snapshotGuessedIds())

            val outsideDir = Files.createTempDirectory("portable-outside-folder").toFile()
            try {
                val outsideTarget = File(outsideDir, "Outside Copy.smd")
                model.completePortableSaveAs(Uri.fromFile(outsideTarget), noteId)
                awaitCondition {
                    model.state.value.active.uri == Uri.fromFile(outsideTarget).toString() &&
                        !model.state.value.active.dirty &&
                        !model.state.value.busy
                }
                assertNull("Save As outside open folder must clear stale folder-relative path", model.state.value.active.relative)
                assertEquals(0, model.media.portableBase64Decodes.get())
                assertEquals(0, model.media.portableBase64Encodes.get())
                assertEquals("Expected zero guessed documentId queries", emptyList<String>(), provider.snapshotGuessedIds())

                // Prove the zero guessed-ID guard actively records fabricated/path-derived documentIds never issued by the provider.
                val fabricatedUri = android.provider.DocumentsContract.buildDocumentUriUsingTree(treeUri, "Sem1/PureMath/Workbook Copy.smd")
                app.contentResolver.getType(fabricatedUri)
                assertEquals(listOf("Sem1/PureMath/Workbook Copy.smd"), provider.snapshotGuessedIds())
            } finally {
                outsideDir.deleteRecursively()
                File(bundlesRoot, copyAssetDir).deleteRecursively()
                File(bundlesRoot, initialAssetDir).deleteRecursively()
            }
        } finally {
            provider.onChildrenProjected = null
            provider.onSubtreeRotated = null
            allowChildQueryLatch.countDown()
            app.getSharedPreferences("studio", 0).edit().putString("recent", previousRecentJson).apply()
        }
    }

    @Test
    fun readerReadySaveManualAndSaveAsReuseNativeFastPathAndPreserveMixedAssetsConsentAndStaleChecks() =
        withStudioModel(autosave = false) { app, tempDir, bundlesRoot, _, model ->
            val assetBytes = linkedMapOf(
                "assets/fig-1.png" to ("image/png" to syntheticPngBytes(40_000, 301L)),
                "assets/fig-2.png" to ("image/png" to syntheticPngBytes(40_000, 302L)),
                "assets/diagram-1.svg" to ("image/svg+xml" to svgBytes("reader-fast-a", 48)),
                "assets/diagram-2.svg" to ("image/svg+xml" to svgBytes("reader-fast-b", 48)),
            )
            val initialAssets = JSONObject()
            assetBytes.forEach { (key, spec) -> initialAssets.put(key, dataUrl(spec.first, spec.second)) }
            val imageLinks = assetBytes.keys.joinToString("\n") { "![Image]($it)" }
            val initialMd = "# Reader Ready Note\n\n$imageLinks\n"

            val smdFile = File(tempDir, "ReaderReady.smd")
            MediaStorage(app).let { seed -> smdFile.outputStream().use { seed.writeFmd(it, initialMd, initialAssets) } }

            awaitJob(model.open(Uri.fromFile(smdFile)))
            val noteId = model.state.value.active.id
            val initialDir = model.state.value.active.assetDirectory!!

            // Wire a live reader flush + requestPortableWrite hook matching MainActivity when readerReady == true.
            var pendingReaderDraft: Pair<String, String>? = null
            val portableRequests = mutableListOf<StudioViewModel.PortableWriteRequest>()
            var handlePortableRequest: ((StudioViewModel.PortableWriteRequest) -> Unit)? = null
            model.readerFlushRequester = { flushId ->
                pendingReaderDraft?.takeIf { it.first == flushId }?.let { (id, draft) ->
                    pendingReaderDraft = null
                    model.readerEdit(id, draft, protocolPatch = true)
                }
                true
            }
            model.requestPortableWrite = { request ->
                portableRequests += request
                handlePortableRequest?.invoke(request)
                true
            }

            // 1. Reader-ready saveManual flushes live reader edits and writes unchanged local assets natively
            //    with 0 requestPortableWrite/prepareFmd calls and 0 Base64 decodes/encodes/extractions.
            val manualFlushedMd = "# Reader Ready Note (manual save)\n\nFlushed from reader.\n\n$imageLinks\n"
            pendingReaderDraft = noteId to manualFlushedMd
            model.media.resetPortableCounters()
            model.saveManual(noteId = noteId)
            awaitCondition { !model.state.value.active.dirty && !model.state.value.busy && model.state.value.active.saved == manualFlushedMd }
            assertNull(model.state.value.error)
            assertEquals("Expected 0 JS portable requests for unchanged local assets", emptyList<StudioViewModel.PortableWriteRequest>(), portableRequests)
            assertEquals(0, model.media.portableBase64Decodes.get())
            assertEquals(0, model.media.portableBase64Encodes.get())
            assertEquals(0, model.media.portableAssetExtractions.get())
            assertEquals(initialDir, model.state.value.active.assetDirectory)

            // 2. Reader-ready completePortableSaveAs flushes live reader edits and writes unchanged local assets natively
            //    with 0 requestPortableWrite/prepareFmd calls and 0 Base64 decodes/encodes.
            val saveAsCopy = File(tempDir, "ReaderReady Copy.smd")
            val saveAsFlushedMd = "# Reader Ready Note (Save As copy)\n\nFlushed before Save As.\n\n$imageLinks\n"
            pendingReaderDraft = noteId to saveAsFlushedMd
            model.media.resetPortableCounters()
            model.completePortableSaveAs(Uri.fromFile(saveAsCopy), noteId)
            awaitCondition {
                model.state.value.active.uri == Uri.fromFile(saveAsCopy).toString() &&
                    !model.state.value.active.dirty &&
                    !model.state.value.busy
            }
            assertNull(model.state.value.error)
            assertEquals("Expected 0 JS portable requests on Save As with unchanged local assets", emptyList<StudioViewModel.PortableWriteRequest>(), portableRequests)
            assertEquals(0, model.media.portableBase64Decodes.get())
            assertEquals(0, model.media.portableBase64Encodes.get())
            val saveAsDir = model.state.value.active.assetDirectory!!

            val verifyMedia = MediaStorage(app)
            val reopenedCopy = saveAsCopy.inputStream().use(verifyMedia::openFmd)
            try {
                assertEquals(saveAsFlushedMd, reopenedCopy.markdown)
                assetBytes.forEach { (key, spec) ->
                    assertArrayEquals(spec.second, verifyMedia.local(key, reopenedCopy.directory)!!.readBytes())
                }
            } finally {
                File(bundlesRoot, reopenedCopy.directory).deleteRecursively()
            }

            // 3. Newly imported local attachment (assets/import-*) alongside unchanged bundle assets also stays on native fast path.
            val importedBytes = syntheticPngBytes(18_000, 777L)
            val importedMeta = model.media.importJson(
                org.json.JSONArray().put(JSONObject().put("name", "pasted.png").put("data", dataUrl("image/png", importedBytes))),
            ).getJSONObject(0)
            val importedSource = importedMeta.getString("source")
            model.markAssetsDirty(noteId)
            val withImportedMd = "$saveAsFlushedMd\n![Pasted](<$importedSource>)\n"
            pendingReaderDraft = noteId to withImportedMd
            model.media.resetPortableCounters()
            model.saveManual(noteId = noteId)
            awaitCondition { !model.state.value.active.dirty && !model.state.value.busy && model.state.value.active.saved == withImportedMd }
            assertEquals(emptyList<StudioViewModel.PortableWriteRequest>(), portableRequests)
            assertEquals("Only the 1 new attachment is encoded once from disk; 0 unchanged bundle assets are re-encoded", 1, model.media.portableBase64Encodes.get())
            assertEquals("Cache hit from importJson avoids re-decoding even the new attachment", 0, model.media.portableBase64Decodes.get())
            val importedDir = model.state.value.active.assetDirectory!!

            // 4. Newly referenced external relative image delegates to requestPortableWrite with localAssets,
            //    surfaces explicit linked-asset consent when ungranted, and merges unchanged local assets without Base64 transfer once resolved.
            val externalLinkedMd = "$withImportedMd\n![External diagram](diagrams/external.png)\n"
            pendingReaderDraft = noteId to externalLinkedMd
            val externalPng = syntheticPngBytes(22_000, 888L)

            // 4a. First attempt: ungranted linked external image reports explicit linked-file consent and cleans pending state.
            handlePortableRequest = { req ->
                val err = assertThrows(SecurityException::class.java) {
                    runCatching { awaitSuspend { model.asset(req.noteId, "diagrams/external.png") } }.getOrThrow()
                }
                assertTrue(model.reportLinkedAssetFailure(req.noteId, "diagrams/external.png", err))
            }
            model.saveManual(noteId = noteId)
            awaitCondition { !model.state.value.busy && model.documentAccessRequests.value != null }
            assertEquals(1, portableRequests.size)
            assertTrue(portableRequests.single().localAssets.containsAll(assetBytes.keys + importedSource))
            assertEquals("diagrams/external.png", model.documentAccessRequests.value?.assetSource)
            assertEquals(LINKED_ASSET_ACCESS_MESSAGE, model.state.value.message)

            // Dismissing the consent prompt and explicitly tapping Save again re-prompts linked-file consent.
            model.dismissDocumentAccess()
            assertNull(model.documentAccessRequests.value)
            model.saveManual(noteId = noteId)
            awaitCondition { !model.state.value.busy && model.documentAccessRequests.value != null }
            assertEquals("diagrams/external.png", model.documentAccessRequests.value?.assetSource)
            model.dismissDocumentAccess()

            // 4b. Once resolved in the reader, sending ONLY the 1 new asset with mergeLocalAssets = true preserves all 5 local assets with 0 unchanged decodes/encodes.
            portableRequests.clear()
            val rewrittenExternalMd = "$withImportedMd\n![External diagram](<assets/image-external.png>)\n"
            handlePortableRequest = { req ->
                CoroutineScope(Dispatchers.Default).async {
                    model.writePortable(
                        id = req.noteId,
                        content = rewrittenExternalMd,
                        assets = JSONObject().put("assets/image-external.png", String(dataUrl("image/png", externalPng).toCharArray())),
                        save = req.save,
                        originalContent = externalLinkedMd,
                        mergeLocalAssets = true,
                    )
                }
            }
            model.media.resetPortableCounters()
            model.saveManual(noteId = noteId)
            awaitCondition { !model.state.value.active.dirty && !model.state.value.busy && model.state.value.active.content == rewrittenExternalMd }
            assertEquals(1, portableRequests.size)
            assertEquals(1, model.media.portableBase64Decodes.get())
            assertEquals(0, model.media.portableBase64Encodes.get())
            assertEquals(1, model.media.portableAssetExtractions.get())
            val mergedDir = model.state.value.active.assetDirectory!!

            val reopenedMerged = saveAsCopy.inputStream().use(verifyMedia::openFmd)
            try {
                assertEquals(rewrittenExternalMd, reopenedMerged.markdown)
                assetBytes.forEach { (key, spec) ->
                    assertArrayEquals(spec.second, verifyMedia.local(key, reopenedMerged.directory)!!.readBytes())
                }
                assertArrayEquals(importedBytes, verifyMedia.local(importedSource, reopenedMerged.directory)!!.readBytes())
                assertArrayEquals(externalPng, verifyMedia.local("assets/image-external.png", reopenedMerged.directory)!!.readBytes())
            } finally {
                File(bundlesRoot, reopenedMerged.directory).deleteRecursively()
            }

            // 5. Stale-document check: writePortable rejects outdated originalContent without overwriting the saved file.
            val beforeStaleBytes = saveAsCopy.readBytes()
            val newerLiveMd = "$rewrittenExternalMd\nNewer typing after export started.\n"
            model.edit(noteId, newerLiveMd)
            assertThrows(IllegalStateException::class.java) {
                awaitSuspend {
                    model.writePortable(
                        id = noteId,
                        content = rewrittenExternalMd,
                        assets = JSONObject(),
                        save = true,
                        originalContent = rewrittenExternalMd,
                        mergeLocalAssets = true,
                    )
                }
            }
            assertArrayEquals("Stale writePortable must leave on-disk bytes untouched", beforeStaleBytes, saveAsCopy.readBytes())
            assertEquals(newerLiveMd, model.state.value.active.content)

            File(bundlesRoot, initialDir).deleteRecursively()
            File(bundlesRoot, saveAsDir).deleteRecursively()
            File(bundlesRoot, importedDir).deleteRecursively()
            File(bundlesRoot, mergedDir).deleteRecursively()
            File(app.filesDir, "attachments/${importedSource.substringAfter('/')}").delete()
        }
}

private class PortableOpaqueSafProvider(
    private val appContext: android.content.Context,
    private val rootDir: File,
) : android.content.ContentProvider() {
    private var attachedAuthority: String = ""
    private var nextSeq = 1
    private val idToPath = linkedMapOf<String, String>()
    private val pathToId = linkedMapOf<String, String>()
    private val retiredIds = linkedSetOf<String>()
    private val guessedIdQueries = mutableListOf<String>()
    private val retiredIdReadQueries = mutableListOf<String>()
    private val retiredIdWriteOperations = mutableListOf<String>()
    @Volatile var onChildrenProjected: ((parentDocId: String, childDocIds: List<String>) -> Unit)? = null
    @Volatile var onSubtreeRotated: (() -> Unit)? = null
    @Volatile var afterChildrenQuery: ((parentDocId: String) -> Unit)? = null
    @Volatile var afterRenameDocument: (() -> Unit)? = null

    init {
        idToPath[ROOT_ID] = rootDir.canonicalPath
        pathToId[rootDir.canonicalPath] = ROOT_ID
    }

    fun attach(context: android.content.Context, authority: String) {
        attachedAuthority = authority
        attachInfo(
            context,
            android.content.pm.ProviderInfo().apply {
                this.authority = authority
                exported = true
                grantUriPermissions = true
            },
        )
    }

    override fun onCreate(): Boolean = true

    @Synchronized
    fun docIdForExistingFile(file: File): String = idForFile(file)

    @Synchronized
    fun snapshotGuessedIds(): List<String> = guessedIdQueries.toList()

    @Synchronized
    fun snapshotRetiredIds(): Set<String> = retiredIds.toSet()

    @Synchronized
    fun snapshotRetiredIdReads(): List<String> = retiredIdReadQueries.toList()

    @Synchronized
    fun snapshotRetiredIdWrites(): List<String> = retiredIdWriteOperations.toList()

    @Synchronized
    fun clearRetiredIdReads() {
        retiredIdReadQueries.clear()
    }

    @Synchronized
    fun createPickerDocument(file: File): Uri {
        file.parentFile?.mkdirs()
        check(file.createNewFile())
        val plainUri = android.provider.DocumentsContract.buildDocumentUri(attachedAuthority, idForFile(file))
        grantPermissions(plainUri)
        return plainUri
    }

    @Synchronized
    private fun idForFile(file: File): String {
        val canonical = file.canonicalPath
        return pathToId.getOrPut(canonical) {
            "opaque:item-${nextSeq++}".also { id -> idToPath[id] = canonical }
        }
    }

    @Synchronized
    private fun fileForId(documentId: String, writeOperation: Boolean = false): File {
        val path = idToPath[documentId]
        if (path != null) return File(path)
        if (documentId in retiredIds) {
            if (writeOperation) {
                retiredIdWriteOperations += documentId
            } else {
                retiredIdReadQueries += documentId
            }
            throw java.io.FileNotFoundException("Retired opaque documentId: $documentId")
        }
        guessedIdQueries += documentId
        throw java.io.FileNotFoundException("Unknown opaque documentId: $documentId")
    }

    @Synchronized
    private fun rotateSubtreeIds(oldCanonicalRoot: String, newRoot: File) {
        val iter = idToPath.entries.iterator()
        while (iter.hasNext()) {
            val (id, path) = iter.next()
            if (path == oldCanonicalRoot || path.startsWith(oldCanonicalRoot + File.separator)) {
                retiredIds += id
                iter.remove()
            }
        }
        pathToId.keys.removeIf { path ->
            path == oldCanonicalRoot || path.startsWith(oldCanonicalRoot + File.separator)
        }
        newRoot.walkTopDown().forEach { entry ->
            val freshId = "opaque:rotated-${nextSeq++}"
            val canonical = entry.canonicalPath
            idToPath[freshId] = canonical
            pathToId[canonical] = freshId
            grantPermissions(treeUriForDocId(freshId))
        }
    }

    private fun treeUriForDocId(docId: String): Uri {
        val tree = android.provider.DocumentsContract.buildTreeDocumentUri(attachedAuthority, ROOT_ID)
        return android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, docId)
    }

    private fun mimeFor(file: File): String =
        if (file.isDirectory) android.provider.DocumentsContract.Document.MIME_TYPE_DIR
        else when (file.extension.lowercase()) {
            "smd" -> "application/vnd.supermd.smd"
            "md" -> "text/markdown"
            else -> "application/octet-stream"
        }

    private fun includeFile(cursor: android.database.MatrixCursor, file: File): String {
        if (!file.exists()) throw java.io.FileNotFoundException(file.path)
        val flags = if (file.isDirectory) {
            android.provider.DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE or
                android.provider.DocumentsContract.Document.FLAG_SUPPORTS_RENAME
        } else {
            android.provider.DocumentsContract.Document.FLAG_SUPPORTS_WRITE or
                android.provider.DocumentsContract.Document.FLAG_SUPPORTS_RENAME
        }
        val docId = idForFile(file)
        val cols = cursor.columnNames
        val row = arrayOfNulls<Any>(cols.size)
        val displayName = if (file.canonicalPath == rootDir.canonicalPath) "OpaqueNotes" else file.name
        val size = if (file.isFile) file.length() else 0L
        for (i in cols.indices) {
            row[i] = when (cols[i]) {
                android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID -> docId
                android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                android.provider.OpenableColumns.DISPLAY_NAME -> displayName
                android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE -> mimeFor(file)
                android.provider.DocumentsContract.Document.COLUMN_SIZE,
                android.provider.OpenableColumns.SIZE -> size
                android.provider.DocumentsContract.Document.COLUMN_LAST_MODIFIED -> file.lastModified()
                android.provider.DocumentsContract.Document.COLUMN_FLAGS -> flags
                else -> null
            }
        }
        cursor.addRow(row)
        return docId
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): android.database.Cursor {
        val cols = projection ?: DEFAULT_DOC_PROJECTION
        val segments = uri.pathSegments
        if (segments.lastOrNull() == "children" && segments.size >= 2) {
            val parentDocId = Uri.decode(segments[segments.size - 2])
            val parent = fileForId(parentDocId)
            if (!parent.isDirectory) throw java.io.FileNotFoundException(parentDocId)
            val projectedChildIds = mutableListOf<String>()
            val cursor = android.database.MatrixCursor(cols).also { out ->
                parent.listFiles()?.forEach { child -> projectedChildIds += includeFile(out, child) }
            }
            onChildrenProjected?.invoke(parentDocId, projectedChildIds)
            afterChildrenQuery?.invoke(parentDocId)
            return cursor
        }
        val docId = android.provider.DocumentsContract.getDocumentId(uri)
        return android.database.MatrixCursor(cols).also { includeFile(it, fileForId(docId)) }
    }

    override fun getType(uri: Uri): String =
        runCatching { mimeFor(fileForId(android.provider.DocumentsContract.getDocumentId(uri))) }
            .getOrDefault("application/octet-stream")

    override fun insert(uri: Uri, values: android.content.ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: android.content.ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun call(method: String, arg: String?, extras: android.os.Bundle?): android.os.Bundle {
        val inExtras = extras ?: android.os.Bundle.EMPTY
        val docUri = inExtras.getParcelable("uri", Uri::class.java)
        val out = android.os.Bundle()
        when (method) {
            "android:createDocument" -> {
                val parentId = android.provider.DocumentsContract.getDocumentId(requireNotNull(docUri))
                val mimeType = inExtras.getString(android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE).orEmpty()
                val displayName = requireNotNull(inExtras.getString(android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME))
                val parent = fileForId(parentId, writeOperation = true)
                val target = File(parent, displayName)
                if (mimeType == android.provider.DocumentsContract.Document.MIME_TYPE_DIR) {
                    check(target.mkdirs() || target.isDirectory)
                } else {
                    check(target.createNewFile())
                }
                val outUri = treeUriForDocId(idForFile(target))
                grantPermissions(outUri)
                out.putParcelable("uri", outUri)
            }
            "android:renameDocument" -> {
                val docId = android.provider.DocumentsContract.getDocumentId(requireNotNull(docUri))
                val displayName = requireNotNull(inExtras.getString(android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME))
                val source = fileForId(docId, writeOperation = true)
                val oldCanonical = source.canonicalPath
                val wasDir = source.isDirectory
                val dest = File(source.parentFile, displayName)
                check(source.renameTo(dest))
                val newId = if (wasDir) {
                    rotateSubtreeIds(oldCanonical, dest)
                    onSubtreeRotated?.invoke()
                    idForFile(dest)
                } else {
                    synchronized(this) {
                        idToPath.remove(docId)?.let { retiredIds += docId }
                        pathToId.remove(oldCanonical)
                        idForFile(dest)
                    }
                }
                val outUri = treeUriForDocId(newId)
                grantPermissions(outUri)
                out.putParcelable("uri", outUri)
                afterRenameDocument?.invoke()
            }
        }
        return out
    }

    override fun openFile(uri: Uri, mode: String): android.os.ParcelFileDescriptor {
        val file = fileForId(android.provider.DocumentsContract.getDocumentId(uri), writeOperation = mode != "r")
        val flags = when (mode) {
            "r" -> android.os.ParcelFileDescriptor.MODE_READ_ONLY
            "rw" -> android.os.ParcelFileDescriptor.MODE_READ_WRITE
            "wt", "w" -> android.os.ParcelFileDescriptor.MODE_WRITE_ONLY or
                android.os.ParcelFileDescriptor.MODE_CREATE or
                android.os.ParcelFileDescriptor.MODE_TRUNCATE
            else -> android.os.ParcelFileDescriptor.parseMode(mode)
        }
        return android.os.ParcelFileDescriptor.open(file, flags)
    }

    private fun grantPermissions(docUri: Uri) {
        appContext.grantUriPermission(
            appContext.packageName,
            docUri,
            android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                android.content.Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
    }

    companion object {
        const val ROOT_ID = "opaque:root-0"
        private val DEFAULT_DOC_PROJECTION = arrayOf(
            android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE,
            android.provider.DocumentsContract.Document.COLUMN_SIZE,
            android.provider.DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            android.provider.DocumentsContract.Document.COLUMN_FLAGS,
        )
    }
}
