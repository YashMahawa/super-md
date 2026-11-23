package dev.supermd.studio

import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Query the installed app's real manifest, rather than a JVM mock manifest. */
@RunWith(AndroidJUnit4::class)
class ExternalPortableMimeTest {
    @Test fun compressedNotesCanOpenFromOpaqueProviderUris() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext
        for (mime in listOf("application/gzip", "application/x-gzip", "application/vnd.supermd.smd")) {
            val intent = Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse("content://test.documents/document/opaque-id"), mime).setPackage(app.packageName)
            val matches = app.packageManager.queryIntentActivities(intent, 0)
            assertTrue("Super MD must handle $mime even when the URI has no filename", matches.any {
                it.activityInfo.packageName == app.packageName && it.activityInfo.name.endsWith("MainActivity")
            })
        }
    }
}
