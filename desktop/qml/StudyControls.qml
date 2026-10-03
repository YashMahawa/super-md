import QtQuick
import QtQuick.Controls

Item {
    id: controls
    property bool awake: true
    signal contentsRequested()
    signal exitRequested()
    ActionButton {
        objectName: "studyContentsButton"
        anchors.left: parent.left; anchors.top: parent.top; anchors.margins: 12
        visible: parent.awake || contentsHover.hovered || activeFocus
        glyph: "Contents"; compact: true; tonal: true
        ToolTip.text: "Table of contents"
        HoverHandler { id: contentsHover }
        onClicked: controls.contentsRequested()
    }
    ActionButton {
        objectName: "studyExitButton"
        anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 12
        visible: parent.awake || exitHover.hovered || activeFocus
        glyph: "FullscreenExit"; icon.width: 24; icon.height: 24
        compact: true; tonal: true
        ToolTip.text: "Exit fullscreen (Esc · F11)"
        HoverHandler { id: exitHover }
        onClicked: controls.exitRequested()
    }
}
