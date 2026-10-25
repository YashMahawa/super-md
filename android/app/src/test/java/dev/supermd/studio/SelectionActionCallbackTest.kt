package dev.supermd.studio

import android.app.Activity
import android.graphics.Rect
import android.view.ActionMode
import android.view.Menu
import android.view.MenuInflater
import android.view.MenuItem
import android.view.View
import android.widget.PopupMenu
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28],manifest=Config.NONE)
class SelectionActionCallbackTest {
    @Test fun nativeActionsAndToolbarAnchorArePreservedAndNoActionRunsUntilTapped() {
        val activity=Robolectric.buildActivity(Activity::class.java).setup().get()
        val view=View(activity)
        val menu=PopupMenu(activity,view).menu
        val mode=object:ActionMode() {
            override fun setTitle(title:CharSequence?) {}
            override fun setTitle(resId:Int) {}
            override fun setSubtitle(subtitle:CharSequence?) {}
            override fun setSubtitle(resId:Int) {}
            override fun setCustomView(view:View?) {}
            override fun invalidate() {}
            override fun finish() {}
            override fun getMenu()=menu
            override fun getTitle():CharSequence=""
            override fun getSubtitle():CharSequence=""
            override fun getCustomView():View?=null
            override fun getMenuInflater()=MenuInflater(activity)
        }
        var stockClicks=0;var destroyed=0
        val original=object:ActionMode.Callback2() {
            override fun onCreateActionMode(mode:ActionMode,menu:Menu):Boolean {menu.add(0,android.R.id.copy,0,"Copy");return true}
            override fun onPrepareActionMode(mode:ActionMode,menu:Menu)=false
            override fun onActionItemClicked(mode:ActionMode,item:MenuItem):Boolean {stockClicks++;return true}
            override fun onDestroyActionMode(mode:ActionMode) {destroyed++}
            override fun onGetContentRect(mode:ActionMode,view:View,outRect:Rect) {outRect.set(10,20,110,60)}
        }
        val called=mutableListOf<String>();var provider="ChatGPT"
        val callback=SelectionActionCallback(original,{provider}) {action,_->called.add(action)}
        assertTrue(callback.onCreateActionMode(mode,menu));assertEquals(3,menu.size());assertTrue(called.isEmpty())
        assertFalse(callback.onPrepareActionMode(mode,menu));assertEquals(3,menu.size())
        provider="Gemini";assertTrue(callback.onPrepareActionMode(mode,menu))
        assertEquals("Ask Gemini…",menu.findItem(SelectionActionCallback.ASK).title)
        val rect=Rect();callback.onGetContentRect(mode,view,rect);assertEquals(Rect(10,20,110,60),rect)
        assertTrue(callback.onActionItemClicked(mode,menu.findItem(android.R.id.copy)));assertEquals(1,stockClicks)
        callback.onActionItemClicked(mode,menu.findItem(SelectionActionCallback.SEARCH))
        callback.onActionItemClicked(mode,menu.findItem(SelectionActionCallback.ASK))
        assertEquals(listOf("google","assistant"),called)
        callback.onDestroyActionMode(mode);assertEquals(1,destroyed)
        activity.finish()
    }
}
