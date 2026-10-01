package dev.supermd.studio

import androidx.activity.compose.setContent
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.material3.*
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Rule
import org.junit.Test

class PaintControlTest {
    // A renderer calibration must not race the real app's welcome Dialog,
    // WebView startup or state restoration. StudioUiTest covers MainActivity.
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private fun assertPaintedStripes(name: String) {
        compose.waitForIdle()
        var latest: android.graphics.Bitmap? = null
        var observed = "no screenshot"
        try {
            // Compose idleness does not guarantee that SurfaceFlinger has
            // presented a frame. Wait for actual pixels, not a fixed sleep.
            compose.waitUntil(15_000) {
                latest?.recycle()
                val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
                latest = bitmap
                if (bitmap == null) false else {
                    val pixels = listOf(1, 2, 3).map { bitmap.getPixel(bitmap.width / 2, bitmap.height * it / 4) }
                    observed = pixels.joinToString { "#%08x".format(it) }
                    pixels == listOf(android.graphics.Color.RED, android.graphics.Color.GREEN, android.graphics.Color.BLUE)
                }
            }
        } catch (error: androidx.compose.ui.test.ComposeTimeoutException) {
            throw AssertionError("$name must present red/green/blue stripes; observed $observed", error)
        } finally {
            latest?.let { bitmap ->
                java.io.File(compose.activity.cacheDir, "$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
        }
    }
    @OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
    @Test fun materialDrawerSurfacePaints() {
        compose.activity.runOnUiThread { compose.activity.setContent {
            MaterialExpressiveTheme {
                BoxWithConstraints(Modifier.fillMaxSize().background(Color.Yellow)) {
                    ModalNavigationDrawer(drawerState = rememberDrawerState(DrawerValue.Closed), drawerContent = { ModalDrawerSheet { Text("Drawer") } }) {
                        Column(Modifier.fillMaxSize()) {
                            Surface(color = Color.Red, modifier = Modifier.fillMaxWidth().weight(1f)) { Text("RED") }
                            Surface(color = Color.Green, modifier = Modifier.fillMaxWidth().weight(1f)) { Text("GREEN") }
                            Surface(color = Color.Blue, modifier = Modifier.fillMaxWidth().weight(1f)) { Text("BLUE") }
                        }
                    }
                }
            }
        } }
        assertPaintedStripes("material-control")
    }
    @Test fun composeSurfacePaintsOnTheTestRenderer() {
        compose.activity.runOnUiThread { compose.activity.setContent {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxWidth().weight(1f).background(Color.Red))
                Box(Modifier.fillMaxWidth().weight(1f).background(Color.Green))
                Box(Modifier.fillMaxWidth().weight(1f).background(Color.Blue))
            }
        } }
        assertPaintedStripes("paint-control")
    }
}
