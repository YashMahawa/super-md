import QtQuick

QtObject {
    required property var host
    property int restoreVisibility: Window.Windowed
    // Windows keeps its caption buttons over an expanded client area, even in
    // fullscreen. A temporary frameless window gives true fullscreen there.
    property bool immersive: false
    readonly property bool fullscreen: host.visibility === Window.FullScreen
    onFullscreenChanged: if (!fullscreen) immersive = false

    function setFullscreen(enabled) {
        if (enabled === fullscreen) return
        if (enabled) {
            restoreVisibility = host.visibility === Window.Maximized ? Window.Maximized : Window.Windowed
            immersive = Qt.platform.os === "windows"
            host.showFullScreen()
        } else {
            immersive = false
            if (restoreVisibility === Window.Maximized) host.showMaximized()
            else host.showNormal()
        }
    }
}
