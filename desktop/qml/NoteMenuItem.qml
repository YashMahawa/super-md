import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material

MenuItem {
    id: item
    property var colors: studio.palette
    implicitHeight: 42
    font.family: "Noto Sans"
    font.pixelSize: 14
    leftPadding: 12
    rightPadding: 12
    Material.foreground: enabled ? colors.text : colors.muted
    icon.color: Material.foreground
    icon.width: 22
    icon.height: 22
    background: Rectangle {
        radius: 10
        antialiasing: true
        color: item.highlighted || item.hovered || item.down ? item.colors["surface-high"] : "transparent"
        border.width: item.visualFocus ? 1 : 0
        border.color: item.colors.primary
    }
}
