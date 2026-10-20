package dev.supermd.studio

import java.io.File
import java.nio.file.Files

/** A private-storage summary; labels are fixed and no file names or paths leave this inspector. */
data class StorageCategoryUsage(
    val label: String,
    val bytes: Long,
    val files: Int,
    val skippedEntries: Int,
)

data class StorageReport(
    val retained: List<StorageCategoryUsage>,
    val executionResults: StorageCategoryUsage,
    val legacyExecutionResults: StorageCategoryUsage,
    val otherCache: StorageCategoryUsage,
) {
    val partial: Boolean
        get() = retained.any { it.skippedEntries > 0 } || executionResults.skippedEntries > 0 ||
            legacyExecutionResults.skippedEntries > 0 || otherCache.skippedEntries > 0
}

/** Read-only bounded inventory of Super MD's internal storage. Never follows symlinks. */
internal object StorageInspector {
    const val MAX_DEPTH = 8
    const val MAX_ENTRIES_PER_CATEGORY = 4_096

    private val durableNames = setOf(
        "workspace.json", "workspaces", "deleted-drafts", "closed-notes",
        "reader-conflicts", "derived-python",
    )

    fun inspect(filesDir: File, cacheDir: File): StorageReport {
        val retained = listOf(
            category("Workspace and window recovery", listOf(File(filesDir, "workspace.json"), File(filesDir, "workspaces"))),
            category("Deleted-draft recovery", listOf(File(filesDir, "deleted-drafts"))),
            category("Closed-note recovery", listOf(File(filesDir, "closed-notes"))),
            category("Reader conflict drafts", listOf(File(filesDir, "reader-conflicts"))),
            category("Execution results", listOf(File(filesDir, "derived-python"))),
            category("Other app-owned files", listOf(filesDir), durableNames),
        )
        val legacyExecutionResults = category(
            "Execution results (legacy cache location; preserved by Super MD; Android may clear cache)",
            listOf(File(cacheDir, "derived-python")),
        )
        val otherCache = category(
            "Other app cache (Android may clear cache)",
            listOf(cacheDir), setOf("derived-python"),
        )
        return StorageReport(
            retained = retained,
            executionResults = retained[4],
            legacyExecutionResults = legacyExecutionResults,
            otherCache = otherCache,
        )
    }

    fun unavailableReport(): StorageReport {
        fun unavailable(label: String) = StorageCategoryUsage(label, 0L, 0, 1)
        val retained = listOf(
            unavailable("Workspace and window recovery"),
            unavailable("Deleted-draft recovery"),
            unavailable("Closed-note recovery"),
            unavailable("Reader conflict drafts"),
            unavailable("Execution results"),
            unavailable("Other app-owned files"),
        )
        return StorageReport(
            retained,
            retained[4],
            unavailable("Execution results (legacy cache location; preserved by Super MD; Android may clear cache)"),
            unavailable("Other app cache (Android may clear cache)"),
        )
    }

    private fun category(
        label: String,
        roots: List<File>,
        excludedDirectChildren: Set<String> = emptySet(),
    ): StorageCategoryUsage {
        val scan = Scan()
        roots.forEachIndexed { index, root -> scan.visit(root, 0, if (index == 0) excludedDirectChildren else emptySet()) }
        return StorageCategoryUsage(label, scan.bytes, scan.files, scan.skipped)
    }

    private class Scan {
        var bytes = 0L
        var files = 0
        var skipped = 0
        private var visited = 0

        fun visit(file: File, depth: Int, excludedChildren: Set<String> = emptySet()) {
            if (runCatching { Files.isSymbolicLink(file.toPath()) }.getOrDefault(true)) {
                skipped++
                return
            }
            if (!file.exists()) return
            if (visited >= MAX_ENTRIES_PER_CATEGORY) {
                skipped++
                return
            }
            visited++
            if (file.isDirectory) {
                if (depth >= MAX_DEPTH) {
                    skipped++
                    return
                }
                try {
                    Files.newDirectoryStream(file.toPath()).use { children ->
                        val iterator = children.iterator()
                        while (iterator.hasNext()) {
                            if (visited >= MAX_ENTRIES_PER_CATEGORY) {
                                skipped++
                                break
                            }
                            val child = iterator.next().toFile()
                            if (depth == 0 && child.name in excludedChildren) visited++
                            else visit(child, depth + 1)
                        }
                    }
                } catch (_: Exception) {
                    skipped++
                }
            } else if (file.isFile) {
                files++
                val size = file.length().coerceAtLeast(0L)
                bytes = if (Long.MAX_VALUE - bytes < size) Long.MAX_VALUE else bytes + size
                if (!file.canRead()) skipped++
            } else {
                skipped++
            }
        }
    }
}

internal fun formatStorageBytes(bytes: Long): String {
    val value = bytes.coerceAtLeast(0L).toDouble()
    if (value < 1024) return "${bytes.coerceAtLeast(0L)} B"
    val units = listOf("KB", "MB", "GB", "TB")
    var scaled = value
    var unit = -1
    while (scaled >= 1024 && unit < units.lastIndex) {
        scaled /= 1024
        unit++
    }
    return String.format(java.util.Locale.ROOT, "%.1f %s", scaled, units[unit])
}
