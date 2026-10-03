import QtQuick
import QtQuick.Controls

// Captionless Linux compositors still get normal minimize/maximize/close
// actions. Never replace Qt.Window with FramelessWindowHint: native tiling,
// resizing and window-manager shortcuts must continue working.
Item {
    id: control
    required property var host
    required property var colors
    signal closeRequested()
    implicitWidth: 124
    implicitHeight: 36
    Row {
      anchors.fill: parent
      spacing: 2
      Repeater {
        model: ["minimize", "maximize", "close"]
        delegate: ActionButton {
            required property string modelData
            objectName: "windowControl_" + modelData
            width: 40; height: 36; compact: true
            colors: control.colors
            glyph: modelData === "close" ? "X" : modelData === "minimize" ? "Minimize" : control.host.visibility === Window.Maximized ? "Restore" : "Maximize"
            readonly property string hint: modelData === "close" ? "Close window" : modelData === "minimize" ? "Minimize" : control.host.visibility === Window.Maximized ? "Restore window" : "Maximize"
            Accessible.name: hint
            ToolTip.text: hint
            onClicked: {
                if(modelData==="close")control.closeRequested()
                else if(modelData==="minimize")control.host.showMinimized()
                else if(control.host.visibility===Window.Maximized)control.host.showNormal()
                else control.host.showMaximized()
            }
        }
      }
    }
}
