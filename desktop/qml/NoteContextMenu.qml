import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material

Menu {
    id: menu
    property var colors: studio.palette
    readonly property var hostWindow: parent ? parent.Window.window : null
    property bool blockingHints: false
    popupType: Popup.Item
    implicitWidth: 250
    padding: 6
    enter: Transition {}
    exit: Transition {}
    Material.foreground: colors.text
    Material.background: colors["surface-low"]
    Material.elevation: 0
    background: Rectangle {
        color: menu.colors["surface-low"]
        radius: 16
        antialiasing: true
        border.width: 1
        border.color: menu.colors.outline
    }
    onAboutToShow: {
        if(hostWindow && hostWindow.contextMenuCount !== undefined && !blockingHints) {
            hostWindow.contextMenuCount++
            blockingHints = true
        }
    }
    onClosed: {
        if(blockingHints && hostWindow) hostWindow.contextMenuCount = Math.max(0, hostWindow.contextMenuCount-1)
        blockingHints = false
    }
    Component.onDestruction: {
        if(blockingHints && hostWindow) hostWindow.contextMenuCount = Math.max(0, hostWindow.contextMenuCount-1)
    }
}
