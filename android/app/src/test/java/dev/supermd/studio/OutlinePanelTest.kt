package dev.supermd.studio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutlinePanelTest {
    @Test fun singleRootIsAStaticTitleAndItsDirectSectionsStartVisible() {
        val entries=listOf(
            OutlineHeading("root","Root",3,0),
            OutlineHeading("first","First section",4,10),
            OutlineHeading("nested","Nested section",5,20),
            OutlineHeading("second","Second section",4,30),
        )

        val initial=outlineRows(entries,emptySet())
        assertEquals(listOf("root","first","second"),initial.map{it.heading.id})
        assertEquals(listOf(0,1,1),initial.map{it.depth})
        assertFalse(initial.first().collapsible)
        assertTrue(initial[1].collapsible)
        assertFalse(initial[2].collapsible)

        val expanded=outlineRows(entries,setOf("first"))
        assertEquals(listOf("root","first","nested","second"),expanded.map{it.heading.id})
    }

    @Test fun singleRootWithoutSectionsIsStillAPlainTitleRow() {
        val rows=outlineRows(listOf(OutlineHeading("root","Only heading",4,0)),emptySet())

        assertEquals(1,rows.size)
        assertEquals("root",rows.single().heading.id)
        assertFalse(rows.single().children)
        assertFalse(rows.single().collapsible)
    }

    @Test fun multipleRootsKeepTheirExistingCollapsedBehavior() {
        val entries=listOf(
            OutlineHeading("first","First root",2,0),
            OutlineHeading("child","Child",3,10),
            OutlineHeading("second","Second root",2,20),
        )

        val initial=outlineRows(entries,emptySet())
        assertEquals(listOf("first","second"),initial.map{it.heading.id})
        assertEquals(listOf(true,false),initial.map{it.collapsible})
        assertEquals(listOf("first","child","second"),outlineRows(entries,setOf("first")).map{it.heading.id})
    }
}
