package dev.supermd.studio

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
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
    else LazyColumn(modifier.fillMaxWidth().heightIn(max=520.dp),verticalArrangement=Arrangement.spacedBy(2.dp)) {
        items(rows,key={it.heading.id}) {row->
            val open=row.heading.id in expanded
            val toggle={expanded=if(open)expanded-row.heading.id else expanded+row.heading.id}
            val chevron by animateFloatAsState(if(open)0f else -90f,label="Outline chevron")
            // One rounded row with a soft tonal press state, not a boxy highlight.
            Surface(onClick={navigate(row.heading)},shape=RoundedCornerShape(50),color=Color.Transparent,modifier=Modifier.fillMaxWidth()) {
                Row(Modifier.padding(start=(4+row.depth*16).dp,end=12.dp).heightIn(min=if(row.depth==0)48.dp else 44.dp),verticalAlignment=Alignment.CenterVertically) {
                    if(row.depth>0)Box(Modifier.padding(end=6.dp).width(2.dp).height(18.dp).clip(RoundedCornerShape(1.dp)).background(MaterialTheme.colorScheme.outlineVariant))
                    if(row.children)Box(Modifier.size(36.dp).clip(CircleShape).clickable(onClick=toggle),contentAlignment=Alignment.Center){Icon(Icons.Rounded.ExpandMore,if(open)"Collapse ${row.heading.title}" else "Expand ${row.heading.title}",Modifier.size(22.dp).rotate(chevron),tint=MaterialTheme.colorScheme.onSurfaceVariant)}
                    else Spacer(Modifier.width(36.dp))
                    Text(row.heading.title,Modifier.weight(1f).padding(start=4.dp),maxLines=2,overflow=TextOverflow.Ellipsis,
                        style=if(row.depth==0)MaterialTheme.typography.titleSmall else MaterialTheme.typography.bodyMedium,
                        color=if(row.depth==0)MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}
