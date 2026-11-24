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

@org.junit.runner.RunWith(org.robolectric.RobolectricTestRunner::class)
@org.robolectric.annotation.Config(
    sdk = [26, 28, 33],
    shadows = [RecordingShadowPackageManager::class, RecordingShadowApplicationPackageManager::class],
)
class AppUpdateVerificationTest {
    private val signerOne = byteArrayOf(0x30, 0x82.toByte(), 0x01, 0x22, 0x11, 0x22, 0x33, 0x44)
    private val signerTwo = byteArrayOf(0x30, 0x82.toByte(), 0x01, 0x22, 0x55, 0x66, 0x77, 0x78)

    @org.junit.Before fun setUp() {
        PackageQueryRecorder.reset()
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        java.io.File(app.filesDir, "updates").deleteRecursively()
        installCurrentPackage(versionName = "0.6.34", versionCode = 1059L, certs = listOf(signerOne))
    }

    @org.junit.After fun tearDown() {
        PackageQueryRecorder.reset()
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        java.io.File(app.filesDir, "updates").deleteRecursively()
    }

    @Test fun acceptsValidUpgradeAndUsesExpectedOsPackageQueries() {
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        val expectedCode = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) (1L shl 33) + 42L else 1060L
        val apkFile = stageFakeArchive(
            buildPackageInfo(
                packageName = app.packageName,
                versionName = "0.6.35",
                versionCode = expectedCode,
                debuggable = false,
                certs = listOf(signerOne),
            )
        )
        val release = sampleRelease("0.6.35", apkFile.length())
        val verifiedCode = AppUpdates(app).verifyUpgrade(apkFile, release)
        assertEquals(expectedCode, verifiedCode)
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            assertEquals(1, PackageQueryRecorder.typedArchiveCalls)
            assertEquals(0, PackageQueryRecorder.intArchiveCalls)
            assertEquals(1, PackageQueryRecorder.typedInstalledCalls)
            assertEquals(0, PackageQueryRecorder.intInstalledCalls)
            assertEquals(android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES.toLong(), PackageQueryRecorder.lastArchiveFlags)
        } else if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            assertEquals(0, PackageQueryRecorder.typedArchiveCalls)
            assertEquals(1, PackageQueryRecorder.intArchiveCalls)
            assertEquals(0, PackageQueryRecorder.typedInstalledCalls)
            assertEquals(1, PackageQueryRecorder.intInstalledCalls)
            assertEquals(android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES.toLong(), PackageQueryRecorder.lastArchiveFlags)
        } else {
            assertEquals(0, PackageQueryRecorder.typedArchiveCalls)
            assertEquals(1, PackageQueryRecorder.intArchiveCalls)
            assertEquals(0, PackageQueryRecorder.typedInstalledCalls)
            assertEquals(1, PackageQueryRecorder.intInstalledCalls)
            @Suppress("DEPRECATION")
            val legacyFlag = android.content.pm.PackageManager.GET_SIGNATURES.toLong()
            assertEquals(legacyFlag, PackageQueryRecorder.lastArchiveFlags)
        }
    }

    @Test fun rejectsWrongPackageIdentityAndMismatchedVersionName() {
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        val wrongPackage = stageFakeArchive(
            buildPackageInfo(
                packageName = "com.example.tampered",
                versionName = "0.6.35",
                versionCode = 1060L,
                debuggable = false,
                certs = listOf(signerOne),
            ),
            fileName = "wrong-package.apk",
        )
        val wrongPackageError = assertThrows(IllegalArgumentException::class.java) {
            AppUpdates(app).verifyUpgrade(wrongPackage, sampleRelease("0.6.35", wrongPackage.length()))
        }
        assertEquals("APK identity mismatch", wrongPackageError.message)

        val wrongVersion = stageFakeArchive(
            buildPackageInfo(
                packageName = app.packageName,
                versionName = "0.6.36",
                versionCode = 1060L,
                debuggable = false,
                certs = listOf(signerOne),
            ),
            fileName = "wrong-version.apk",
        )
        val wrongVersionError = assertThrows(IllegalArgumentException::class.java) {
            AppUpdates(app).verifyUpgrade(wrongVersion, sampleRelease("0.6.35", wrongVersion.length()))
        }
        assertEquals("APK identity mismatch", wrongVersionError.message)
    }

    @Test fun rejectsDebuggableInstallerPackage() {
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        val debugApk = stageFakeArchive(
            buildPackageInfo(
                packageName = app.packageName,
                versionName = "0.6.35",
                versionCode = 1060L,
                debuggable = true,
                certs = listOf(signerOne),
            )
        )
        val error = assertThrows(IllegalArgumentException::class.java) {
            AppUpdates(app).verifyUpgrade(debugApk, sampleRelease("0.6.35", debugApk.length()))
        }
        assertEquals("Refusing a debug APK", error.message)
    }

    @Test fun rejectsSameOrDowngradedVersionCode() {
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        for (nonUpgradeCode in listOf(1059L, 1058L)) {
            val apk = stageFakeArchive(
                buildPackageInfo(
                    packageName = app.packageName,
                    versionName = "0.6.35",
                    versionCode = nonUpgradeCode,
                    debuggable = false,
                    certs = listOf(signerOne),
                ),
                fileName = "code-$nonUpgradeCode.apk",
            )
            val error = assertThrows(IllegalArgumentException::class.java) {
                AppUpdates(app).verifyUpgrade(apk, sampleRelease("0.6.35", apk.length()))
            }
            assertEquals("APK is not an upgrade", error.message)
        }
    }

    @Test fun rejectsMismatchedOrMissingSigningCertificates() {
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        for ((label, certs) in listOf(
            "different-cert" to listOf(signerTwo),
            "empty-certs" to emptyList(),
            "extra-cert" to listOf(signerOne, signerTwo),
        )) {
            val apk = stageFakeArchive(
                buildPackageInfo(
                    packageName = app.packageName,
                    versionName = "0.6.35",
                    versionCode = 1060L,
                    debuggable = false,
                    certs = certs,
                ),
                fileName = "$label.apk",
            )
            val error = assertThrows(IllegalArgumentException::class.java) {
                AppUpdates(app).verifyUpgrade(apk, sampleRelease("0.6.35", apk.length()))
            }
            assertEquals("APK upgrade certificate mismatch", error.message)
        }
    }

    @Test fun downloadParsesStagedInstallerOnceAndPersistsVerifiedVersionCode(): Unit = kotlinx.coroutines.runBlocking {
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        val version = "99.1.0"
        val abi = if ("arm64-v8a" in android.os.Build.SUPPORTED_ABIS) "arm64" else if ("x86_64" in android.os.Build.SUPPORTED_ABIS) "x86_64" else "armeabi-v7a"
        val apkName = "Super-MD-$version-$abi-release.apk"
        val apkBytes = "verified-apk-binary-payload".toByteArray(Charsets.UTF_8)
        val sha256 = java.security.MessageDigest.getInstance("SHA-256").digest(apkBytes).joinToString("") { "%02x".format(it) }
        val apkUrl = "https://github.com/YashMahawa/super-md/releases/download/v$version/$apkName"
        val sumsUrl = "https://github.com/YashMahawa/super-md/releases/download/v$version/SHA256SUMS"
        val releaseJson = org.json.JSONObject()
            .put("tag_name", "v$version")
            .put("draft", false)
            .put("prerelease", false)
            .put("assets", org.json.JSONArray()
                .put(org.json.JSONObject().put("name", apkName).put("size", apkBytes.size).put("browser_download_url", apkUrl))
                .put(org.json.JSONObject().put("name", "SHA256SUMS").put("size", 128).put("browser_download_url", sumsUrl)))
            .toString()
            .toByteArray(Charsets.UTF_8)
        val sumsBytes = "$sha256  $apkName\n".toByteArray(Charsets.UTF_8)
        val expectedVersionCode = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) (1L shl 32) + 77L else 2099L
        val candidateInfo = buildPackageInfo(
            packageName = app.packageName,
            versionName = version,
            versionCode = expectedVersionCode,
            debuggable = false,
            certs = listOf(signerOne),
        )
        PackageQueryRecorder.archiveResolver = { path ->
            if (java.io.File(path).exists()) candidateInfo else null
        }

        val updates = AppUpdates(app) { url ->
            when (url.toString()) {
                "https://api.github.com/repos/YashMahawa/super-md/releases/latest" -> fakeHttpsConnection(url, 200, releaseJson)
                sumsUrl -> fakeHttpsConnection(url, 200, sumsBytes)
                apkUrl -> fakeHttpsConnection(url, 200, apkBytes)
                else -> fakeHttpsConnection(url, 404, ByteArray(0))
            }
        }
        updates.check()
        assertEquals(version, updates.state.value.version)
        PackageQueryRecorder.resetCounters()

        updates.download()

        assertTrue(updates.state.value.ready)
        assertEquals(1, PackageQueryRecorder.typedArchiveCalls + PackageQueryRecorder.intArchiveCalls)
        val receiptFile = java.io.File(java.io.File(app.filesDir, "updates"), "ready.json")
        assertTrue(receiptFile.isFile)
        val saved = org.json.JSONObject(receiptFile.readText())
        assertEquals(expectedVersionCode, saved.getLong("versionCode"))
        assertEquals(version, saved.getString("version"))
        assertTrue(java.io.File(java.io.File(app.filesDir, "updates"), apkName).isFile)
    }

    @Test fun downloadAndRestoreRejectTamperedInstallerAcrossSupportedOsVersions(): Unit = kotlinx.coroutines.runBlocking {
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        val version = "99.2.0"
        val abi = if ("arm64-v8a" in android.os.Build.SUPPORTED_ABIS) "arm64" else if ("x86_64" in android.os.Build.SUPPORTED_ABIS) "x86_64" else "armeabi-v7a"
        val apkName = "Super-MD-$version-$abi-release.apk"
        val apkBytes = "tampered-signer-apk-payload".toByteArray(Charsets.UTF_8)
        val sha256 = java.security.MessageDigest.getInstance("SHA-256").digest(apkBytes).joinToString("") { "%02x".format(it) }
        val apkUrl = "https://github.com/YashMahawa/super-md/releases/download/v$version/$apkName"
        val sumsUrl = "https://github.com/YashMahawa/super-md/releases/download/v$version/SHA256SUMS"
        val releaseJson = org.json.JSONObject()
            .put("tag_name", "v$version")
            .put("draft", false)
            .put("prerelease", false)
            .put("assets", org.json.JSONArray()
                .put(org.json.JSONObject().put("name", apkName).put("size", apkBytes.size).put("browser_download_url", apkUrl))
                .put(org.json.JSONObject().put("name", "SHA256SUMS").put("size", 128).put("browser_download_url", sumsUrl)))
            .toString()
            .toByteArray(Charsets.UTF_8)
        val sumsBytes = "$sha256  $apkName\n".toByteArray(Charsets.UTF_8)
        PackageQueryRecorder.archiveResolver = { path ->
            if (java.io.File(path).exists()) buildPackageInfo(
                packageName = app.packageName,
                versionName = version,
                versionCode = 3000L,
                debuggable = false,
                certs = listOf(signerTwo),
            ) else null
        }

        val updates = AppUpdates(app) { url ->
            when (url.toString()) {
                "https://api.github.com/repos/YashMahawa/super-md/releases/latest" -> fakeHttpsConnection(url, 200, releaseJson)
                sumsUrl -> fakeHttpsConnection(url, 200, sumsBytes)
                apkUrl -> fakeHttpsConnection(url, 200, apkBytes)
                else -> fakeHttpsConnection(url, 404, ByteArray(0))
            }
        }
        updates.check()
        PackageQueryRecorder.resetCounters()
        updates.download()

        val updatesDir = java.io.File(app.filesDir, "updates")
        assertFalse(updates.state.value.ready)
        assertEquals(1, PackageQueryRecorder.typedArchiveCalls + PackageQueryRecorder.intArchiveCalls)
        assertFalse(java.io.File(updatesDir, apkName).exists())
        assertFalse(java.io.File(updatesDir, "ready.json").exists())

        // Also verify startup restore rejects a persisted APK whose certificate does not match.
        val staged = java.io.File(updatesDir, apkName).apply { writeBytes(apkBytes) }
        java.io.File(updatesDir, "ready.json").writeText(
            org.json.JSONObject()
                .put("version", version)
                .put("name", apkName)
                .put("url", apkUrl)
                .put("sums", sumsUrl)
                .put("size", apkBytes.size)
                .put("sha256", sha256)
                .put("versionCode", 3000L)
                .toString()
        )
        val restored = AppUpdates(app)
        restored.restore()
        assertFalse(restored.state.value.ready)
        assertTrue(restored.state.value.status.contains("APK upgrade certificate mismatch"))
        staged.delete()
    }

    private fun sampleRelease(version: String, size: Long): UpdateRelease {
        val name = "Super-MD-$version-arm64-release.apk"
        return UpdateRelease(
            version = version,
            name = name,
            url = "https://github.com/YashMahawa/super-md/releases/download/v$version/$name",
            sums = "https://github.com/YashMahawa/super-md/releases/download/v$version/SHA256SUMS",
            size = size,
        )
    }

    private fun installCurrentPackage(versionName: String, versionCode: Long, certs: List<ByteArray>) {
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        val info = buildPackageInfo(
            packageName = app.packageName,
            versionName = versionName,
            versionCode = versionCode,
            debuggable = false,
            certs = certs,
        )
        PackageQueryRecorder.installedPackages[app.packageName] = info
    }

    private fun stageFakeArchive(info: android.content.pm.PackageInfo, fileName: String = "candidate.apk"): java.io.File {
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        val dir = java.io.File(app.filesDir, "updates").apply { mkdirs() }
        val file = java.io.File(dir, fileName).apply { writeText("apk-archive") }
        PackageQueryRecorder.archivePackages[file.absolutePath] = info
        return file
    }

    private fun buildPackageInfo(
        packageName: String,
        versionName: String,
        versionCode: Long,
        debuggable: Boolean,
        certs: List<ByteArray>,
    ): android.content.pm.PackageInfo {
        val signatures = certs.map { android.content.pm.Signature(it) }.toTypedArray()
        return android.content.pm.PackageInfo().apply {
            this.packageName = packageName
            this.versionName = versionName
            this.applicationInfo = android.content.pm.ApplicationInfo().apply {
                this.packageName = packageName
                this.flags = if (debuggable) android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE else 0
            }
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                setLongVersionCode(versionCode)
                val signing = android.content.pm.SigningInfo()
                if (signatures.isNotEmpty()) {
                    org.robolectric.Shadows.shadowOf(signing).setSignatures(signatures)
                }
                this.signingInfo = signing
            } else {
                @Suppress("DEPRECATION")
                this.versionCode = versionCode.toInt()
                @Suppress("DEPRECATION")
                this.signatures = if (signatures.isEmpty()) emptyArray() else signatures
            }
        }
    }

    private fun fakeHttpsConnection(url: java.net.URL, code: Int, body: ByteArray): java.net.HttpURLConnection =
        object : java.net.HttpURLConnection(url) {
            override fun connect() = Unit
            override fun disconnect() = Unit
            override fun usingProxy(): Boolean = false
            override fun getResponseCode(): Int = code
            override fun getInputStream(): java.io.InputStream = java.io.ByteArrayInputStream(body)
        }
}

