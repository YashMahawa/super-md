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
        rightPadding: isPinned ? 30 : 12
        Accessible.name: text + (isPinned ? ", pinned" : "")
        onClicked: list.openRequested(modelData)
        Hint { visible: entry.hovered; text: entry.modelData }
        ActionButton {
            objectName: "recentPinnedIndicator"
            visible: entry.isPinned
            anchors.right: parent.right; anchors.rightMargin: 8; anchors.verticalCenter: parent.verticalCenter
            width: 18; height: 18; padding: 0
            glyph: "PinLight"; icon.width: 16; icon.height: 16; icon.color: studio.palette.muted
            background: null
            enabled: false; focusPolicy: Qt.NoFocus; Accessible.ignored: true
        }
        TapHandler { acceptedButtons: Qt.RightButton; onTapped: menu.popup() }
        Keys.onMenuPressed: menu.popup()
        Menu {
            id: menu
            popupType: Popup.Item
            MenuItem { text: entry.isPinned ? "Unpin note" : "Pin note"; onTriggered: list.pinRequested(entry.modelData) }
        }
    }
    ScrollBar.vertical: ExpressiveScrollBar { }
}
