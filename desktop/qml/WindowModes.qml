import QtQuick

QtObject {
    required property var host
    property int restoreVisibility: Window.Windowed
    readonly property bool fullscreen: host.visibility === Window.FullScreen

    function setFullscreen(enabled) {
        if (enabled === fullscreen) return
        if (enabled) {
            restoreVisibility = host.visibility === Window.Maximized ? Window.Maximized : Window.Windowed
            host.showFullScreen()
        } else if (restoreVisibility === Window.Maximized) {
            host.showMaximized()
        } else {
            host.showNormal()
        }
    }
}
