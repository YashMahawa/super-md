// Native Qt Slider gestures/accessibility, with Material 3 Expressive track/handle shapes.
// Design references: Google's M3 sliders and DankCommon's MIT-licensed grouped controls.
import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material

Slider {
    id: control
    property var colors: JSON.parse(studio.snapshot).colors
    property bool motion: JSON.parse(studio.snapshot).settings.motion
    implicitHeight: 44
    implicitWidth: 180
    padding: 0
    background: Item {
        x: control.leftPadding
        y: control.topPadding + (control.availableHeight - height) / 2
        width: control.availableWidth
        height: 18
        Rectangle { anchors.fill: parent; radius: 9; antialiasing: true; color: control.colors["surface-high"] }
        Rectangle { width: Math.max(0, control.visualPosition * parent.width - 6); height: parent.height; radius: 9; antialiasing: true; color: control.colors.primary }
    }
    handle: Rectangle {
        x: control.leftPadding + control.visualPosition * (control.availableWidth - width)
        y: control.topPadding + (control.availableHeight - height) / 2
        implicitWidth: control.pressed ? 4 : 6
        implicitHeight: control.pressed ? 38 : 32
        radius: 3
        antialiasing: true
        color: control.colors.primary
        border.width: control.visualFocus ? 2 : 0
        border.color: control.colors.text
        Behavior on implicitHeight { enabled: control.motion; SpringAnimation { spring: 5; damping: .85 } }
    }
    Hint { visible: control.pressed; text: Math.round(control.value).toString() }
}
