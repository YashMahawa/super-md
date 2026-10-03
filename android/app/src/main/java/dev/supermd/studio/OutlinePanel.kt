package dev.supermd.studio

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

internal data class OutlineRow(val heading:OutlineHeading,val depth:Int,val children:Boolean)
internal fun outlineRows(entries:List<OutlineHeading>,expanded:Set<String>):List<OutlineRow> {
    val parents=mutableListOf<Pair<OutlineHeading,Boolean>>()
    return buildList {entries.forEachIndexed {index,heading->
        while(parents.isNotEmpty() && parents.last().first.level>=heading.level)parents.removeAt(parents.lastIndex)
        val visible=parents.all{it.second}
        val children=entries.getOrNull(index+1)?.let{it.level>heading.level}?:false
        if(visible)add(OutlineRow(heading,parents.size,children))
        parents.add(heading to (visible && heading.id in expanded))
    }}
}
@Composable internal fun OutlinePanel(entries:List<OutlineHeading>,noteId:String,modifier:Modifier=Modifier,navigate:(OutlineHeading)->Unit) {
    var expanded by remember(noteId){mutableStateOf(emptySet<String>())}
    val rows=remember(entries,expanded){outlineRows(entries,expanded)}
    if(entries.isEmpty())Text("Headings in this note will appear here.",modifier.padding(16.dp),color=MaterialTheme.colorScheme.onSurfaceVariant)
    else LazyColumn(modifier.fillMaxWidth().heightIn(max=520.dp)) {
        items(rows,key={it.heading.id}) {row->
            Row(Modifier.fillMaxWidth().padding(start=(row.depth*14).dp),verticalAlignment=Alignment.CenterVertically) {
                if(row.children)IconButton(onClick={expanded=if(row.heading.id in expanded)expanded-row.heading.id else expanded+row.heading.id}){Icon(if(row.heading.id in expanded)Icons.Rounded.ExpandMore else Icons.Rounded.ChevronRight,if(row.heading.id in expanded)"Collapse ${row.heading.title}" else "Expand ${row.heading.title}")}
                else Spacer(Modifier.width(48.dp))
                Text(row.heading.title,Modifier.weight(1f).clickable{navigate(row.heading)}.padding(top=14.dp,bottom=14.dp,end=8.dp),maxLines=2,overflow=TextOverflow.Ellipsis,style=MaterialTheme.typography.bodyMedium)
            }
        }
    }
}
