import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Control {
    id: control
    required property var choices
    required property string selected
    signal chosen(string key)
    property var colors: studio.palette
    padding: 4
    implicitHeight: 44
    implicitWidth: contentItem.implicitWidth + 8
    background: Rectangle { radius: studio.themeMetrics ? studio.themeMetrics.controlRadius : 22; antialiasing: true; color: control.colors["surface-low"] }
    contentItem: RowLayout {
        spacing: 2
        Repeater {
            model: control.choices
            delegate: ActionButton {
                required property var modelData
                objectName: modelData.objectName || ("modeButton_" + modelData.key)
                text: modelData.label
                compact: true
                ToolTip.text: modelData.tooltip || ""
                // Qt's stock highlighted label uses its own accent palette,
                // ignoring Material.foreground. Keep our validated color pair.
                prominent: control.selected === modelData.key
                Accessible.name: modelData.label
                Accessible.description: prominent ? "Selected" : ""
                Layout.fillWidth: true
                onClicked: control.chosen(modelData.key)
            }
        }
    }
}
