import QtQuick
import QtQuick.Controls

ActionButton {
    objectName: "sidebarToggle"
    property bool expanded: true
    glyph: "SidebarSimple"
    motion: false
    scale: 1
    ToolTip.text: expanded ? "Hide files" : "Show files"
    Accessible.name: ToolTip.text
}
