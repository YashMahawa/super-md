import QtQuick
import QtQuick.Controls

// Keep Qt's native scroll behavior, with a rounded thumb in a separate gutter.
ScrollBar {
    id: control
    property var colors: studio.palette
    property bool motion: studio.motionEnabled
    implicitWidth: 16
    implicitHeight: 16
    padding: 4
    minimumSize: .08
    policy: ScrollBar.AsNeeded
    hoverEnabled: true
    // Opacity, not visibility/width: the gutter and pointer hit area stay stable.
    opacity: active || hovered || pressed ? 1 : 0
    Behavior on opacity { enabled: control.motion; NumberAnimation { duration: control.active || control.hovered || control.pressed ? 100 : 240 } }
    contentItem: Rectangle {
        implicitWidth: 8
        implicitHeight: 8
        radius: Math.min(width, height) / 2
        antialiasing: true
        color: control.pressed || control.hovered ? control.colors.primary : control.colors.muted
        opacity: control.pressed ? 1 : control.hovered ? .8 : .45
        Behavior on opacity { enabled: control.motion; NumberAnimation { duration: 140 } }
    }
    background: Rectangle {
        radius: Math.min(width, height) / 2
        color: control.colors["surface-high"]
        opacity: control.hovered || control.pressed ? .6 : 0
        antialiasing: true
        Behavior on opacity { enabled: control.motion; NumberAnimation { duration: 140 } }
    }
}
