import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Pane {
    id: sidebar
    required property var viewState
    required property var sidebarState
    property var tabsState: typeof studio !== "undefined" && studio && studio.tabsSnapshot !== undefined
        ? JSON.parse(studio.tabsSnapshot)
        : (sidebar.viewState && sidebar.viewState.tabs ? sidebar.viewState.tabs : [])
    property string activeTabId: typeof studio !== "undefined" && studio && studio.activeTabId !== undefined
        ? String(studio.activeTabId)
        : (sidebar.sidebarState && sidebar.sidebarState.active ? String(sidebar.sidebarState.active) : (sidebar.viewState && sidebar.viewState.active ? String(sidebar.viewState.active) : ""))
    property var shortcutLabels: ({})
    property string section: "folder"
    signal sectionEdited(string value)
    SplitView.preferredWidth: 260
    SplitView.minimumWidth: 200
    SplitView.maximumWidth: 500
    padding: 16
    background: ThemeSurface { area: "sidebar" }

    function shortcutHint(label, key, fallback) {
        const map = sidebar.shortcutLabels || {}
        const raw = map[key] !== undefined ? map[key] : (fallback || "")
        return raw && raw !== "Disabled" ? label + " (" + raw + ")" : label
    }

    function triggerNewFolderNote() { folderTree.triggerNewFolderNote() }
    function triggerNewSubfolder() { folderTree.triggerNewSubfolder() }
    function triggerRenameSelectedOrActive() { folderTree.triggerRenameSelectedOrActive() }

    ColumnLayout {
        anchors.fill: parent
        spacing: 12
        Label { text: sidebar.section === "folder" ? "Your files" : "Contents"; font.pixelSize: 22; font.weight: Font.DemiBold }
        ModeGroup { Layout.fillWidth: true; choices: [{key:"folder",label:"Folder"},{key:"contents",label:"Contents"}]; selected: sidebar.section; onChosen: key => sidebar.sectionEdited(key) }
        FolderSidebar {
            id: folderTree
            visible: sidebar.section === "folder"
            Layout.fillWidth: true
            Layout.fillHeight: true
            viewState: sidebar.viewState
            tabs: sidebar.tabsState
            activeTabId: sidebar.activeTabId
            sidebarState: sidebar.sidebarState
            shortcutLabels: sidebar.shortcutLabels
        }
        OutlineList { objectName: "sidebarOutlineList"; visible: sidebar.section === "contents"; Layout.fillWidth: true; Layout.fillHeight: true; entries: sidebar.sidebarState.outline || []; noteId: sidebar.sidebarState.active }
        Rectangle { Layout.fillWidth: true; height: 1; color: sidebar.viewState.colors.outline }
        Label { text: "Recent notes"; font.weight: Font.DemiBold; color: sidebar.viewState.colors.text }
        RecentNotes {
            objectName: "sidebarRecentNotes"
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(240, sidebar.sidebarState.recent.length * 40)
            clip: true
            model: sidebar.sidebarState.recent
            pinned: sidebar.sidebarState.pinned
            onOpenRequested: path => studio.openNote(path)
            onPinRequested: path => studio.pinRecent(path)
        }
        Label { visible: !sidebar.sidebarState.folder && !sidebar.sidebarState.recent.length; text: "Open any folder for quick access. Your notes stay ordinary files."; wrapMode: Text.WordWrap; Layout.fillWidth: true; color: sidebar.viewState.colors.muted }
        Rectangle { Layout.fillWidth: true; height: 1; color: sidebar.viewState.colors.outline }
        ActionButton { objectName: "newWindowButton"; text: "New window"; tonal: true; Layout.fillWidth: true; ToolTip.text: sidebar.shortcutHint("New window", "new_window"); onClicked: studio.command("window") }
    }
}
