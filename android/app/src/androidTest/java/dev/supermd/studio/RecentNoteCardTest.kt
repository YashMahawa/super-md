package dev.supermd.studio

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class RecentNoteCardTest {
    @get:Rule val compose=createAndroidComposeRule<ComponentActivity>()
    @Test fun longPressOffersPinAndOnlyPinnedNotesHaveAnIndicator() {
        val note=mutableStateOf(RecentNote("Study.md","content://notes/study"));var opened=0
        compose.activity.runOnUiThread {compose.activity.setContent {MaterialTheme {
            RecentNoteCard(note.value,false,{opened++},{note.value=note.value.copy(pinned=!note.value.pinned)})
        }}}
        compose.onNodeWithContentDescription("Pinned").assertDoesNotExist()
        compose.onNodeWithText("Study.md").performClick();compose.runOnIdle {assertEquals(1,opened)}
        compose.onNodeWithText("Study.md").performTouchInput {longClick()}
        compose.onNodeWithText("Pin note").assertIsDisplayed().performClick()
        compose.onNodeWithContentDescription("Pinned",useUnmergedTree=true).assertExists()
        compose.runOnIdle {assertTrue(note.value.pinned);assertEquals(1,opened)}
        compose.onNodeWithText("Study.md").performTouchInput {longClick()}
        compose.onNodeWithText("Unpin note").performClick()
        compose.onNodeWithContentDescription("Pinned").assertDoesNotExist()
    }
}
