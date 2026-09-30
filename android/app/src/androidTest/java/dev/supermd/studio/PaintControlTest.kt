package dev.supermd.studio

import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.material3.*
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class PaintControlTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
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
        compose.waitForIdle()
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()!!
        java.io.File(compose.activity.cacheDir, "material-control.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }
        assertTrue(bitmap.getPixel(bitmap.width / 2, bitmap.height / 2) == android.graphics.Color.GREEN)
    }
    @Test fun composeSurfacePaintsOnTheTestRenderer() {
        compose.activity.runOnUiThread { compose.activity.setContent {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxWidth().weight(1f).background(Color.Red))
                Box(Modifier.fillMaxWidth().weight(1f).background(Color.Green))
                Box(Modifier.fillMaxWidth().weight(1f).background(Color.Blue))
            }
        } }
        compose.waitForIdle()
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()!!
        java.io.File(compose.activity.cacheDir, "paint-control.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }
        assertTrue(bitmap.getPixel(bitmap.width / 2, bitmap.height / 2) == android.graphics.Color.GREEN)
    }
}
