import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: root
    objectName: "folderSidebar"
    required property var viewState
    property var sidebarState: typeof studio !== "undefined" && studio && studio.sidebarSnapshot !== undefined ? JSON.parse(studio.sidebarSnapshot) : viewState
    property var shortcutLabels: ({})
    readonly property string currentFolder: sidebarState.folder || ""
    property string selectedPath: ""
    property string selectedName: ""
    property bool selectedDirectory: false
    readonly property string activeTabPath: {
        const tabs = root.viewState && root.viewState.tabs ? root.viewState.tabs : []
        const activeId = root.sidebarState && root.sidebarState.active !== undefined
            ? root.sidebarState.active
            : (root.viewState ? root.viewState.active : "")
        for (let i = 0; i < tabs.length; i += 1) {
            if (tabs[i].id === activeId) return tabs[i].path || ""
        }
        return ""
    }
    spacing: 8

    function resetSelection() {
        selectedPath = ""
        selectedName = ""
        selectedDirectory = false
    }

    onCurrentFolderChanged: resetSelection()

    onSidebarStateChanged: {
        if (selectedPath && !sidebarState.folderSearching && !(sidebarState.files || []).some(item => root.samePathKey(item.path, selectedPath))) {
            resetSelection()
        }
    }

    function noteStem(name) {
        const raw = name || ""
        const known = raw.replace(/\.(markdown|smd|fmd|md|txt)$/i, "")
        if (known !== raw && known.length > 0) return known
        const custom = raw.replace(/\.[A-Za-z][A-Za-z0-9]{0,15}$/, "")
        return custom.length > 0 ? custom : raw
    }

    function samePathKey(a, b) {
        if (!a || !b) return false
        const left = String(a).replace(/\\/g, "/").replace(/\/+$/, "")
        const right = String(b).replace(/\\/g, "/").replace(/\/+$/, "")
        if (Qt.platform.os === "windows") return left.toLowerCase() === right.toLowerCase()
        return left === right
    }

    function shortcutHint(label, key, fallback) {
        const raw = root.shortcutLabels && root.shortcutLabels[key] !== undefined ? root.shortcutLabels[key] : fallback
        return raw && raw !== "Disabled" ? label + " (" + raw + ")" : label
    }

    function parentPathOf(fullPath) {
        if (!fullPath) return ""
        const idx = fullPath.replace(/\\/g, "/").lastIndexOf("/")
        if (idx <= 0) return fullPath
        const sep = fullPath.includes("\\") ? "\\" : "/"
        return fullPath.slice(0, idx).replace(/\//g, sep)
    }

    function targetCreationFolder() {
        if (!sidebarState.folder) return ""
        const selectedEntry = selectedPath ? (sidebarState.files || []).find(item => item.path === selectedPath) : null
        if (selectedEntry)
            return selectedEntry.directory ? selectedEntry.path : parentPathOf(selectedEntry.path)
        return sidebarState.folder
    }

    function folderDisplayName(pathValue) {
        if (!pathValue) return ""
        const parts = pathValue.split(/[\\/]/).filter(Boolean)
        return parts.length ? parts[parts.length - 1] : pathValue
    }

    function selectStemInField(field, isDir) {
        field.forceActiveFocus()
        const stem = !isDir ? root.noteStem(field.text) : ""
        if (stem.length > 0 && stem.length < field.text.length) field.select(0, stem.length)
        else field.selectAll()
    }

    function openCreateDialog(kind, parentDir) {
        if (!sidebarState.folder) { studio.notifyMessage("Open a folder first."); return }
        createFolderItemDialog.itemKind = kind
        createFolderItemDialog.parentDir = parentDir || sidebarState.folder
        createFolderItemField.text = ""
        createFolderItemDialog.open()
    }

    function openRenameFor(pathValue, nameValue, isDir) {
        if (!sidebarState.folder || !pathValue) return
        renameEntryDialog.entryPath = pathValue
        renameEntryDialog.entryIsDirectory = isDir
        renameEntryField.text = nameValue
        renameEntryDialog.open()
    }

    function openContextMenuFor(item, pathValue, nameValue, isDir, xPos, yPos) {
        root.selectedPath = pathValue
        root.selectedName = nameValue
        root.selectedDirectory = isDir
        folderEntryMenu.targetPath = pathValue
        folderEntryMenu.targetName = nameValue
        folderEntryMenu.targetIsDirectory = isDir
        if (item && xPos !== undefined && yPos !== undefined) {
            const pt = item.mapToItem(root, xPos, yPos)
            folderEntryMenu.popup(pt.x, pt.y)
        } else folderEntryMenu.popup()
    }

    function triggerNewFolderNote() { openCreateDialog("md", targetCreationFolder()) }
    function triggerNewSubfolder() { openCreateDialog("folder", targetCreationFolder()) }

    function isInsideOpenFolder(candidatePath) {
        if (!candidatePath || !sidebarState.folder) return false
        const normFolder = sidebarState.folder.replace(/\\/g, "/").replace(/\/+$/, "")
        const normCand = candidatePath.replace(/\\/g, "/")
        if (Qt.platform.os === "windows")
            return normCand.toLowerCase().startsWith((normFolder + "/").toLowerCase())
        return normCand.startsWith(normFolder + "/")
    }

    function triggerRenameSelectedOrActive() {
        const selectedEntry = sidebarState.folder && selectedPath ? (sidebarState.files || []).find(item => item.path === selectedPath) : null
        if (selectedEntry) {
            openRenameFor(selectedEntry.path, selectedEntry.name, Boolean(selectedEntry.directory))
            return
        }
        const activeId = sidebarState.active || viewState.active
        const activeTab = (viewState.tabs || []).find(t => t.id === activeId)
        if (activeTab && activeTab.path && root.isInsideOpenFolder(activeTab.path)) {
            openRenameFor(activeTab.path, activeTab.name, false)
            return
        }
        if (activeTab) {
            tabFallbackRenameDialog.noteId = activeTab.id
            tabFallbackRenameField.text = activeTab.name
            tabFallbackRenameDialog.open()
        }
    }

    ActionButton {
        objectName: "openFolderSidebarButton"
        visible: !sidebarState.folder
        text: "Open folder"; glyph: "FolderOpen"; tonal: true; Layout.fillWidth: true
        onClicked: studio.chooseFolder()
    }

    ActionButton {
        objectName: "sidebarFolderSearchButton"
        text: "Search across notes"
        glyph: "MagnifyingGlass"
        compact: true
        tonal: true
        Layout.fillWidth: true
        ToolTip.text: root.shortcutHint("Search across notes", "search_folder", "Ctrl+Shift+F")
        onClicked: studio.openFolderSearch()
    }

    Rectangle {
        id: folderHeaderBar
        objectName: "folderHeaderBar"
        visible: !!sidebarState.folder
        Layout.fillWidth: true
        implicitHeight: 42
        radius: 12
        antialiasing: true
        color: viewState.colors["surface-high"]
        border.width: 1
        border.color: viewState.colors.outline

        RowLayout {
            anchors.fill: parent
            anchors.leftMargin: 10
            anchors.rightMargin: 4
            spacing: 4

            ToolButton {
                enabled: false
                focusPolicy: Qt.NoFocus
                padding: 0
                background: null
                icon.source: "../icons/FolderOpen.svg"
                icon.color: viewState.colors.primary
                icon.width: 18
                icon.height: 18
                Layout.preferredWidth: 20
                Layout.preferredHeight: 20
            }

            Label {
                objectName: "folderHeaderTitle"
                text: root.folderDisplayName(sidebarState.folder)
                font.pixelSize: 14
                font.weight: Font.DemiBold
                Layout.fillWidth: true
                elide: Text.ElideRight
                color: viewState.colors.text
                Hint { requested: parent.truncated; text: sidebarState.folder }
            }

            ActionButton {
                objectName: "headerNewItemButton"
                glyph: "Plus"; compact: true
                implicitWidth: 30; implicitHeight: 30
                Layout.preferredWidth: 30; Layout.preferredHeight: 30
                leftPadding: 6; rightPadding: 6; topPadding: 6; bottomPadding: 6
                icon.width: 18; icon.height: 18
                Accessible.name: "New note or subfolder"
                ToolTip.text: root.shortcutHint("New note in folder", "new_folder_note", "Ctrl+Alt+N")
                onClicked: headerCreateMenu.popup()
                NoteContextMenu {
                    id: headerCreateMenu
                    objectName: "headerCreateMenu"
                    implicitWidth: 310
                    NoteMenuItem { objectName: "headerNewMarkdownItem"; text: "New Markdown note (.md)"; shortcutText: root.shortcutLabels.new_folder_note || ""; icon.source: "../icons/File.svg"; onTriggered: root.openCreateDialog("md", sidebarState.folder) }
                    NoteMenuItem { objectName: "headerNewPortableItem"; text: "New portable note (.smd)"; icon.source: "../icons/File.svg"; onTriggered: root.openCreateDialog("smd", sidebarState.folder) }
                    NoteMenuItem { objectName: "headerNewSubfolderItem"; text: "New subfolder"; shortcutText: root.shortcutLabels.new_subfolder || ""; icon.source: "../icons/FolderOpen.svg"; onTriggered: root.openCreateDialog("folder", sidebarState.folder) }
                    MenuSeparator {}
                    NoteMenuItem { objectName: "headerSwitchFolderItem"; text: "Switch folder…"; icon.source: "../icons/FolderOpen.svg"; onTriggered: studio.chooseFolder() }
                }
            }

            ActionButton {
                objectName: "closeFolderButton"
                glyph: "X"; compact: true
                implicitWidth: 30; implicitHeight: 30
                Layout.preferredWidth: 30; Layout.preferredHeight: 30
                leftPadding: 6; rightPadding: 6; topPadding: 6; bottomPadding: 6
                icon.width: 18; icon.height: 18
                Accessible.name: "Close folder"
                ToolTip.text: "Close folder (notes stay open)"
                onClicked: { root.resetSelection(); studio.closeFolder() }
            }
        }
    }

    NoteContextMenu {
        id: folderEntryMenu
        objectName: "folderEntryContextMenu"
        implicitWidth: 310
        property string targetPath: ""
        property string targetName: ""
        property bool targetIsDirectory: false

        NoteMenuItem { objectName: "menuOpenNote"; text: "Open note"; icon.source: "../icons/File.svg"; actionVisible: !folderEntryMenu.targetIsDirectory; onTriggered: studio.openNote(folderEntryMenu.targetPath) }
        NoteMenuItem { objectName: "menuNewMarkdown"; text: "New Markdown note (.md)"; shortcutText: root.shortcutLabels.new_folder_note || ""; icon.source: "../icons/Plus.svg"; actionVisible: folderEntryMenu.targetIsDirectory; onTriggered: root.openCreateDialog("md", folderEntryMenu.targetPath) }
        NoteMenuItem { objectName: "menuNewPortable"; text: "New portable note (.smd)"; icon.source: "../icons/File.svg"; actionVisible: folderEntryMenu.targetIsDirectory; onTriggered: root.openCreateDialog("smd", folderEntryMenu.targetPath) }
        NoteMenuItem { objectName: "menuNewSubfolder"; text: "New subfolder"; shortcutText: root.shortcutLabels.new_subfolder || ""; icon.source: "../icons/FolderOpen.svg"; actionVisible: folderEntryMenu.targetIsDirectory; onTriggered: root.openCreateDialog("folder", folderEntryMenu.targetPath) }
        MenuSeparator {}
        NoteMenuItem { objectName: "menuRenameEntry"; text: folderEntryMenu.targetIsDirectory ? "Rename folder" : "Rename note"; shortcutText: root.shortcutLabels.rename_entry || ""; icon.source: "../icons/Rename.svg"; onTriggered: root.openRenameFor(folderEntryMenu.targetPath, folderEntryMenu.targetName, folderEntryMenu.targetIsDirectory) }
    }

    Item {
        Layout.fillWidth: true
        Layout.fillHeight: true

        ListView {
            id: folderFilesView
            objectName: "folderFilesView"
            anchors.fill: parent
            visible: (sidebarState.files || []).length > 0
            clip: true
            spacing: 2
            model: sidebarState.files || []
            delegate: ItemDelegate {
                id: fileEntry
                objectName: "fileEntry"
                required property var modelData
                readonly property bool isSelected: root.selectedPath === modelData.path
                readonly property bool isActiveNote: !modelData.directory && root.samePathKey(modelData.path, root.activeTabPath)
                width: ListView.view.width - 10
                height: 36
                hoverEnabled: true
                leftPadding: 8 + modelData.depth * 14
                rightPadding: 32
                text: (modelData.directory ? (modelData.expanded ? "▾ " : "▸ ") : "") + modelData.name
                Accessible.name: modelData.name + (modelData.directory ? ", folder" : ", note")

                contentItem: RowLayout {
                    spacing: 6

                    ToolButton {
                        visible: fileEntry.modelData.directory
                        enabled: false
                        focusPolicy: Qt.NoFocus
                        padding: 0
                        background: null
                        icon.source: "../icons/CaretDown.svg"
                        icon.color: viewState.colors.muted
                        icon.width: 14
                        icon.height: 14
                        rotation: fileEntry.modelData.expanded ? 0 : -90
                        Behavior on rotation { enabled: studio.motionEnabled; NumberAnimation { duration: 150; easing.type: Easing.OutCubic } }
                        Layout.preferredWidth: 14
                        Layout.preferredHeight: 14
                    }

                    ToolButton {
                        enabled: false
                        focusPolicy: Qt.NoFocus
                        padding: 0
                        background: null
                        icon.source: fileEntry.modelData.directory ? "../icons/FolderOpen.svg" : "../icons/File.svg"
                        icon.color: fileEntry.isActiveNote
                            ? (viewState.colors["on-primary-container"] || viewState.colors.primary)
                            : (fileEntry.modelData.directory ? viewState.colors.primary : viewState.colors.muted)
                        icon.width: 17
                        icon.height: 17
                        Layout.preferredWidth: 18
                        Layout.preferredHeight: 18
                    }

                    Label {
                        Layout.fillWidth: true
                        text: fileEntry.modelData.name
                        font.family: "Noto Sans"
                        font.pixelSize: 13
                        font.weight: fileEntry.modelData.directory || fileEntry.isActiveNote ? Font.DemiBold : Font.Normal
                        color: fileEntry.isActiveNote
                            ? (viewState.colors["on-primary-container"] || viewState.colors.text)
                            : viewState.colors.text
                        elide: Text.ElideRight
                        verticalAlignment: Text.AlignVCenter
                    }
                }

                background: Rectangle {
                    radius: 10
                    antialiasing: true
                    color: fileEntry.isActiveNote
                        ? (viewState.colors["primary-container"] || viewState.colors["surface-high"])
                        : (fileEntry.hovered || fileEntry.down || fileEntry.visualFocus || fileEntry.isSelected
                            ? viewState.colors["surface-high"]
                            : "transparent")
                    border.width: fileEntry.visualFocus || fileEntry.isSelected ? 1 : 0
                    border.color: viewState.colors.primary
                }

                onClicked: {
                    root.selectedPath = modelData.path
                    root.selectedName = modelData.name
                    root.selectedDirectory = modelData.directory
                    if (modelData.directory) {
                        if (!((sidebarState.folderFilter || "").trim()))
                            studio.toggleDirectory(modelData.path)
                    } else {
                        studio.openNote(modelData.path)
                    }
                }

                TapHandler {
                    acceptedButtons: Qt.RightButton
                    onTapped: function(eventPoint) { root.openContextMenuFor(fileEntry, modelData.path, modelData.name, modelData.directory, eventPoint.position.x, eventPoint.position.y) }
                }
                Keys.onMenuPressed: root.openContextMenuFor(fileEntry, modelData.path, modelData.name, modelData.directory, fileEntry.width - 24, fileEntry.height)

                ActionButton {
                    objectName: "folderEntryMoreButton"
                    visible: fileEntry.hovered || fileEntry.visualFocus || fileEntry.isSelected
                    anchors.right: parent.right; anchors.rightMargin: 4; anchors.verticalCenter: parent.verticalCenter
                    width: 26; height: 26; compact: true
                    topPadding: 0; bottomPadding: 0; leftPadding: 0; rightPadding: 0
                    glyph: "More"; icon.width: 15; icon.height: 15
                    Accessible.name: "Actions for " + modelData.name; ToolTip.text: "Actions"
                    onClicked: root.openContextMenuFor(fileEntry, modelData.path, modelData.name, modelData.directory, width, height)
                }

                Hint { requested: fileEntry.hovered; text: modelData.path }
            }
            ScrollBar.vertical: ExpressiveScrollBar { }
        }

        ColumnLayout {
            objectName: "folderEmptyState"
            anchors.centerIn: parent
            width: parent.width - 16
            spacing: 4
            visible: !!sidebarState.folder && (sidebarState.files || []).length === 0 && !sidebarState.folderSearching
            Label {
                objectName: "folderEmptyLabel"
                Layout.fillWidth: true
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.WordWrap
                font.weight: Font.Medium
                color: viewState.colors.text
                text: (sidebarState.folderFilter || "").trim().length > 0 ? "No matching notes found" : "No notes in this folder"
            }
            Label {
                visible: (sidebarState.folderFilter || "").trim().length > 0
                Layout.fillWidth: true
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.WordWrap
                font.pixelSize: 12
                color: viewState.colors.muted
                text: "Try another filename or clear the filter."
            }
        }
    }

    AppDialog {
        id: createFolderItemDialog
        objectName: "createFolderItemDialog"
        property string itemKind: "md"
        property string parentDir: ""
        title: itemKind === "folder" ? "New subfolder" : "New note in folder"
        width: Math.min(420, parent ? parent.width - 32 : 420)
        standardButtons: Dialog.Ok | Dialog.Cancel
        ColumnLayout {
            width: parent.width; spacing: 12
            Label {
                text: "In folder: " + root.folderDisplayName(createFolderItemDialog.parentDir)
                color: createFolderItemDialog.colors.muted; Layout.fillWidth: true; elide: Text.ElideMiddle
            }
            ModeGroup {
                visible: createFolderItemDialog.itemKind !== "folder"
                Layout.fillWidth: true
                choices: [{key: "md", label: "Markdown (.md)"}, {key: "smd", label: "Portable (.smd)"}]
                selected: createFolderItemDialog.itemKind === "smd" ? "smd" : "md"
                onChosen: key => createFolderItemDialog.itemKind = key
            }
            TextField {
                id: createFolderItemField
                objectName: "createFolderItemField"
                Layout.fillWidth: true; implicitHeight: 50; font.pixelSize: 16
                leftPadding: 14; rightPadding: 14; topPadding: 10; bottomPadding: 10; selectByMouse: true
                placeholderText: createFolderItemDialog.itemKind === "folder" ? "Folder name" : (createFolderItemDialog.itemKind === "smd" ? "Note title (.smd)" : "Note title (.md)")
                Accessible.name: createFolderItemDialog.itemKind === "folder" ? "Folder name" : "Note name"
                color: createFolderItemDialog.colors.text; selectionColor: createFolderItemDialog.colors.primary; selectedTextColor: createFolderItemDialog.colors["on-primary"]
                background: Rectangle {
                    color: createFolderItemDialog.colors.surface; radius: 12; antialiasing: true
                    border.width: createFolderItemField.activeFocus ? 2 : 1
                    border.color: createFolderItemField.activeFocus ? createFolderItemDialog.colors.primary : createFolderItemDialog.colors.outline
                }
                onAccepted: { if (text.trim().length) createFolderItemDialog.accept() }
            }
        }
        onOpened: createFolderItemField.forceActiveFocus()
        onAccepted: {
            if (itemKind === "folder") studio.createSubfolder(parentDir, createFolderItemField.text)
            else studio.createFolderNote(parentDir, createFolderItemField.text, itemKind)
        }
    }

    AppDialog {
        id: renameEntryDialog
        objectName: "renameEntryDialog"
        property string entryPath: ""
        property bool entryIsDirectory: false
        title: entryIsDirectory ? "Rename folder" : "Rename note"
        width: Math.min(420, parent ? parent.width - 32 : 420)
        standardButtons: Dialog.Ok | Dialog.Cancel
        TextField {
            id: renameEntryField
            objectName: "renameEntryField"
            width: parent.width; implicitHeight: 52; font.pixelSize: 16
            leftPadding: 14; rightPadding: 14; topPadding: 10; bottomPadding: 10; selectByMouse: true
            Accessible.name: renameEntryDialog.entryIsDirectory ? "Folder name" : "Note name"
            color: renameEntryDialog.colors.text; selectionColor: renameEntryDialog.colors.primary; selectedTextColor: renameEntryDialog.colors["on-primary"]
            background: Rectangle {
                color: renameEntryDialog.colors.surface; radius: 12; antialiasing: true
                border.width: renameEntryField.activeFocus ? 2 : 1
                border.color: renameEntryField.activeFocus ? renameEntryDialog.colors.primary : renameEntryDialog.colors.outline
            }
            onAccepted: { if (text.trim().length) renameEntryDialog.accept() }
        }
        onOpened: root.selectStemInField(renameEntryField, entryIsDirectory)
        onAccepted: studio.renameEntry(entryPath, renameEntryField.text)
    }

    AppDialog {
        id: tabFallbackRenameDialog
        objectName: "tabFallbackRenameDialog"
        property string noteId: ""
        title: "Rename note"
        width: Math.min(400, parent ? parent.width - 32 : 400)
        standardButtons: Dialog.Ok | Dialog.Cancel
        TextField {
            id: tabFallbackRenameField
            width: parent.width; implicitHeight: 52; font.pixelSize: 16
            leftPadding: 14; rightPadding: 14; topPadding: 10; bottomPadding: 10; selectByMouse: true
            color: tabFallbackRenameDialog.colors.text; selectionColor: tabFallbackRenameDialog.colors.primary; selectedTextColor: tabFallbackRenameDialog.colors["on-primary"]
            background: Rectangle {
                color: tabFallbackRenameDialog.colors.surface; radius: 12; antialiasing: true
                border.width: tabFallbackRenameField.activeFocus ? 2 : 1
                border.color: tabFallbackRenameField.activeFocus ? tabFallbackRenameDialog.colors.primary : tabFallbackRenameDialog.colors.outline
            }
            onAccepted: { if (text.trim().length) tabFallbackRenameDialog.accept() }
        }
        onOpened: root.selectStemInField(tabFallbackRenameField, false)
        onAccepted: studio.renameNote(noteId, tabFallbackRenameField.text)
    }
}
