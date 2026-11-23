import QtQuick
import QtQuick.Controls

// The host owns the window frame and the unsaved-note close flow.
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
