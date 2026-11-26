package dev.supermd.studio

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ReaderSearchShortcutTest {
    @Test fun handleShortcutRoutesFindReplaceAndF3MatchStepping() {
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        val activity = controller.get()
        val opened = mutableListOf<Boolean>()
        val steps = mutableListOf<Int>()
        activity.openReaderFind = { replace -> opened += replace }
        activity.stepReaderFind = { direction -> steps += direction }

        val ctrlF = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_F, 0, KeyEvent.META_CTRL_ON)
        assertTrue(activity.handleShortcut(ctrlF))
        assertEquals(listOf(false), opened)

        val ctrlH = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_H, 0, KeyEvent.META_CTRL_ON)
        assertTrue(activity.handleShortcut(ctrlH))
        assertEquals(listOf(false, true), opened)

        val ctrlShiftH = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_H, 0, KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON)
        assertFalse(activity.handleShortcut(ctrlShiftH))
        assertEquals(listOf(false, true), opened)

        val f3 = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_F3, 0, 0)
        assertTrue(activity.handleShortcut(f3))
        assertEquals(listOf(1), steps)

        val shiftF3 = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_F3, 0, KeyEvent.META_SHIFT_ON)
        assertTrue(activity.handleShortcut(shiftF3))
        assertEquals(listOf(1, -1), steps)

        val ctrlShiftF = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_F, 0, KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON)
        assertTrue(activity.handleShortcut(ctrlShiftF))
        assertEquals(listOf(false, true), opened)

        val f3DuringFolderSearch = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_F3, 0, 0)
        assertTrue(activity.handleShortcut(f3DuringFolderSearch))
        assertEquals(listOf(1, -1), steps)

        val escapeFolderSearch = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ESCAPE, 0, 0)
        assertTrue(activity.handleShortcut(escapeFolderSearch))
    }
}