internal object PackageQueryRecorder {
    var typedArchiveCalls = 0
    var intArchiveCalls = 0
    var typedInstalledCalls = 0
    var intInstalledCalls = 0
    var lastArchiveFlags = 0L
    val installedPackages = mutableMapOf<String, android.content.pm.PackageInfo>()
    val archivePackages = mutableMapOf<String, android.content.pm.PackageInfo>()
    var archiveResolver: ((String) -> android.content.pm.PackageInfo?)? = null

    fun resetCounters() {
        typedArchiveCalls = 0
        intArchiveCalls = 0
        typedInstalledCalls = 0
        intInstalledCalls = 0
        lastArchiveFlags = 0L
    }

    fun reset() {
        resetCounters()
        installedPackages.clear()
        archivePackages.clear()
        archiveResolver = null
    }
}

@org.robolectric.annotation.Implements(android.content.pm.PackageManager::class)
open class RecordingShadowPackageManager : org.robolectric.shadows.ShadowPackageManager() {
    @androidx.annotation.RequiresApi(android.os.Build.VERSION_CODES.TIRAMISU)
    @org.robolectric.annotation.Implementation(minSdk = android.os.Build.VERSION_CODES.TIRAMISU)
    protected open fun getPackageArchiveInfo(
        archiveFilePath: String,
        flags: android.content.pm.PackageManager.PackageInfoFlags,
    ): android.content.pm.PackageInfo? {
        PackageQueryRecorder.typedArchiveCalls++
        PackageQueryRecorder.lastArchiveFlags = flags.value
        return PackageQueryRecorder.archiveResolver?.invoke(archiveFilePath)
            ?: PackageQueryRecorder.archivePackages[archiveFilePath]
    }

