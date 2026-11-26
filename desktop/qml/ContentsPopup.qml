import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Popup {
    id: popup
    objectName: "contentsOverlay"
    required property var viewState
    required property real windowWidth
    required property real windowHeight
    signal headingChosen()
    parent: Overlay.overlay
    x: 16
    y: popup.viewState.fullscreen ? 64 : Math.min(180, popup.windowHeight / 4)
    width: Math.min(340, popup.windowWidth - 32)
    height: Math.min(480, popup.windowHeight - y - 24)
    padding: 16
    closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
    background: Rectangle { radius: 24; color: popup.viewState.colors["surface-high"]; border.color: popup.viewState.colors.outline; border.width: 1; antialiasing: true }
    ColumnLayout {
        anchors.fill: parent
        RowLayout {
            Label { text: "Contents"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.fillWidth: true }
            ActionButton { glyph: "X"; compact: true; ToolTip.text: "Close contents"; onClicked: popup.close() }
        }
        OutlineList {
            Layout.fillWidth: true
            Layout.fillHeight: true
            entries: popup.viewState.outline || []
            noteId: popup.viewState.active
            onChosen: { popup.close(); popup.headingChosen() }
        }
    }
}
