import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: root
    objectName: "folderSidebar"
    required property var viewState
    property var shortcutLabels: ({})
    property string selectedPath: ""
    property string selectedName: ""
    property bool selectedDirectory: false
    spacing: 12

    function noteStem(name) {
        const raw = name || ""
        const known = raw.replace(/\.(markdown|smd|fmd|md|txt)$/i, "")
        if (known !== raw && known.length > 0) return known
        const custom = raw.replace(/\.[A-Za-z][A-Za-z0-9]{0,15}$/, "")
        return custom.length > 0 ? custom : raw
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
        if (!viewState.folder) return ""
        if (selectedPath && (viewState.files || []).some(item => item.path === selectedPath))
            return selectedDirectory ? selectedPath : parentPathOf(selectedPath)
        return viewState.folder
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
        if (!viewState.folder) { studio.notifyMessage("Open a folder first."); return }
        createFolderItemDialog.itemKind = kind
        createFolderItemDialog.parentDir = parentDir || viewState.folder
        createFolderItemField.text = ""
        createFolderItemDialog.open()
    }

    function openRenameFor(pathValue, nameValue, isDir) {
        if (!viewState.folder || !pathValue) return
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
        if (!candidatePath || !viewState.folder) return false
        const normFolder = viewState.folder.replace(/\\/g, "/").replace(/\/+$/, "")
        const normCand = candidatePath.replace(/\\/g, "/")
        if (Qt.platform.os === "windows")
            return normCand.toLowerCase().startsWith((normFolder + "/").toLowerCase())
        return normCand.startsWith(normFolder + "/")
    }

    function triggerRenameSelectedOrActive() {
        if (viewState.folder && selectedPath && (viewState.files || []).some(item => item.path === selectedPath)) {
            openRenameFor(selectedPath, selectedName, selectedDirectory)
            return
        }
        const activeTab = (viewState.tabs || []).find(t => t.id === viewState.active)
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

    RowLayout {
        id: folderHeaderBar
        objectName: "folderHeaderBar"
        visible: !!viewState.folder
        Layout.fillWidth: true
        spacing: 4
        Label {
            text: root.folderDisplayName(viewState.folder)
            font.weight: Font.DemiBold; Layout.fillWidth: true; elide: Text.ElideMiddle; color: viewState.colors.text
        }
        ActionButton {
            objectName: "headerNewItemButton"
            glyph: "Plus"; compact: true
            Accessible.name: "New note or subfolder"
            ToolTip.text: root.shortcutHint("New note in folder", "new_folder_note", "Ctrl+Alt+N")
            onClicked: headerCreateMenu.popup()
            NoteContextMenu {
                id: headerCreateMenu
                objectName: "headerCreateMenu"
                implicitWidth: 310
                NoteMenuItem { objectName: "headerNewMarkdownItem"; text: "New Markdown note (.md)"; shortcutText: root.shortcutLabels.new_folder_note || ""; icon.source: "../icons/File.svg"; onTriggered: root.openCreateDialog("md", viewState.folder) }
                NoteMenuItem { objectName: "headerNewPortableItem"; text: "New portable note (.smd)"; icon.source: "../icons/File.svg"; onTriggered: root.openCreateDialog("smd", viewState.folder) }
                MenuSeparator {}
                NoteMenuItem { objectName: "headerNewSubfolderItem"; text: "New subfolder"; shortcutText: root.shortcutLabels.new_subfolder || ""; icon.source: "../icons/FolderOpen.svg"; onTriggered: root.openCreateDialog("folder", viewState.folder) }
            }
        }
        ActionButton {
            objectName: "headerNewSubfolderButton"
            glyph: "FolderOpen"; compact: true
            Accessible.name: "New subfolder"
            ToolTip.text: root.shortcutHint("New subfolder", "new_subfolder", "Ctrl+Alt+Shift+N")
            onClicked: root.openCreateDialog("folder", viewState.folder)
        }
        ActionButton {
            objectName: "closeFolderButton"
            glyph: "X"; compact: true
            Accessible.name: "Close folder"
            ToolTip.text: "Close folder (notes stay open)"
            onClicked: { root.selectedPath = ""; studio.closeFolder() }
        }
    }

    TextField {
        id: filter
        objectName: "folderFilterField"
        property string backendFilter: viewState.folderFilter || ""
        visible: !!viewState.folder
        Layout.fillWidth: true
        placeholderText: "Filter files"
        selectByMouse: true
        onTextChanged: {
            if (text !== backendFilter)
                studio.setFolderFilter(text)
        }
        onBackendFilterChanged: {
            if (backendFilter === "" && text !== "")
                text = ""
            else if (!activeFocus && text !== backendFilter)
                text = backendFilter
        }
    }

    NoteContextMenu {
        id: folderEntryMenu
        objectName: "folderEntryContextMenu"
        implicitWidth: 260
        property string targetPath: ""
        property string targetName: ""
        property bool targetIsDirectory: false

        NoteMenuItem { objectName: "menuOpenNote"; text: "Open note"; icon.source: "../icons/File.svg"; actionVisible: !folderEntryMenu.targetIsDirectory; onTriggered: studio.openNote(folderEntryMenu.targetPath) }
        NoteMenuItem { objectName: "menuNewMarkdown"; text: "New Markdown note (.md)"; icon.source: "../icons/Plus.svg"; actionVisible: folderEntryMenu.targetIsDirectory; onTriggered: root.openCreateDialog("md", folderEntryMenu.targetPath) }
        NoteMenuItem { objectName: "menuNewPortable"; text: "New portable note (.smd)"; icon.source: "../icons/File.svg"; actionVisible: folderEntryMenu.targetIsDirectory; onTriggered: root.openCreateDialog("smd", folderEntryMenu.targetPath) }
        NoteMenuItem { objectName: "menuNewSubfolder"; text: "New subfolder"; icon.source: "../icons/FolderOpen.svg"; actionVisible: folderEntryMenu.targetIsDirectory; onTriggered: root.openCreateDialog("folder", folderEntryMenu.targetPath) }
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
            visible: viewState.files.length > 0
            clip: true
            model: viewState.files
            delegate: ItemDelegate {
                id: fileEntry
                objectName: "fileEntry"
                required property var modelData
                readonly property bool isSelected: root.selectedPath === modelData.path
                width: ListView.view.width - 14
                height: 40
                hoverEnabled: true
                leftPadding: 10 + modelData.depth * 16; rightPadding: 34
                text: (modelData.directory ? (modelData.expanded ? "▾ " : "▸ ") : "") + modelData.name
                Accessible.name: modelData.name + (modelData.directory ? ", folder" : ", note")

                contentItem: Text {
                    text: fileEntry.text; font: fileEntry.font; color: viewState.colors.text
                    elide: Text.ElideRight; verticalAlignment: Text.AlignVCenter
                }

                background: Rectangle {
                    radius: 12; antialiasing: true
                    color: fileEntry.hovered || fileEntry.down || fileEntry.visualFocus || fileEntry.isSelected ? viewState.colors["surface-high"] : "transparent"
                    border.width: fileEntry.visualFocus || fileEntry.isSelected ? 1 : 0
                    border.color: viewState.colors.primary
                }

                onClicked: {
                    root.selectedPath = modelData.path
                    root.selectedName = modelData.name
                    root.selectedDirectory = modelData.directory
                    if (modelData.directory) {
                        if (!((viewState.folderFilter || "").trim()))
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
                    width: 28; height: 28; compact: true
                    topPadding: 0; bottomPadding: 0; leftPadding: 0; rightPadding: 0
                    glyph: "More"; icon.width: 16; icon.height: 16
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
            visible: !!viewState.folder && viewState.files.length === 0 && !viewState.folderSearching
            Label {
                objectName: "folderEmptyLabel"
                Layout.fillWidth: true
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.WordWrap
                font.weight: Font.Medium
                color: viewState.colors.text
                text: (viewState.folderFilter || "").trim().length > 0 ? "No matching notes found" : "No notes in this folder"
            }
            Label {
                visible: (viewState.folderFilter || "").trim().length > 0
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
