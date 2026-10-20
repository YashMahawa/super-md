import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Native QDrag carries opaque IDs only. Content/asset ownership stays in Session.
ScrollView {
    id: strip
    objectName: "tabStrip"
    required property var viewState
    height: 48
    contentHeight: 48
    ScrollBar.vertical.policy: ScrollBar.AlwaysOff
    ScrollBar.horizontal: ExpressiveScrollBar { implicitHeight: 8; padding: 1 }
    function openRename(id, name) {
        renameDialog.noteId = id
        renameField.text = name
        renameDialog.open()
    }
    // Keep the prompt outside the Repeater: snapshots recreate tab delegates,
    // and must not destroy an open dialog or its in-progress filename.
    AppDialog {
        id: renameDialog
        objectName: "renameDialog"
        property string noteId: ""
        title: "Rename note"
        width: Math.min(400, parent ? parent.width - 32 : 400)
        standardButtons: Dialog.Ok | Dialog.Cancel
        TextField {
            id: renameField
            objectName: "renameField"
            width: parent.width
            implicitHeight: 52
            font.pixelSize: 16
            leftPadding: 14; rightPadding: 14; topPadding: 10; bottomPadding: 10
            selectByMouse: true
            Accessible.name: "Note name"
            color: renameDialog.colors.text
            selectionColor: renameDialog.colors.primary
            selectedTextColor: renameDialog.colors["on-primary"]
            background: Rectangle {
                color: renameDialog.colors.surface
                radius: 12
                antialiasing: true
                border.width: renameField.activeFocus ? 2 : 1
                border.color: renameField.activeFocus ? renameDialog.colors.primary : renameDialog.colors.outline
            }
            onAccepted: { if (text.trim().length) renameDialog.accept() }
        }
        onOpened: { renameField.forceActiveFocus(); renameField.selectAll() }
        onAccepted: studio.renameNote(noteId, renameField.text)
    }
    function receive(drop, index) {
        try {
            const payload = JSON.parse(drop.getDataAsString("application/x-supermd-tab"))
            if (!studio.canReceiveTab(payload.window, payload.tab)) return
            drop.acceptProposedAction()
            // Do not destroy a Repeater delegate inside QDrag's nested event loop.
            Qt.callLater(function() { studio.receiveTab(payload.window, payload.tab, index) })
        } catch (error) { /* Foreign or stale drag: leave every note untouched. */ }
    }
    Row {
        height: strip.height
        spacing: 4
        leftPadding: 16
        Repeater {
            model: strip.viewState.tabs
            delegate: Rectangle {
                id: tab
                required property var modelData
                required property int index
                width: Math.min(260, label.implicitWidth + 64)
                height: 40
                y: (strip.height - height) / 2
                objectName: "noteTab"
                radius: 18
                antialiasing: true
                color: modelData.id === strip.viewState.active ? strip.viewState.colors["surface-high"] : strip.viewState.colors.surface
                Drag.dragType: Drag.Automatic
                Drag.supportedActions: Qt.MoveAction
                Drag.proposedAction: Qt.MoveAction
                Drag.mimeData: ({"application/x-supermd-tab": JSON.stringify({window: studio.windowId, tab: modelData.id})})
                Drag.onDragFinished: function(action) { const id = modelData.id; tab.Drag.active = false; Qt.callLater(function() { studio.finishTabDrag(id, action) }) }
                DragHandler {
                    target: null
                    onActiveChanged: {
                        if (active) preview.grabToImage(function(result) {
                            if (dragHandler.active) { tab.Drag.imageSource = result.url; tab.Drag.active = true }
                        })
                    }
                    id: dragHandler
                }
                Rectangle {
                    id:preview
                    objectName:"tabDragPreview"
                    // A native drag image can leave the window; an in-window
                    // tooltip cannot. Render offscreen without moving/focusing chrome.
                    x:-1000;y:-1000;width:320;height:190;radius:18;antialiasing:true
                    color:strip.viewState.colors.surface;border.width:1;border.color:strip.viewState.colors.primary
                    Column {
                        anchors.fill:parent;anchors.margins:16;spacing:10
                        Label {text:tab.modelData.name;font.weight:Font.DemiBold;width:parent.width;elide:Text.ElideRight}
                        Label {text:"Release outside tabs to open a window";font.pixelSize:11;color:strip.viewState.colors.muted}
                        Label {text:studio.tabPreview(tab.modelData.id);textFormat:Text.PlainText;width:parent.width;height:105;clip:true;wrapMode:Text.WordWrap;font.pixelSize:12;color:strip.viewState.colors.text}
                    }
                }
                TapHandler { acceptedButtons: Qt.RightButton; onTapped: tabMenu.popup() }
                NoteContextMenu {
                    id: tabMenu
                    objectName: "tabContextMenu"
                    NoteMenuItem { text: "Rename note"; icon.source: "../icons/Rename.svg"; onTriggered: strip.openRename(tab.modelData.id, tab.modelData.name) }
                    NoteMenuItem { text: "Undo"; enabled: tab.modelData.id===strip.viewState.active; onTriggered:studio.command("undo") }
                    NoteMenuItem { text: "Redo"; enabled: tab.modelData.id===strip.viewState.active; onTriggered:studio.command("redo") }
                    MenuSeparator {}
                    NoteMenuItem { text: "Move to new window"; onTriggered: studio.detachTab(tab.modelData.id) }
                }
                RowLayout {
                    anchors.fill: parent
                    spacing: 0
                    ActionButton { id: label; compact: true; text: (modelData.dirty ? "• " : "") + modelData.name; Layout.fillWidth: true; ToolTip.text: modelData.path || modelData.name; onClicked: studio.selectTab(modelData.id) }
                    ActionButton { glyph: "X"; compact: true; implicitWidth: 36; Accessible.name: "Close " + modelData.name; ToolTip.text: "Close " + modelData.name; onClicked: studio.closeTabSafely(modelData.id) }
                }
                DropArea {
                    id: dropZone
                    anchors.fill: parent
                    keys: ["application/x-supermd-tab"]
                    property bool after: false
                    onPositionChanged: function(drag) { after = drag.x > width / 2 }
                    onEntered: function(drag) { after = drag.x > width / 2 }
                    onDropped: function(drop) { strip.receive(drop, tab.index + (drop.x > width / 2 ? 1 : 0)) }
                }
                Rectangle { visible: dropZone.containsDrag; x: dropZone.after ? parent.width - 2 : 0; width: 3; height: 32; anchors.verticalCenter: parent.verticalCenter; radius: 1.5; color: strip.viewState.colors.primary }
            }
        }
        ActionButton {
            objectName: "newTabButton"
            glyph: "Plus"; compact: true; implicitWidth: 40; implicitHeight: 40
            y: (strip.height - height) / 2
            Accessible.name: "New tab"
            ToolTip.text: "New tab (Ctrl+T)"
            onClicked: studio.newNote()
            DropArea { anchors.fill: parent; keys: ["application/x-supermd-tab"]; onDropped: function(drop) { strip.receive(drop, strip.viewState.tabs.length) } }
        }
    }
}
