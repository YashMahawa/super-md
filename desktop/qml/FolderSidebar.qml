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
        return (name || "").replace(/\.(markdown|smd|fmd|md|txt)$/i, "")
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

    function openMoveFor(pathValue, nameValue, isDir) {
        if (!viewState.folder || !pathValue) return
        moveEntryDialog.sourcePath = pathValue
        moveEntryDialog.sourceName = nameValue
        moveEntryDialog.sourceIsDirectory = isDir
        moveEntryDialog.expandedPaths = [viewState.folder]
        moveEntryDialog.selectedTargetDir = viewState.folder
        moveEntryDialog.folders = []
        studio.loadMoveTargets(pathValue, JSON.stringify(moveEntryDialog.expandedPaths))
        moveEntryDialog.open()
    }

    function openTrashFor(pathValue, nameValue, isDir) {
        if (!viewState.folder || !pathValue) return
        confirmTrashDialog.targetPath = pathValue
        confirmTrashDialog.targetName = nameValue
        confirmTrashDialog.targetIsDirectory = isDir
        confirmTrashDialog.open()
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

    function triggerRenameSelectedOrActive() {
        if (viewState.folder && selectedPath && (viewState.files || []).some(item => item.path === selectedPath)) {
            openRenameFor(selectedPath, selectedName, selectedDirectory)
            return
        }
        const activeTab = (viewState.tabs || []).find(t => t.id === viewState.active)
        if (activeTab && activeTab.path && viewState.folder && (activeTab.path.startsWith(viewState.folder + "/") || activeTab.path.startsWith(viewState.folder + "\\"))) {
            openRenameFor(activeTab.path, activeTab.name, false)
            return
        }
        if (activeTab) {
            tabFallbackRenameDialog.noteId = activeTab.id
            tabFallbackRenameField.text = activeTab.name
            tabFallbackRenameDialog.open()
        }
    }

    function triggerTrashSelectedOrActive() {
        if (!viewState.folder) { studio.notifyMessage("Open a folder first."); return }
        if (selectedPath && (viewState.files || []).some(item => item.path === selectedPath)) {
            openTrashFor(selectedPath, selectedName, selectedDirectory)
            return
        }
        const activeTab = (viewState.tabs || []).find(t => t.id === viewState.active)
        if (activeTab && activeTab.path && (activeTab.path.startsWith(viewState.folder + "/") || activeTab.path.startsWith(viewState.folder + "\\"))) {
            openTrashFor(activeTab.path, activeTab.name, false)
            return
        }
        studio.notifyMessage("Select a note or folder to move to Trash.")
    }

    function receiveDrop(drop, targetDir) {
        try {
            const payload = JSON.parse(drop.getDataAsString("application/x-supermd-folder-entry"))
            if (!payload || !payload.path || payload.path === targetDir) return
            drop.acceptProposedAction()
            const sourcePath = payload.path
            Qt.callLater(function() { studio.requestMoveEntry(sourcePath, targetDir) })
        } catch (error) { /* Ignore foreign drag payloads. */ }
    }

    Connections {
        target: studio
        function onMoveTargetsLoaded(payload) {
            try { moveEntryDialog.folders = JSON.parse(payload) }
            catch (error) { moveEntryDialog.folders = [] }
        }
        function onMoveImagesPromptRequested(sourcePath, targetDir, count, canCopy) {
            moveImagesDialog.sourcePath = sourcePath
            moveImagesDialog.targetDir = targetDir
            moveImagesDialog.imageCount = count
            moveImagesDialog.canCopyImages = canCopy
            moveImagesDialog.open()
        }
    }

    ActionButton {
        objectName: "openFolderSidebarButton"
        text: "Open folder"; glyph: "FolderOpen"; tonal: true; Layout.fillWidth: true
        onClicked: studio.chooseFolder()
    }

    Rectangle {
        id: folderHeaderBar
        objectName: "folderHeaderBar"
        visible: !!viewState.folder
        Layout.fillWidth: true; implicitHeight: 40; radius: 12
        color: rootDropZone.containsDrag ? viewState.colors["primary-container"] : "transparent"
        border.width: rootDropZone.containsDrag ? 2 : 0; border.color: viewState.colors.primary

        DropArea {
            id: rootDropZone
            objectName: "folderRootDropZone"
            anchors.fill: parent
            keys: ["application/x-supermd-folder-entry"]
            onDropped: function(drop) { root.receiveDrop(drop, viewState.folder) }
        }

        RowLayout {
            anchors.fill: parent; anchors.leftMargin: 6; anchors.rightMargin: 2; spacing: 4
            Label {
                text: root.folderDisplayName(viewState.folder)
                font.weight: Font.DemiBold; Layout.fillWidth: true; elide: Text.ElideMiddle; color: viewState.colors.text
            }
            ActionButton {
                objectName: "headerNewItemButton"
                glyph: "Plus"; compact: true
                Accessible.name: "New note or subfolder"
                ToolTip.text: "New note in folder (" + (root.shortcutLabels.new_folder_note || "Ctrl+Alt+N") + ")"
                onClicked: headerCreateMenu.popup()
                NoteContextMenu {
                    id: headerCreateMenu
                    objectName: "headerCreateMenu"
                    implicitWidth: 230
                    NoteMenuItem { objectName: "headerNewMarkdownItem"; text: "New Markdown note (.md)"; icon.source: "../icons/File.svg"; onTriggered: root.openCreateDialog("md", viewState.folder) }
                    NoteMenuItem { objectName: "headerNewPortableItem"; text: "New portable note (.smd)"; icon.source: "../icons/File.svg"; onTriggered: root.openCreateDialog("smd", viewState.folder) }
                    MenuSeparator {}
                    NoteMenuItem { objectName: "headerNewSubfolderItem"; text: "New subfolder"; icon.source: "../icons/FolderOpen.svg"; onTriggered: root.openCreateDialog("folder", viewState.folder) }
                }
            }
            ActionButton {
                objectName: "headerNewSubfolderButton"
                glyph: "FolderOpen"; compact: true
                Accessible.name: "New subfolder"
                ToolTip.text: "New subfolder (" + (root.shortcutLabels.new_subfolder || "Ctrl+Alt+Shift+N") + ")"
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
    }

    TextField {
        id: filter
        objectName: "folderFilterField"
        visible: !!viewState.folder
        Layout.fillWidth: true; placeholderText: "Filter files"; selectByMouse: true
    }

    NoteContextMenu {
        id: folderEntryMenu
        objectName: "folderEntryContextMenu"
        implicitWidth: 236
        property string targetPath: ""
        property string targetName: ""
        property bool targetIsDirectory: false

        NoteMenuItem { objectName: "menuOpenNote"; text: "Open note"; icon.source: "../icons/File.svg"; actionVisible: !folderEntryMenu.targetIsDirectory; onTriggered: studio.openNote(folderEntryMenu.targetPath) }
        NoteMenuItem { objectName: "menuNewMarkdown"; text: "New Markdown note (.md)"; icon.source: "../icons/Plus.svg"; actionVisible: folderEntryMenu.targetIsDirectory; onTriggered: root.openCreateDialog("md", folderEntryMenu.targetPath) }
        NoteMenuItem { objectName: "menuNewPortable"; text: "New portable note (.smd)"; icon.source: "../icons/File.svg"; actionVisible: folderEntryMenu.targetIsDirectory; onTriggered: root.openCreateDialog("smd", folderEntryMenu.targetPath) }
        NoteMenuItem { objectName: "menuNewSubfolder"; text: "New subfolder"; icon.source: "../icons/FolderOpen.svg"; actionVisible: folderEntryMenu.targetIsDirectory; onTriggered: root.openCreateDialog("folder", folderEntryMenu.targetPath) }
        MenuSeparator {}
        NoteMenuItem { objectName: "menuRenameEntry"; text: folderEntryMenu.targetIsDirectory ? "Rename folder" : "Rename note"; icon.source: "../icons/Rename.svg"; onTriggered: root.openRenameFor(folderEntryMenu.targetPath, folderEntryMenu.targetName, folderEntryMenu.targetIsDirectory) }
        NoteMenuItem { objectName: "menuMoveEntry"; text: "Move to folder…"; icon.source: "../icons/FolderOpen.svg"; onTriggered: root.openMoveFor(folderEntryMenu.targetPath, folderEntryMenu.targetName, folderEntryMenu.targetIsDirectory) }
        MenuSeparator {}
        NoteMenuItem { objectName: "menuTrashEntry"; text: "Move to Trash"; icon.source: "../icons/X.svg"; onTriggered: root.openTrashFor(folderEntryMenu.targetPath, folderEntryMenu.targetName, folderEntryMenu.targetIsDirectory) }
    }

    ListView {
        id: treeList
        objectName: "folderTreeList"
        Layout.fillWidth: true; Layout.fillHeight: true; clip: true
        model: viewState.files
        delegate: ItemDelegate {
            id: fileEntry
            objectName: "fileEntry"
            required property var modelData
            readonly property bool isSelected: root.selectedPath === modelData.path
            width: ListView.view.width - 14
            height: visible ? 40 : 0
            visible: !filter.text || modelData.directory || modelData.name.toLowerCase().includes(filter.text.toLowerCase())
            hoverEnabled: true
            leftPadding: 10 + modelData.depth * 16; rightPadding: 34
            text: (modelData.directory ? (modelData.expanded ? "▾ " : "▸ ") : "") + modelData.name
            Accessible.name: modelData.name + (modelData.directory ? ", folder" : ", note")

            Drag.dragType: Drag.Automatic; Drag.supportedActions: Qt.MoveAction; Drag.proposedAction: Qt.MoveAction
            Drag.mimeData: ({"application/x-supermd-folder-entry": JSON.stringify({path: modelData.path, directory: modelData.directory, name: modelData.name})})
            Drag.onDragFinished: function() { fileEntry.Drag.active = false }

            DragHandler {
                id: entryDragHandler
                target: null
                onActiveChanged: if (active) dragBadge.grabToImage(function(result) {
                    if (entryDragHandler.active) { fileEntry.Drag.imageSource = result.url; fileEntry.Drag.active = true }
                })
            }

            Rectangle {
                id: dragBadge
                x: -1000; y: -1000; width: 220; height: 40; radius: 12; antialiasing: true
                color: viewState.colors.surface; border.width: 1; border.color: viewState.colors.primary
                Label {
                    anchors.fill: parent; anchors.margins: 10
                    text: fileEntry.modelData.name; font.weight: Font.DemiBold
                    elide: Text.ElideRight; verticalAlignment: Text.AlignVCenter; color: viewState.colors.text
                }
            }

            contentItem: Text {
                text: fileEntry.text; font: fileEntry.font; color: viewState.colors.text
                elide: Text.ElideRight; verticalAlignment: Text.AlignVCenter
            }

            background: Rectangle {
                radius: 12; antialiasing: true
                color: entryDropArea.containsDrag
                    ? viewState.colors["primary-container"]
                    : (fileEntry.hovered || fileEntry.down || fileEntry.visualFocus || fileEntry.isSelected ? viewState.colors["surface-high"] : "transparent")
                border.width: entryDropArea.containsDrag ? 2 : (fileEntry.visualFocus || fileEntry.isSelected ? 1 : 0)
                border.color: viewState.colors.primary
            }

            onClicked: {
                root.selectedPath = modelData.path
                root.selectedName = modelData.name
                root.selectedDirectory = modelData.directory
                if (modelData.directory) studio.toggleDirectory(modelData.path)
                else studio.openNote(modelData.path)
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

            DropArea {
                id: entryDropArea
                objectName: "folderEntryDropArea"
                anchors.fill: parent; enabled: fileEntry.modelData.directory
                keys: ["application/x-supermd-folder-entry"]
                onDropped: function(drop) { root.receiveDrop(drop, fileEntry.modelData.path) }
            }

            Hint { requested: fileEntry.hovered; text: modelData.path }
        }
        ScrollBar.vertical: ExpressiveScrollBar { }
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

    AppDialog {
        id: moveEntryDialog
        objectName: "moveEntryDialog"
        property string sourcePath: ""
        property string sourceName: ""
        property bool sourceIsDirectory: false
        property string selectedTargetDir: ""
        property var expandedPaths: []
        property var folders: []
        title: "Move \"" + sourceName + "\""
        width: Math.min(460, parent ? parent.width - 32 : 460)
        standardButtons: Dialog.Ok | Dialog.Cancel

        function toggleMoveFolder(dirPath) {
            const idx = expandedPaths.indexOf(dirPath)
            const next = expandedPaths.slice()
            if (idx >= 0) next.splice(idx, 1)
            else next.push(dirPath)
            expandedPaths = next
            studio.loadMoveTargets(sourcePath, JSON.stringify(expandedPaths))
        }

        ColumnLayout {
            width: parent.width; spacing: 10
            Label {
                text: "Choose a destination folder inside the open folder:"
                color: moveEntryDialog.colors.muted; Layout.fillWidth: true; wrapMode: Text.WordWrap
            }
            ListView {
                id: moveFolderList
                objectName: "moveFolderList"
                Layout.fillWidth: true; Layout.preferredHeight: 240; clip: true
                model: moveEntryDialog.folders
                delegate: ItemDelegate {
                    id: moveRow
                    objectName: "moveTargetRow"
                    required property var modelData
                    readonly property bool chosen: moveEntryDialog.selectedTargetDir === modelData.path
                    width: ListView.view.width - 12; height: 38; hoverEnabled: true
                    leftPadding: 10 + modelData.depth * 16
                    background: Rectangle {
                        radius: 10
                        color: moveRow.chosen ? moveEntryDialog.colors["primary-container"] : (moveRow.hovered ? moveEntryDialog.colors["surface-high"] : "transparent")
                        border.width: moveRow.chosen ? 1 : 0; border.color: moveEntryDialog.colors.primary
                    }
                    contentItem: RowLayout {
                        spacing: 6
                        ActionButton {
                            visible: !moveRow.modelData.isRoot && moveRow.modelData.hasChildren
                            compact: true; text: moveRow.modelData.expanded ? "▾" : "▸"
                            implicitWidth: 24; implicitHeight: 24
                            topPadding: 0; bottomPadding: 0; leftPadding: 0; rightPadding: 0; background: null
                            onClicked: moveEntryDialog.toggleMoveFolder(moveRow.modelData.path)
                        }
                        Label {
                            text: moveRow.modelData.isRoot ? (moveRow.modelData.name + " (root)") : moveRow.modelData.name
                            Layout.fillWidth: true; elide: Text.ElideMiddle
                            font.weight: moveRow.chosen ? Font.DemiBold : Font.Normal
                            color: moveRow.chosen ? moveEntryDialog.colors["on-primary-container"] : moveEntryDialog.colors.text
                        }
                    }
                    onClicked: moveEntryDialog.selectedTargetDir = modelData.path
                }
                ScrollBar.vertical: ExpressiveScrollBar { }
            }
        }
        onAccepted: if (selectedTargetDir) studio.requestMoveEntry(sourcePath, selectedTargetDir)
    }

    AppDialog {
        id: moveImagesDialog
        objectName: "moveImagesDialog"
        property string sourcePath: ""
        property string targetDir: ""
        property int imageCount: 0
        property bool canCopyImages: true
        title: "Linked local images detected"
        width: Math.min(480, parent ? parent.width - 32 : 480)
        ColumnLayout {
            width: parent.width; spacing: 18
            Label {
                Layout.fillWidth: true; wrapMode: Text.WordWrap
                text: "This Markdown note links to " + moveImagesDialog.imageCount + " local image" + (moveImagesDialog.imageCount === 1 ? "" : "s") + " relative to its current folder. Moving only the note may break relative image links."
            }
            Flow {
                Layout.fillWidth: true; spacing: 8
                ActionButton { objectName: "moveImagesCancelButton"; text: "Cancel"; onClicked: moveImagesDialog.close() }
                ActionButton {
                    objectName: "moveImagesMoveOnlyButton"
                    text: "Move note only"; tonal: true
                    onClicked: { const s = moveImagesDialog.sourcePath; const d = moveImagesDialog.targetDir; moveImagesDialog.close(); studio.moveEntry(s, d, "move_only") }
                }
                ActionButton {
                    objectName: "moveImagesCopyButton"
                    visible: moveImagesDialog.canCopyImages; text: "Copy images & move"; prominent: true
                    onClicked: { const s = moveImagesDialog.sourcePath; const d = moveImagesDialog.targetDir; moveImagesDialog.close(); studio.moveEntry(s, d, "copy") }
                }
            }
        }
    }

    AppDialog {
        id: confirmTrashDialog
        objectName: "confirmTrashDialog"
        property string targetPath: ""
        property string targetName: ""
        property bool targetIsDirectory: false
        title: "Move \"" + targetName + "\" to Trash?"
        width: Math.min(460, parent ? parent.width - 32 : 460)
        ColumnLayout {
            width: parent.width; spacing: 18
            Label {
                Layout.fillWidth: true; wrapMode: Text.WordWrap
                text: confirmTrashDialog.targetIsDirectory
                    ? "This folder and its contents will be moved to your system Trash. Any unsaved edits in open notes inside this folder will be preserved in closed-note recovery."
                    : "This note will be moved to your system Trash. Any unsaved edits in an open tab will be preserved in closed-note recovery."
            }
            RowLayout {
                Layout.fillWidth: true; spacing: 8
                Item { Layout.fillWidth: true }
                ActionButton { objectName: "cancelTrashButton"; text: "Cancel"; onClicked: confirmTrashDialog.close() }
                ActionButton {
                    objectName: "confirmTrashButton"
                    text: "Move to Trash"; prominent: true
                    onClicked: {
                        const path = confirmTrashDialog.targetPath
                        confirmTrashDialog.close()
                        if (root.selectedPath === path) root.selectedPath = ""
                        studio.trashEntry(path)
                    }
                }
            }
        }
    }
}
