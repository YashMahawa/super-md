import QtQuick
import QtQuick.Controls

ToolTip {
    id: tip
    property var colors: JSON.parse(studio.snapshot).colors
    delay: 550
    timeout: 7000
    padding: 10
    font.pixelSize: 13
    font.family: "Noto Sans"
    contentItem: Text { text: tip.text; color: tip.colors.text; font: tip.font; wrapMode: Text.Wrap; textFormat: Text.PlainText }
    background: Rectangle { color: tip.colors["surface-high"]; radius: 10; antialiasing: true; border.width: 1; border.color: tip.colors.outline }
}
