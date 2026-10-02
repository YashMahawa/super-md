import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Native QDrag carries opaque IDs only. Content/asset ownership stays in Session.
ScrollView {
    id: strip
    objectName: "tabStrip"
    required property var viewState
    height: 48
    contentHeight: 44
    ScrollBar.vertical.policy: ScrollBar.AlwaysOff
    ScrollBar.horizontal: ExpressiveScrollBar { implicitHeight: 8; padding: 1 }
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
                        if (active) tab.grabToImage(function(result) {
                            if (dragHandler.active) { tab.Drag.imageSource = result.url; tab.Drag.active = true }
                        })
                    }
                    id: dragHandler
                }
                TapHandler { acceptedButtons: Qt.RightButton; onTapped: tabMenu.popup() }
                Menu { id: tabMenu; MenuItem { text: "Move to new window"; onTriggered: studio.detachTab(tab.modelData.id) } }
                RowLayout {
                    anchors.fill: parent
                    spacing: 0
                    ActionButton { id: label; compact: true; text: (modelData.dirty ? "• " : "") + modelData.name; Layout.fillWidth: true; onClicked: studio.selectTab(modelData.id) }
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
            text: "New tab"; compact: true; onClicked: studio.newNote()
            DropArea { anchors.fill: parent; keys: ["application/x-supermd-tab"]; onDropped: function(drop) { strip.receive(drop, strip.viewState.tabs.length) } }
        }
    }
}
