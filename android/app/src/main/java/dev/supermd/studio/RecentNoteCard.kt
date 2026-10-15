package dev.supermd.studio

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable internal fun RecentNoteCard(note:RecentNote,selected:Boolean,onOpen:()->Unit,onPin:()->Unit) {
    var menu by remember(note.uri) { mutableStateOf(false) }
    val colors=MaterialTheme.colorScheme
    Box {
        Surface(shape=RoundedCornerShape(16.dp),color=if(selected)colors.secondaryContainer else colors.surfaceContainerLow,contentColor=if(selected)colors.onSecondaryContainer else colors.onSurface,
            modifier=Modifier.fillMaxWidth().semantics { if(note.pinned)stateDescription="Pinned" }.combinedClickable(onClick=onOpen,onLongClickLabel="Recent note actions",onLongClick={menu=true})) {
            Row(Modifier.fillMaxWidth().padding(horizontal=14.dp,vertical=14.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                Icon(painterResource(R.drawable.symbol_file),null,Modifier.size(24.dp))
                Text(note.name,Modifier.weight(1f),maxLines=2,overflow=TextOverflow.Ellipsis,style=MaterialTheme.typography.bodyMedium)
                if(note.pinned)Icon(painterResource(R.drawable.symbol_pin_light),"Pinned",Modifier.size(16.dp),tint=colors.onSurfaceVariant)
            }
        }
        DropdownMenu(expanded=menu,onDismissRequest={menu=false}) {
            DropdownMenuItem(text={Text(if(note.pinned)"Unpin note" else "Pin note")},onClick={menu=false;onPin()})
        }
    }
}
