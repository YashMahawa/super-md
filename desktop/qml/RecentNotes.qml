import QtQuick
import QtQuick.Controls

ListView {
    id: list
    property var pinned: []
    signal openRequested(string path)
    signal pinRequested(string path)
    clip: true
    delegate: ItemDelegate {
        id: entry
        required property string modelData
        readonly property bool isPinned: list.pinned.includes(modelData)
        objectName: "recentNoteEntry"
        width: ListView.view.width - 12; height: 40
        text: modelData.split("/").pop()
        hoverEnabled: true
        leftPadding: 12
        rightPadding: isPinned ? 30 : 12
        Accessible.name: text + (isPinned ? ", pinned" : "")
        onClicked: list.openRequested(modelData)
        contentItem: Text { text:entry.text; font:entry.font; color:studio.palette.text; elide:Text.ElideRight; verticalAlignment:Text.AlignVCenter }
        background: Rectangle {
            radius: 12
            antialiasing: true
            color: entry.hovered || entry.down || entry.visualFocus ? studio.palette["surface-high"] : "transparent"
            border.width: entry.visualFocus ? 1 : 0
            border.color: studio.palette.primary
        }
        Hint { requested: entry.hovered; text: entry.modelData }
        ActionButton {
            objectName: "recentPinnedIndicator"
            visible: entry.isPinned
            anchors.right: parent.right; anchors.rightMargin: 8; anchors.verticalCenter: parent.verticalCenter
            width: 18; height: 18
            topPadding: 0; bottomPadding: 0; leftPadding: 0; rightPadding: 0
            glyph: "PinLight"; icon.width: 16; icon.height: 16; icon.color: studio.palette.muted
            background: null
            enabled: false; focusPolicy: Qt.NoFocus; Accessible.ignored: true
        }
        TapHandler { acceptedButtons: Qt.RightButton; onTapped: menu.popup() }
        Keys.onMenuPressed: menu.popup()
        NoteContextMenu {
            id: menu
            objectName: "recentContextMenu"
            NoteMenuItem { text: entry.isPinned ? "Unpin note" : "Pin note"; icon.source:"../icons/PinLight.svg"; onTriggered: list.pinRequested(entry.modelData) }
        }
    }
    ScrollBar.vertical: ExpressiveScrollBar { }
}
