import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: controls
    objectName: "studyToolbar"
    height: 56
    property bool awake: true
    property bool ready: true
    property string noteName: ""
    property var colors: studio.palette
    property bool motion: studio.motionEnabled
    readonly property bool hovered: barHover.hovered
    readonly property bool focusWithin: contents.visualFocus || save.visualFocus || exportNote.visualFocus || exit.visualFocus
    readonly property bool shown: awake || hovered || focusWithin
    signal contentsRequested()
    signal exitRequested()
    signal saveRequested()
    signal exportRequested()
    color: colors["surface-low"]
    opacity: shown ? 1 : 0
    Behavior on opacity { NumberAnimation { duration: controls.motion ? 120 : 0 } }
    HoverHandler { id: barHover }
    Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: controls.colors.outline; opacity: .55 }
    RowLayout {
        anchors.fill: parent; anchors.margins: 8; anchors.leftMargin: 12; anchors.rightMargin: 12
        spacing: 8
        visible: controls.shown
        ActionButton {
            id: contents; objectName: "studyContentsButton"
            glyph: "Contents"; compact: true
            ToolTip.text: "Table of contents"
            onClicked: controls.contentsRequested()
        }
        Label { text: controls.noteName; Layout.fillWidth: true; elide: Text.ElideRight; color: controls.colors.text; font.pixelSize: 14; font.weight: Font.Medium }
        ActionButton { id: save; glyph: "FloppyDisk"; compact: true; enabled: controls.ready; ToolTip.text: "Save note (Ctrl+S)"; onClicked: controls.saveRequested() }
        ActionButton { id: exportNote; glyph: "Export"; compact: true; enabled: controls.ready; ToolTip.text: "Export note"; onClicked: controls.exportRequested() }
        ActionButton {
            id: exit; objectName: "studyExitButton"
            glyph: "FullscreenExit"; compact: true
            ToolTip.text: "Exit fullscreen (Esc · F11)"
            onClicked: controls.exitRequested()
        }
    }
}
