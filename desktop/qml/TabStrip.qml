import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Native QDrag carries opaque IDs only. Content/asset ownership stays in Session.
ScrollView {
    id: strip
    objectName: "tabStrip"
    required property var viewState
    property var tabs: typeof studio !== "undefined" && studio && studio.tabsSnapshot !== undefined
        ? JSON.parse(studio.tabsSnapshot)
        : (strip.viewState && strip.viewState.tabs ? strip.viewState.tabs : [])
    property string activeTabId: typeof studio !== "undefined" && studio && studio.activeTabId !== undefined
        ? String(studio.activeTabId)
        : (strip.viewState && strip.viewState.active ? String(strip.viewState.active) : "")
    property var shortcutLabels: ({})
    readonly property int tabCount: strip.tabs ? strip.tabs.length : 0
    readonly property int activeTabIndex: {
        const list = strip.tabs || []
        for (let index = 0; index < list.length; index += 1) {
            if (list[index].id === strip.activeTabId) return index
        }
        return -1
    }
    ListModel {
        id: tabModel
    }
    property bool draggingTab: false
    property bool rebuildingTabs: false
    property real lastContentWidth: 0
    height: 48
    contentHeight: 48
    contentWidth: {
        const current = Math.max(availableWidth, tabRow.implicitWidth)
        if ((strip.rebuildingTabs || tabRepeater.count < strip.tabCount) && strip.lastContentWidth > current) {
            return strip.lastContentWidth
        }
        return current
    }
    ScrollBar.vertical.policy: ScrollBar.AlwaysOff
    ScrollBar.horizontal: ExpressiveScrollBar { implicitHeight: 8; padding: 1 }
    Timer {
        id: revealTimer
        interval: 0
        repeat: false
        onTriggered: strip.revealActiveTab()
    }
    function syncTabModel() {
        const list = strip.tabs || []
        const desired = []
        const desiredIds = {}
        for (let index = 0; index < list.length; index += 1) {
            const entry = list[index]
            if (!entry || entry.id === undefined || entry.id === null) continue
            const id = String(entry.id)
            desiredIds[id] = true
            desired.push({
                tabId: id,
                tabName: String(entry.name || ""),
                tabPath: String(entry.path || ""),
                tabDirty: Boolean(entry.dirty),
                tabConflict: Boolean(entry.conflict)
            })
        }
        let structureChanged = false
        for (let index = tabModel.count - 1; index >= 0; index -= 1) {
            if (!desiredIds[tabModel.get(index).tabId]) {
                tabModel.remove(index, 1)
                structureChanged = true
            }
        }
        for (let index = 0; index < desired.length; index += 1) {
            const nextEntry = desired[index]
            let foundIndex = -1
            for (let scan = index; scan < tabModel.count; scan += 1) {
                if (tabModel.get(scan).tabId === nextEntry.tabId) {
                    foundIndex = scan
                    break
                }
            }
            if (foundIndex === -1) {
                tabModel.insert(index, nextEntry)
                structureChanged = true
                continue
            }
            if (foundIndex !== index) {
                tabModel.move(foundIndex, index, 1)
                structureChanged = true
            }
            const currentEntry = tabModel.get(index)
            if (currentEntry.tabName !== nextEntry.tabName) tabModel.setProperty(index, "tabName", nextEntry.tabName)
            if (currentEntry.tabPath !== nextEntry.tabPath) tabModel.setProperty(index, "tabPath", nextEntry.tabPath)
            if (currentEntry.tabDirty !== nextEntry.tabDirty) tabModel.setProperty(index, "tabDirty", nextEntry.tabDirty)
            if (currentEntry.tabConflict !== nextEntry.tabConflict) tabModel.setProperty(index, "tabConflict", nextEntry.tabConflict)
        }
        if (tabModel.count > desired.length) {
            tabModel.remove(desired.length, tabModel.count - desired.length)
            structureChanged = true
        }
        if (structureChanged) strip.rebuildingTabs = true
        scheduleRevealActiveTab()
    }
    function noteStem(name) {
        const raw = name || ""
        const known = raw.replace(/\.(markdown|smd|fmd|md|txt)$/i, "")
        if (known !== raw && known.length > 0) return known
        const custom = raw.replace(/\.[A-Za-z][A-Za-z0-9]{0,15}$/, "")
        return custom.length > 0 ? custom : raw
    }
    function shortcutHint(label, key, fallback) {
        const raw = strip.shortcutLabels && strip.shortcutLabels[key] !== undefined ? strip.shortcutLabels[key] : fallback
        return raw && raw !== "Disabled" ? label + " (" + raw + ")" : label
    }
    function revealActiveTab() {
        if (strip.draggingTab) return
        const flickable = strip.contentItem
        if (!flickable || typeof flickable.contentX !== "number") return
        const viewportWidth = strip.availableWidth > 0 ? strip.availableWidth : strip.width
        if (viewportWidth <= 0 || strip.activeTabIndex < 0) {
            strip.rebuildingTabs = false
            return
        }
        if (tabRepeater.count < strip.tabCount) {
            revealTimer.restart()
            return
        }
        let activeItem = tabRepeater.itemAt(strip.activeTabIndex)
        if (!activeItem || activeItem.tabId !== strip.activeTabId) {
            activeItem = null
            for (let index = 0; index < tabRepeater.count; index += 1) {
                const candidate = tabRepeater.itemAt(index)
                if (candidate && candidate.tabId === strip.activeTabId) {
                    activeItem = candidate
                    break
                }
            }
        }
        if (!activeItem || activeItem.width <= 0) {
            revealTimer.restart()
            return
        }
        strip.rebuildingTabs = false
        const margin = 16
        const totalWidth = Math.max(viewportWidth, tabRow.implicitWidth)
        strip.lastContentWidth = totalWidth
        if (flickable.contentWidth + 0.5 < totalWidth) {
            revealTimer.restart()
        }
        const maxScroll = Math.max(0, totalWidth - viewportWidth)
        const leftEdge = Math.max(0, activeItem.x - margin)
        const rightEdge = activeItem.x + activeItem.width + margin
        let nextX = flickable.contentX
        if (leftEdge < nextX) nextX = leftEdge
        else if (rightEdge > nextX + viewportWidth) nextX = rightEdge - viewportWidth
        nextX = Math.max(0, Math.min(maxScroll, nextX))
        if (Math.abs(flickable.contentX - nextX) > 0.5) flickable.contentX = nextX
    }
    function scheduleRevealActiveTab() {
        if (!strip.rebuildingTabs) strip.revealActiveTab()
        Qt.callLater(strip.revealActiveTab)
        revealTimer.restart()
    }
    Connections {
        target: strip.contentItem
        function onContentWidthChanged() { Qt.callLater(strip.revealActiveTab) }
    }
    onTabsChanged: syncTabModel()
    onActiveTabIdChanged: scheduleRevealActiveTab()
    onActiveTabIndexChanged: scheduleRevealActiveTab()
    onTabCountChanged: scheduleRevealActiveTab()
    onWidthChanged: scheduleRevealActiveTab()
    onAvailableWidthChanged: scheduleRevealActiveTab()
    Component.onCompleted: syncTabModel()
    function openRename(id, name) {
        renameDialog.noteId = id
        renameField.text = name
        renameDialog.open()
    }
    // Keep the prompt outside the Repeater: snapshots recreate tab delegates,
    // and must not destroy an open dialog or its in-progress filename.
    AppDialog {
        id: renameDialog
        objectName: "renameDialog"
        property string noteId: ""
        title: "Rename note"
        width: Math.min(400, parent ? parent.width - 32 : 400)
        standardButtons: Dialog.Ok | Dialog.Cancel
        TextField {
            id: renameField
            objectName: "renameField"
            width: parent.width
            implicitHeight: 52
            font.pixelSize: 16
            leftPadding: 14; rightPadding: 14; topPadding: 10; bottomPadding: 10
            selectByMouse: true
            Accessible.name: "Note name"
            color: renameDialog.colors.text
            selectionColor: renameDialog.colors.primary
            selectedTextColor: renameDialog.colors["on-primary"]
            background: Rectangle {
                color: renameDialog.colors.surface
                radius: 12
                antialiasing: true
                border.width: renameField.activeFocus ? 2 : 1
                border.color: renameField.activeFocus ? renameDialog.colors.primary : renameDialog.colors.outline
            }
            onAccepted: { if (text.trim().length) renameDialog.accept() }
        }
        onOpened: {
            renameField.forceActiveFocus()
            const stem = strip.noteStem(renameField.text)
            if (stem.length > 0 && stem.length < renameField.text.length) renameField.select(0, stem.length)
            else renameField.selectAll()
        }
        onAccepted: studio.renameNote(noteId, renameField.text)
    }
    function receive(drop, index) {
        try {
            const payload = JSON.parse(drop.getDataAsString("application/x-supermd-tab"))
            if (!studio.canReceiveTab(payload.window, payload.tab)) return
            drop.acceptProposedAction()
            // Do not destroy a Repeater delegate inside QDrag's nested event loop.
            Qt.callLater(function() { studio.receiveTab(payload.window, payload.tab, index) })
        } catch (error) { /* Foreign or stale drag: leave every note untouched. */ }
    }
    Row {
        id: tabRow
        height: strip.height
        spacing: 4
        leftPadding: 16
        rightPadding: 16
        onImplicitWidthChanged: strip.scheduleRevealActiveTab()
        Repeater {
            id: tabRepeater
            model: tabModel
            delegate: Rectangle {
                id: tab
                required property int index
                required property string tabId
                required property string tabName
                required property string tabPath
                required property bool tabDirty
                required property bool tabConflict
                readonly property bool isActive: tabId === strip.activeTabId
                width: Math.min(tab.tabConflict ? 284 : 260, label.implicitWidth + (tab.tabConflict ? 88 : 64))
                height: 40
                y: (strip.height - height) / 2
                onXChanged: if (isActive) strip.scheduleRevealActiveTab()
                onWidthChanged: if (isActive) strip.scheduleRevealActiveTab()
                onTabConflictChanged: strip.scheduleRevealActiveTab()
                objectName: "noteTab"
                radius: 18
                antialiasing: true
                color: tab.isActive ? strip.viewState.colors["surface-high"] : strip.viewState.colors.surface
                border.width: tab.tabConflict ? 1 : 0
                border.color: strip.viewState.colors.primary
                Drag.dragType: Drag.Automatic
                Drag.supportedActions: Qt.MoveAction
                Drag.proposedAction: Qt.MoveAction
                Drag.mimeData: ({"application/x-supermd-tab": JSON.stringify({window: typeof studio !== "undefined" && studio ? studio.windowId : "", tab: tab.tabId})})
                Drag.onDragFinished: function(action) { const id = tab.tabId; tab.Drag.active = false; strip.draggingTab = false; Qt.callLater(function() { studio.finishTabDrag(id, action); strip.scheduleRevealActiveTab() }) }
                DragHandler {
                    target: null
                    onActiveChanged: {
                        strip.draggingTab = active
                        if (active) {
                            if (typeof studio !== "undefined" && studio) previewBody.text = studio.tabPreview(tab.tabId)
                            preview.grabToImage(function(result) {
                                if (dragHandler.active) { tab.Drag.imageSource = result.url; tab.Drag.active = true }
                            })
                        }
                    }
                    id: dragHandler
                }
                Rectangle {
                    id:preview
                    objectName:"tabDragPreview"
                    // A native drag image can leave the window; an in-window
                    // tooltip cannot. Render offscreen without moving/focusing chrome.
                    x:-1000;y:-1000;width:320;height:190;radius:18;antialiasing:true
                    color:strip.viewState.colors.surface;border.width:1;border.color:strip.viewState.colors.primary
                    Column {
                        anchors.fill:parent;anchors.margins:16;spacing:10
                        Label {text:tab.tabName;font.weight:Font.DemiBold;width:parent.width;elide:Text.ElideRight}
                        Label {text:"Release outside tabs to open a window";font.pixelSize:11;color:strip.viewState.colors.muted}
                        Label {id:previewBody;text:typeof studio !== "undefined" && studio && tab.tabId ? studio.tabPreview(tab.tabId) : "";textFormat:Text.PlainText;width:parent.width;height:105;clip:true;wrapMode:Text.WordWrap;font.pixelSize:12;color:strip.viewState.colors.text}
                    }
                }
                TapHandler { acceptedButtons: Qt.RightButton; onTapped: tabMenu.popup() }
                NoteContextMenu {
                    id: tabMenu
                    objectName: "tabContextMenu"
                    NoteMenuItem { objectName: "renameTabAction"; text: "Rename note"; shortcutText: tab.isActive ? (strip.shortcutLabels.rename_entry || "") : ""; icon.source: "../icons/Rename.svg"; onTriggered: strip.openRename(tab.tabId, tab.tabName) }
                    NoteMenuItem { objectName: "undoTabAction"; text: "Undo"; shortcutText: strip.shortcutLabels.undo || ""; enabled: tab.isActive; onTriggered:studio.command("undo") }
                    NoteMenuItem { objectName: "redoTabAction"; text: "Redo"; shortcutText: strip.shortcutLabels.redo || ""; enabled: tab.isActive; onTriggered:studio.command("redo") }
                    MenuSeparator {}
                    NoteMenuItem { objectName: "detachTabAction"; text: "Move to new window"; onTriggered: { const id = tab.tabId; Qt.callLater(function() { studio.detachTab(id) }) } }
                }
                RowLayout {
                    anchors.fill: parent
                    spacing: 0
                    ActionButton { id: label; objectName: "noteTabLabel"; compact: true; text: (tab.tabDirty ? "• " : "") + tab.tabName; Layout.fillWidth: true; ToolTip.text: (tab.tabConflict ? "Changed on disk · " : "") + (tab.tabPath || tab.tabName); onClicked: studio.selectTab(tab.tabId) }
                    ToolButton {
                        objectName: "tabConflictIndicator"
                        visible: tab.tabConflict
                        focusPolicy: Qt.NoFocus
                        padding: 0
                        implicitWidth: 24
                        implicitHeight: 36
                        Layout.preferredWidth: 24
                        Layout.preferredHeight: 36
                        Layout.alignment: Qt.AlignVCenter
                        background: null
                        icon.source: "../icons/Warning.svg"
                        icon.width: 16
                        icon.height: 16
                        icon.color: strip.viewState.colors.primary
                        Accessible.name: tab.tabName + " changed on disk"
                        onClicked: studio.selectTab(tab.tabId)
                        Hint { objectName: "conflictTabHint"; colors: strip.viewState.colors; requested: parent.hovered; text: "Changed on disk · select tab to resolve" }
                    }
                    ActionButton { objectName: "noteTabCloseButton"; glyph: "X"; compact: true; implicitWidth: 36; Accessible.name: "Close " + tab.tabName; ToolTip.text: tab.isActive ? strip.shortcutHint("Close " + tab.tabName, "close_tab", "") : "Close " + tab.tabName; onClicked: { const id = tab.tabId; Qt.callLater(function() { studio.closeTabSafely(id) }) } }
                }
                DropArea {
                    id: dropZone
                    anchors.fill: parent
                    keys: ["application/x-supermd-tab"]
                    property bool after: false
                    onPositionChanged: function(drag) { after = drag.x > width / 2 }
                    onEntered: function(drag) { after = drag.x > width / 2 }
                    onDropped: function(drop) { strip.receive(drop, tab.index + (drop.x > width / 2 ? 1 : 0)) }
                }
                Rectangle { visible: dropZone.containsDrag; x: dropZone.after ? parent.width - 2 : 0; width: 3; height: 32; anchors.verticalCenter: parent.verticalCenter; radius: 1.5; color: strip.viewState.colors.primary }
            }
        }
        ActionButton {
            objectName: "newTabButton"
            glyph: "Plus"; compact: true; implicitWidth: 40; implicitHeight: 40
            y: (strip.height - height) / 2
            Accessible.name: "New tab"
            ToolTip.text: strip.shortcutHint("New tab", "new_note", "Ctrl+T")
            onClicked: studio.newNote()
            DropArea { anchors.fill: parent; keys: ["application/x-supermd-tab"]; onDropped: function(drop) { strip.receive(drop, strip.tabCount) } }
        }
    }
}
