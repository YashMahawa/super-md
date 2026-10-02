import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material

Button {
    id: control
    property bool prominent: false
    property bool compact: false
    property string glyph: ""
    property bool tonal: false
    property var colors: JSON.parse(studio.snapshot).colors
    property bool motion: JSON.parse(studio.snapshot).settings.motion
    font.family: "Noto Sans"
    font.pixelSize: 14
    font.weight: Font.Medium
    implicitHeight: compact ? 36 : 44
    implicitWidth: Math.max(text.length ? 64 : 44, contentItem.implicitWidth + leftPadding + rightPadding)
    topInset: 0
    bottomInset: 0
    leftPadding: text.length ? 16 : 10
    rightPadding: text.length ? 16 : 10
    // Stock Material padding assumes a 48px button. Preserve the icon's actual
    // size inside our compact 36px controls instead of shrinking it to ~8px.
    topPadding: compact ? 6 : 10
    bottomPadding: compact ? 6 : 10
    icon.source: glyph ? "../icons/" + glyph + ".svg" : ""
    icon.width: 24
    icon.height: 24
    icon.color: Material.foreground
    Accessible.name: ToolTip.text || text
    Material.roundedScale: Material.FullScale
    Material.background: prominent ? Material.primary : JSON.parse(studio.snapshot).colors["surface-high"]
    Material.foreground: prominent ? colors["on-primary"] : highlighted ? colors["on-primary-container"] : colors.text
    Material.elevation: 0
    background: Rectangle {
        antialiasing: true
        radius: control.down ? 10 : control.highlighted ? 14 : height / 2
        color: control.prominent ? control.colors.primary : control.highlighted ? control.colors["primary-container"] : control.tonal ? control.colors["surface-high"] : "transparent"
        border.width: control.visualFocus ? 2 : 0
        border.color: control.colors.primary
        Behavior on radius { enabled: control.motion; NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }
        Rectangle { anchors.fill: parent; radius: parent.radius; antialiasing: true; color: control.Material.foreground; opacity: control.down ? .12 : control.hovered ? .08 : 0; Behavior on opacity { enabled: control.motion; NumberAnimation { duration: 120 } } }
    }
    scale: down ? .96 : 1
    Behavior on scale { enabled: JSON.parse(studio.snapshot).settings.motion; SpringAnimation { spring: 5; damping: .75 } }
    ToolTip.visible: hovered && ToolTip.text.length > 0
    ToolTip.delay: 650
}
