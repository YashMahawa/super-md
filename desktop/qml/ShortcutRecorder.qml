import QtQuick
import QtQuick.Controls

FocusScope {
    id: control
    property string value: ""
    property bool recording: false
    property var colors: studio.palette
    signal captured(string sequence, string error)
    implicitWidth: 230
    implicitHeight: 44
    focus: recording
    activeFocusOnTab: true
    onActiveFocusChanged: if (!activeFocus && recording) {
        recording = false
        captured("", "cancel")
    }
    onVisibleChanged: if (!visible && recording) {
        recording = false
        captured("", "cancel")
    }

    Rectangle {
        anchors.fill: parent
        radius: 12
        color: control.recording ? control.colors["primary-container"] : control.colors["surface-high"]
        border.width: control.activeFocus ? 2 : 1
        border.color: control.activeFocus ? control.colors.primary : control.colors.outline
        Text {
            anchors.centerIn: parent
            width: parent.width - 24
            text: control.recording ? "Press a shortcut · Esc to cancel" : control.value || "Disabled"
            color: control.recording ? control.colors["on-primary-container"] : control.colors.text
            font.pixelSize: 14
            horizontalAlignment: Text.AlignHCenter
            elide: Text.ElideRight
        }
        TapHandler {
            onTapped: {
                control.recording = true
                control.forceActiveFocus()
            }
        }
    }
    Accessible.role: Accessible.Button
    Accessible.name: recording ? "Recording shortcut" : "Shortcut: " + (value || "Disabled") + ". Activate to change."
    Keys.onPressed: function(event) {
        if (!control.recording) {
            if ([Qt.Key_Return, Qt.Key_Enter, Qt.Key_Space].includes(event.key)) {
                event.accepted = true
                control.recording = true
                control.forceActiveFocus()
            }
            return
        }
        event.accepted = true
        if (event.key === Qt.Key_Escape) {
            control.recording = false
            control.captured("", "cancel")
            return
        }
        if (event.key === Qt.Key_Backspace || event.key === Qt.Key_Delete) {
            control.recording = false
            control.captured("", "")
            return
        }
        if ([Qt.Key_Control, Qt.Key_Shift, Qt.Key_Alt, Qt.Key_Meta, Qt.Key_AltGr].includes(event.key)) return
        const result = JSON.parse(studio.captureShortcut(event.key, event.modifiers))
        if (result.sequence) {
            control.recording = false
            control.captured(result.sequence, "")
        } else {
            control.captured("", result.error)
        }
    }
}