    @org.robolectric.annotation.Implementation
    override fun getPackageArchiveInfo(archiveFilePath: String, flags: Int): android.content.pm.PackageInfo? {
        PackageQueryRecorder.intArchiveCalls++
        PackageQueryRecorder.lastArchiveFlags = flags.toLong() and 0xffffffffL
        return PackageQueryRecorder.archiveResolver?.invoke(archiveFilePath)
            ?: PackageQueryRecorder.archivePackages[archiveFilePath]
    }
}

@org.robolectric.annotation.Implements(className = "android.app.ApplicationPackageManager")
class RecordingShadowApplicationPackageManager : RecordingShadowPackageManager() {
    @androidx.annotation.RequiresApi(android.os.Build.VERSION_CODES.TIRAMISU)
    @org.robolectric.annotation.Implementation(minSdk = android.os.Build.VERSION_CODES.TIRAMISU)
    protected fun getPackageInfo(
        packageName: String,
        flags: android.content.pm.PackageManager.PackageInfoFlags,
    ): android.content.pm.PackageInfo {
        PackageQueryRecorder.typedInstalledCalls++
        return PackageQueryRecorder.installedPackages[packageName]
            ?: throw android.content.pm.PackageManager.NameNotFoundException(packageName)
    }

    @org.robolectric.annotation.Implementation
    protected fun getPackageInfo(packageName: String, flags: Int): android.content.pm.PackageInfo {
        PackageQueryRecorder.intInstalledCalls++
        return PackageQueryRecorder.installedPackages[packageName]
            ?: throw android.content.pm.PackageManager.NameNotFoundException(packageName)
    }
}
