package dev.supermd.studio
import org.junit.Assert.*
import org.junit.Test
class AppUpdatesTest {
    @Test fun versionsAreNumericAndStableOnly() {
        assertTrue(newerVersion("v0.10.0","0.9.99"))
        assertFalse(newerVersion("0.4.9","0.4.9"))
        assertFalse(newerVersion("0.4.8","0.4.9"))
        for(value in listOf("1.2","1.2.3-beta","https://evil.test"))assertThrows(IllegalArgumentException::class.java){stableVersion(value)}
    }
    @Test fun checksumRequiresExactFilename() {
        val hash="a".repeat(64)
        assertEquals(hash,releaseChecksum("$hash  Super-MD-0.4.9-arm64-release.apk\n","Super-MD-0.4.9-arm64-release.apk"))
        assertThrows(IllegalStateException::class.java){releaseChecksum("$hash  wrong.apk","right.apk")}
    }

    @Test fun downloadsCopyIsVisibleOnlyAfterProviderConfirmsPublication() {
        val entry=PublicUpdateEntry("dev.supermd.studio",4096,false)
        requirePublishedUpdateCopy(1,entry,4096,"dev.supermd.studio")
        assertThrows(IllegalArgumentException::class.java){requirePublishedUpdateCopy(0,entry,4096,"dev.supermd.studio")}
        assertThrows(IllegalArgumentException::class.java){requirePublishedUpdateCopy(1,entry.copy(pending=true),4096,"dev.supermd.studio")}
        assertThrows(IllegalArgumentException::class.java){requirePublishedUpdateCopy(1,entry.copy(owner="other.app"),4096,"dev.supermd.studio")}
        assertThrows(IllegalArgumentException::class.java){requirePublishedUpdateCopy(1,entry.copy(size=4095),4096,"dev.supermd.studio")}
    }

    @Test fun failedPublicCopyStillLeavesActionablePrivateInstallPath() {
        val failed=updateDownloadStatus(false,"provider refused to publish")
        assertTrue(failed.contains("ready to install"))
        assertTrue(failed.contains("retry saving it"))
        assertTrue(updateDownloadStatus(true).contains("Downloads"))
    }
}
