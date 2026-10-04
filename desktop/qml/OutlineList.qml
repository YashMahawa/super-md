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
    spacing: 2
    delegate: ItemDelegate {
        id: heading
        required property var modelData
        readonly property var colors: studio.palette
        readonly property bool open: !!outline.expanded[modelData.id]
        width: ListView.view.width - 14
        height: modelData.depth === 0 ? 44 : 38
        leftPadding: 8 + modelData.depth * 16
        rightPadding: 12
        Accessible.name: modelData.title
        onClicked: { studio.navigateHeading(modelData.id,modelData.offset); outline.chosen() }
        // One soft pill per row: tonal state layer, no boxy outline or nested buttons.
        background: Rectangle {
            radius: height / 2
            antialiasing: true
            color: heading.colors.text
            opacity: heading.down ? .12 : heading.hovered || heading.visualFocus ? .07 : 0
            Behavior on opacity { enabled: studio.motionEnabled; NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }
        }
        contentItem: RowLayout {
            spacing: 6
            Rectangle {
                // Depth guide for nested headings.
                visible: heading.modelData.depth > 0
                Layout.preferredWidth: 2; Layout.preferredHeight: 18; radius: 1
                color: heading.colors.outline
            }
            ToolButton {
                id: toggle
                visible: heading.modelData.children
                focusPolicy: Qt.NoFocus
                Layout.preferredWidth: 28; Layout.preferredHeight: 28
                padding: 2
                icon.source: "../icons/CaretDown.svg"; icon.color: heading.colors.muted; icon.width: 20; icon.height: 20
                rotation: heading.open ? 0 : -90
                Behavior on rotation { enabled: studio.motionEnabled; NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }
                Accessible.name: (heading.open ? "Collapse " : "Expand ") + heading.modelData.title
                background: Rectangle { radius: 14; color: heading.colors.text; opacity: toggle.hovered ? .1 : 0 }
                onClicked: { const next=Object.assign({},outline.expanded);next[heading.modelData.id]=!heading.open;outline.expanded=next }
            }
            Item { visible: !heading.modelData.children; Layout.preferredWidth: 28 }
            Label {
                id: titleLabel
                Layout.fillWidth: true
                text: heading.modelData.title
                elide: Text.ElideRight
                color: heading.modelData.depth === 0 ? heading.colors.text : heading.colors.muted
                font.pixelSize: heading.modelData.depth === 0 ? 14 : 13
                font.weight: heading.modelData.depth === 0 ? Font.DemiBold : Font.Normal
            }
        }
        Hint { visible: heading.hovered && titleLabel.truncated; text: heading.modelData.title }
    }
    signal chosen()
    ScrollBar.vertical: ExpressiveScrollBar { }
}
