import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ListView {
    id: outline
    property var entries: []
    property string noteId: ""
    property var expanded: ({})
    onNoteIdChanged: expanded = ({})
    clip: true
    function visibleEntries() {
        const result = [], stack = []
        for (let i=0; i<entries.length; i++) {
            const entry=entries[i]
            while(stack.length && stack[stack.length-1].level >= entry.level)stack.pop()
            const hidden=stack.some(parent => !expanded[parent.id])
            if(!hidden)result.push({id:entry.id,title:entry.title,offset:entry.offset,depth:stack.length,children:i+1<entries.length&&entries[i+1].level>entry.level})
            stack.push(entry)
        }
        return result
    }
    model: visibleEntries()
    delegate: Item {
        required property var modelData
        width: ListView.view.width - 18
        height: 44
        RowLayout {
            anchors.fill: parent
            anchors.leftMargin: modelData.depth * 12
            spacing: 0
            ActionButton { visible: modelData.children; compact: true; implicitWidth: 32; glyph: "CaretDown"; rotation: outline.expanded[modelData.id] ? 0 : -90; Accessible.name: (outline.expanded[modelData.id] ? "Collapse " : "Expand ") + modelData.title; onClicked: { const next=Object.assign({},outline.expanded);next[modelData.id]=!next[modelData.id];outline.expanded=next } }
            Item { visible: !modelData.children; Layout.preferredWidth: 32 }
            ItemDelegate {
                id: heading
                Layout.fillWidth: true
                height: 44
                text: modelData.title
                onClicked: { studio.navigateHeading(modelData.id,modelData.offset); outline.chosen() }
                Hint { visible: heading.hovered; text: modelData.title }
            }
        }
    }
    signal chosen()
    ScrollBar.vertical: ExpressiveScrollBar { }
}
