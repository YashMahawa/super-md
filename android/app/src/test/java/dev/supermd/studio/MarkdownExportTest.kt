package dev.supermd.studio

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipInputStream
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MarkdownExportTest {
    private val gifBytes = byteArrayOf(
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x01, 0x00,
        0x80.toByte(), 0x00, 0x00, 0xff.toByte(), 0x00, 0x00, 0x00, 0x00, 0x00,
        0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
    )
    private val chartSvgBytes = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 140">
          <defs><linearGradient id="ink"><stop offset="0%" stop-color="#386a57"/></linearGradient></defs>
          <path d="M 10 70 Q 70 10 130 70 T 230 70" fill="none" stroke="url(#ink)" stroke-width="2.5"/>
          <use href="#ink"/>
          <text x="16" y="128">Explore a sine wave</text>
        </svg>
    """.trimIndent().toByteArray(Charsets.UTF_8)
    private val matplotlibSvgBytes = """
        <?xml version="1.0" encoding="utf-8" standalone="no"?>
        <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
        <svg xmlns="http://www.w3.org/2000/svg" width="120pt" height="80pt" viewBox="0 0 120 80">
          <style type="text/css">*{stroke-linejoin: round; stroke-linecap: butt}</style>
          <path d="M 10 60 L 110 20" stroke="#42669e" fill="none"/>
        </svg>
    """.trimIndent().toByteArray(Charsets.UTF_8)

    @Test fun zipKeepsNestedRelativeAssetPathExactGifBytesAndSingleMarkdownSuffix() = withExportContext { context ->
        val assetPath = "figures/lesson-2/animation.gif"
        val source = "# Study\n\n![animation]($assetPath)\n"
        val dataUrl = "data:image/gif;base64," + Base64.encodeToString(gifBytes, Base64.NO_WRAP)
        val assets = JSONObject().put(assetPath, dataUrl)
        val sourceSnapshot = source
        val assetsSnapshot = assets.toString()

        MarkdownExport(context, "Study.md", source, assets).use { export ->
            val zipBytes = ByteArrayOutputStream().also(export::writeZip).toByteArray()
            val entries = readZip(zipBytes)

            assertEquals(setOf("Study.md", assetPath), entries.keys)
            assertEquals(sourceSnapshot, entries["Study.md"]!!.toString(Charsets.UTF_8))
            assertArrayEquals(gifBytes, entries[assetPath])
            assertFalse(entries.containsKey("Study.md.md"))
            assertEquals("Study.md", export.filename)
            assertEquals("export construction does not rewrite source Markdown", sourceSnapshot, source)
            assertEquals("export construction does not rewrite the source assets object", assetsSnapshot, assets.toString())
            assertEquals(dataUrl, assets.getString(assetPath))
        }
    }

    @Test fun welcomeStarterNoteAndSanitizedSvgAssetsExportCleanly() = withExportContext { context ->
        val welcomePrepared = sample.replace(
            Regex("```smd-chart[\\s\\S]*?```"),
            "![Explore a sine wave](<image1.svg>)",
        ) + "\n\n![Gaussian](<plots/gaussian.svg>)\n"
        val assets = JSONObject()
            .put("image1.svg", svgDataUrl(chartSvgBytes))
            .put("plots/gaussian.svg", svgDataUrl(matplotlibSvgBytes))

        MarkdownExport(context, "Welcome.md", welcomePrepared, assets).use { export ->
            val entries = readZip(ByteArrayOutputStream().also(export::writeZip).toByteArray())
            assertEquals(setOf("Welcome.md", "image1.svg", "plots/gaussian.svg"), entries.keys)
            assertEquals(welcomePrepared, entries["Welcome.md"]!!.toString(Charsets.UTF_8))
            assertArrayEquals(chartSvgBytes, entries["image1.svg"])
            assertArrayEquals(matplotlibSvgBytes, entries["plots/gaussian.svg"])
        }
    }

    @Test fun exportRejectsUnsafeSvgPayloadsAndCleansUpStagedDirectory() = withExportContext { context ->
        val unsafePayloads = listOf(
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>".toByteArray(),
            "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"><rect width=\"5\" height=\"5\"/></svg>".toByteArray(),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><foreignObject><div>html</div></foreignObject></svg>".toByteArray(),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><iframe src=\"https://evil.example\"/></svg>".toByteArray(),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"https://evil.example/track.png\"/></svg>".toByteArray(),
            "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\"><use xlink:href=\"https://evil.example/icon.svg#x\"/></svg>".toByteArray(),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect fill=\"url(https://evil.example/p)\"/></svg>".toByteArray(),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><style>@import url('https://evil.example/s.css');</style></svg>".toByteArray(),
            "<!DOCTYPE svg [<!ENTITY xxe \"boom\">]><svg xmlns=\"http://www.w3.org/2000/svg\"><text>&xxe;</text></svg>".toByteArray(),
            byteArrayOf('<'.code.toByte(), 's'.code.toByte(), 'v'.code.toByte(), 'g'.code.toByte(), '>'.code.toByte(), 0xff.toByte()),
        )
        for (unsafe in unsafePayloads) {
            assertThrows(IllegalArgumentException::class.java) {
                MarkdownExport(context, "Welcome.md", "# Welcome\n\n![Bad](bad.svg)\n", JSONObject().put("bad.svg", svgDataUrl(unsafe)))
            }
        }
        val stagingRoot = File(context.cacheDir, "markdown-export")
        assertTrue(!stagingRoot.exists() || stagingRoot.listFiles().orEmpty().isEmpty())
    }

    @Test fun exportRejectsTraversalAndAbsoluteAssetPathsAfterUriDecoding() = withExportContext { context ->
        val encoded = "data:image/gif;base64," + Base64.encodeToString(gifBytes, Base64.NO_WRAP)
        for (unsafe in listOf("../escape.gif", "images/%2e%2e/escape.gif", "/absolute.gif", "images\\escape.gif", "images//empty.gif")) {
            assertThrows("Rejected unsafe asset path: $unsafe", IllegalArgumentException::class.java) {
                MarkdownExport(context, "Study.md", "# Study", JSONObject().put(unsafe, encoded))
            }
        }
    }

    @Test fun exportRejectsCaseInsensitiveAndMarkdownFilenameConflicts() = withExportContext { context ->
        val encoded = "data:image/gif;base64," + Base64.encodeToString(gifBytes, Base64.NO_WRAP)
        val caseCollision = JSONObject().put("figures/Diagram.gif", encoded).put("figures/diagram.GIF", encoded)
        assertThrows(IllegalArgumentException::class.java) {
            MarkdownExport(context, "Study.md", "# Study", caseCollision)
        }

        val markdownCollision = JSONObject().put("study.MD", encoded)
        assertThrows(IllegalArgumentException::class.java) {
            MarkdownExport(context, "Study.md", "# Study", markdownCollision)
        }
    }

    @Test fun agentExportBundlesCompanionAssetsRollsBackOnFailureAndSupportsZipArchives() = runBlocking {
        val downloadsRoot = Files.createTempDirectory("downloads-provider").toFile()
        try {
            val app = RuntimeEnvironment.getApplication()
            val provider = FakeDownloadsProvider(downloadsRoot).apply {
                attachInfo(app, ProviderInfo().apply { authority = MediaStore.AUTHORITY })
            }
            ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY, provider)
            val model = StudioViewModel(app)
            val content = "# Welcome\n\n![Sine](image1.svg)\n\n![Animation](figures/loop.gif)\n"
            val assets = JSONObject()
                .put("image1.svg", svgDataUrl(chartSvgBytes))
                .put("figures/loop.gif", "data:image/gif;base64," + Base64.encodeToString(gifBytes, Base64.NO_WRAP))

            val (mdUri, mdSavedName) = model.writeAgentExport(content, assets, "md", "Welcome.md", "{}")
            assertEquals("Welcome.md", mdSavedName)
            val mdEntry = provider.entries[mdUri]!!
            assertEquals(0, mdEntry.pending)
            val companionPaths = provider.entries.values
                .filter { it.relativePath.startsWith(mdEntry.relativePath) }
                .associate { (it.relativePath.removePrefix(mdEntry.relativePath) + it.displayName) to it.file.readBytes() }
            assertEquals(setOf("Welcome.md", "image1.svg", "figures/loop.gif"), companionPaths.keys)
            assertEquals(content, companionPaths["Welcome.md"]!!.toString(Charsets.UTF_8))
            assertArrayEquals(chartSvgBytes, companionPaths["image1.svg"])
            assertArrayEquals(gifBytes, companionPaths["figures/loop.gif"])

            val (zipUri, zipSavedName) = model.writeAgentExport(content, assets, "mdzip", "Welcome.zip", "{}", archive = true)
            assertEquals("Welcome.zip", zipSavedName)
            val zipBytes = provider.entries[zipUri]!!.file.readBytes()
            val zipEntries = readZip(zipBytes)
            assertEquals(setOf("Welcome.md", "image1.svg", "figures/loop.gif"), zipEntries.keys)
            assertArrayEquals(chartSvgBytes, zipEntries["image1.svg"])
            assertArrayEquals(gifBytes, zipEntries["figures/loop.gif"])

            // Verify MainActivity.completeAgentExport records mdzip artifacts with application/zip MIME.
            val activity = Robolectric.buildActivity(MainActivity::class.java).create().get()
            activity.updateAgentExportJob("job-zip", "preparing")
            activity.completeAgentExport("job-zip", zipUri, zipSavedName, "mdzip")
            val completed = activity.agentExportJob("job-zip")!!
            assertEquals("completed", completed.getString("status"))
            assertEquals("mdzip", completed.getString("format"))
            assertEquals("application/zip", completed.getString("mimeType"))
            assertEquals("Welcome.zip", completed.getString("filename"))
            assertEquals(zipBytes.size.toLong(), completed.getLong("bytes"))

            // Verify Downloads rollback deletes staged rows when provider renames an asset.
            val countBeforeFailure = provider.entries.size
            provider.renameOnInsert = "figures/loop.gif" to "loop (1).gif"
            assertThrows(IllegalArgumentException::class.java) {
                runBlocking { model.writeAgentExport(content, assets, "md", "Rollback.md", "{}") }
            }
            assertEquals(countBeforeFailure, provider.entries.size)
        } finally {
            shadowOf(Looper.getMainLooper()).idle()
            downloadsRoot.deleteRecursively()
        }
    }

    @Test
    @Config(sdk = [28])
    fun api28PromptsForConfiguredFolderWhenSavingCompanionAssetsWithoutArchive() = withExportContext { context ->
        val assets = JSONObject().put("image1.svg", svgDataUrl(chartSvgBytes))
        MarkdownExport(context, "Welcome.md", "# Welcome\n\n![Chart](image1.svg)\n", assets).use { export ->
            val error = assertThrows(IllegalStateException::class.java) {
                export.save(configuredFolder = null, archive = false)
            }
            assertTrue(error.message!!.contains("Choose an export folder in Settings"))
        }
    }

    private fun svgDataUrl(bytes: ByteArray): String =
        "data:image/svg+xml;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun withExportContext(block: (Context) -> Unit) {
        val app = RuntimeEnvironment.getApplication()
        val tempCache = Files.createTempDirectory("markdown-export-test").toFile()
        val context = object : ContextWrapper(app) {
            override fun getCacheDir(): File = tempCache
        }
        try { block(context) } finally { tempCache.deleteRecursively() }
    }

    private fun readZip(bytes: ByteArray): Map<String, ByteArray> = buildMap {
        ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                put(entry.name, zip.readBytes())
                zip.closeEntry()
            }
        }
    }
}

private class FakeDownloadsProvider(private val root: File) : ContentProvider() {
    data class Entry(
        val id: Long,
        var displayName: String,
        val mimeType: String,
        val relativePath: String,
        var pending: Int,
        val file: File,
    )

    private var sequence = 1L
    val entries = linkedMapOf<Uri, Entry>()
    var renameOnInsert: Pair<String, String>? = null

    override fun onCreate(): Boolean = true

    override fun insert(uri: Uri, values: ContentValues?): Uri {
        val v = requireNotNull(values)
        val id = sequence++
        val requestedName = v.getAsString(MediaStore.Downloads.DISPLAY_NAME)
        val relativePath = v.getAsString(MediaStore.Downloads.RELATIVE_PATH).orEmpty()
        val actualName = renameOnInsert?.takeIf { relativePath.endsWith(it.first.substringBeforeLast('/', "") + "/") && requestedName == it.first.substringAfterLast('/') }?.second ?: requestedName
        val itemUri = Uri.parse("content://${MediaStore.AUTHORITY}/external/downloads/$id")
        val backing = File(root, "entry-$id").apply { createNewFile() }
        entries[itemUri] = Entry(
            id = id,
            displayName = actualName,
            mimeType = v.getAsString(MediaStore.Downloads.MIME_TYPE).orEmpty(),
            relativePath = relativePath,
            pending = v.getAsInteger(MediaStore.Downloads.IS_PENDING) ?: 0,
            file = backing,
        )
        return itemUri
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val entry = entries[uri] ?: throw IllegalArgumentException("Missing URI: $uri")
        val flags = if (mode.contains('w')) {
            ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
        } else {
            ParcelFileDescriptor.MODE_READ_ONLY
        }
        return ParcelFileDescriptor.open(entry.file, flags)
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val cols = projection ?: arrayOf(MediaStore.Downloads._ID, MediaStore.Downloads.DISPLAY_NAME, OpenableColumns.DISPLAY_NAME)
        val cursor = MatrixCursor(cols)
        val matched = if (entries.containsKey(uri)) listOf(entries.getValue(uri)) else entries.values.filter { entry ->
            if (selection != null && selectionArgs != null && selectionArgs.size == 2) {
                entry.displayName == selectionArgs[0] && entry.relativePath == selectionArgs[1]
            } else true
        }
        for (entry in matched) {
            cursor.addRow(cols.map<String, Any?> { col ->
                when (col) {
                    MediaStore.Downloads._ID -> entry.id
                    MediaStore.Downloads.DISPLAY_NAME, OpenableColumns.DISPLAY_NAME -> entry.displayName
                    else -> null
                }
            }.toTypedArray())
        }
        return cursor
    }

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int {
        val entry = entries[uri] ?: return 0
        values?.getAsInteger(MediaStore.Downloads.IS_PENDING)?.let { entry.pending = it }
        return 1
    }

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        if (entries.remove(uri)?.also { it.file.delete() } != null) 1 else 0

    override fun getType(uri: Uri): String? = entries[uri]?.mimeType
}
