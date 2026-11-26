import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Native QDrag carries opaque IDs only. Content/asset ownership stays in Session.
ScrollView {
    id: strip
    objectName: "tabStrip"
    required property var viewState
    property var shortcutLabels: ({})
    readonly property string activeTabId: strip.viewState && strip.viewState.active ? String(strip.viewState.active) : ""
    readonly property int tabCount: strip.viewState && strip.viewState.tabs ? strip.viewState.tabs.length : 0
    readonly property int activeTabIndex: {
        const tabs = strip.viewState && strip.viewState.tabs ? strip.viewState.tabs : []
        for (let index = 0; index < tabs.length; index += 1) {
            if (tabs[index].id === strip.activeTabId) return index
        }
        return -1
    }
    property bool draggingTab: false
    property bool rebuildingTabs: false
    property real lastContentWidth: 0
    readonly property real maxTabWidth: Math.min(260, strip.availableWidth > 96 ? Math.max(140, strip.availableWidth - 32) : 260)
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
    function scrollTabIntoView(targetItem, updateRebuildState) {
        if (strip.draggingTab) return
        const flickable = strip.contentItem
        if (!flickable || typeof flickable.contentX !== "number") return
        const viewportWidth = strip.availableWidth > 0 ? strip.availableWidth : strip.width
        if (viewportWidth <= 0 || !targetItem || targetItem.width <= 0) return
        if (updateRebuildState) strip.rebuildingTabs = false
        const margin = 16
        const totalWidth = Math.max(viewportWidth, tabRow.implicitWidth)
        strip.lastContentWidth = totalWidth
        if (flickable.contentWidth + 0.5 < totalWidth) {
            revealTimer.restart()
        }
        const maxScroll = Math.max(0, totalWidth - viewportWidth)
        const leftEdge = Math.max(0, targetItem.x - margin)
        const rightEdge = targetItem.x + targetItem.width + margin
        let nextX = flickable.contentX
        if (leftEdge < nextX) nextX = leftEdge
        else if (rightEdge > nextX + viewportWidth) nextX = rightEdge - viewportWidth
        nextX = Math.max(0, Math.min(maxScroll, nextX))
        if (Math.abs(flickable.contentX - nextX) > 0.5) flickable.contentX = nextX
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
        if (!activeItem || !activeItem.modelData || activeItem.modelData.id !== strip.activeTabId) {
            activeItem = null
            for (let index = 0; index < tabRepeater.count; index += 1) {
                const candidate = tabRepeater.itemAt(index)
                if (candidate && candidate.modelData && candidate.modelData.id === strip.activeTabId) {
                    activeItem = candidate
                    break
                }
            }
        }
        if (!activeItem || activeItem.width <= 0) {
            revealTimer.restart()
            return
        }
        strip.scrollTabIntoView(activeItem, true)
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
    onViewStateChanged: {
        strip.rebuildingTabs = true
        scheduleRevealActiveTab()
    }
    onActiveTabIdChanged: scheduleRevealActiveTab()
    onActiveTabIndexChanged: scheduleRevealActiveTab()
    onTabCountChanged: scheduleRevealActiveTab()
    onWidthChanged: scheduleRevealActiveTab()
    onAvailableWidthChanged: scheduleRevealActiveTab()
    Component.onCompleted: scheduleRevealActiveTab()
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
            model: strip.viewState.tabs
            delegate: Rectangle {
                id: tab
                required property var modelData
                required property int index
                readonly property bool isActive: modelData.id === strip.activeTabId
                readonly property string parentContext: modelData.parentContext ? String(modelData.parentContext) : ""
                readonly property string displayName: parentContext.length > 0 ? modelData.name + " · " + parentContext : modelData.name
                readonly property string accessibleTabName: displayName + (modelData.dirty ? ", unsaved changes" : "")
                width: Math.min(strip.maxTabWidth, label.implicitWidth + 64)
                height: 40
                y: (strip.height - height) / 2
                onXChanged: if (isActive) strip.scheduleRevealActiveTab()
                onWidthChanged: if (isActive) strip.scheduleRevealActiveTab()
                objectName: "noteTab"
                radius: 18
                antialiasing: true
                color: modelData.id === strip.viewState.active ? strip.viewState.colors["surface-high"] : strip.viewState.colors.surface
                Drag.dragType: Drag.Automatic
                Drag.supportedActions: Qt.MoveAction
                Drag.proposedAction: Qt.MoveAction
                Drag.mimeData: ({"application/x-supermd-tab": JSON.stringify({window: studio.windowId, tab: modelData.id})})
                Drag.onDragFinished: function(action) { const id = modelData.id; tab.Drag.active = false; strip.draggingTab = false; Qt.callLater(function() { studio.finishTabDrag(id, action); strip.scheduleRevealActiveTab() }) }
                DragHandler {
                    target: null
                    onActiveChanged: {
                        strip.draggingTab = active
                        if (active) preview.grabToImage(function(result) {
                            if (dragHandler.active) { tab.Drag.imageSource = result.url; tab.Drag.active = true }
                        })
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
                        Label {text:tab.displayName;font.weight:Font.DemiBold;width:parent.width;elide:Text.ElideRight}
                        Label {text:"Release outside tabs to open a window";font.pixelSize:11;color:strip.viewState.colors.muted}
                        Label {text:studio.tabPreview(tab.modelData.id);textFormat:Text.PlainText;width:parent.width;height:105;clip:true;wrapMode:Text.WordWrap;font.pixelSize:12;color:strip.viewState.colors.text}
                    }
                }
                TapHandler { acceptedButtons: Qt.RightButton; onTapped: tabMenu.popup() }
                NoteContextMenu {
                    id: tabMenu
                    objectName: "tabContextMenu"
                    NoteMenuItem { objectName: "renameTabAction"; text: "Rename note"; shortcutText: tab.isActive ? (strip.shortcutLabels.rename_entry || "") : ""; icon.source: "../icons/Rename.svg"; onTriggered: strip.openRename(tab.modelData.id, tab.modelData.name) }
                    NoteMenuItem { text: "Undo"; shortcutText: strip.shortcutLabels.undo || ""; enabled: tab.modelData.id===strip.viewState.active; onTriggered:studio.command("undo") }
                    NoteMenuItem { text: "Redo"; shortcutText: strip.shortcutLabels.redo || ""; enabled: tab.modelData.id===strip.viewState.active; onTriggered:studio.command("redo") }
                    MenuSeparator {}
                    NoteMenuItem { text: "Move to new window"; onTriggered: studio.detachTab(tab.modelData.id) }
                }
                RowLayout {
                    anchors.fill: parent
                    spacing: 0
                    ActionButton {
                        id: label
                        objectName: "noteTabButton"
                        compact: true
                        rightPadding: tab.parentContext.length > 0 ? 8 : 16
                        text: (modelData.dirty ? "• " : "") + tab.displayName
                        Accessible.name: tab.accessibleTabName
                        Layout.fillWidth: true
                        ToolTip.text: modelData.path || modelData.name
                        onActiveFocusChanged: if (activeFocus) Qt.callLater(function() { if (label && label.activeFocus) strip.scrollTabIntoView(tab, false) })
                        onClicked: studio.selectTab(modelData.id)
                        contentItem: Item {
                            readonly property bool hasContext: tab.parentContext.length > 0
                            readonly property real gap: hasContext ? 6 : 0
                            readonly property real avail: Math.max(0, label.availableWidth)
                            readonly property real minTitleWidth: Math.min(titleText.implicitWidth, Math.max(48, Math.floor(avail * 0.52)))
                            readonly property real allocatedContextWidth: !hasContext ? 0 : (
                                titleText.implicitWidth + gap + contextText.implicitWidth <= avail
                                    ? contextText.implicitWidth
                                    : Math.min(contextText.implicitWidth, Math.max(0, avail - gap - minTitleWidth))
                            )
                            readonly property real allocatedTitleWidth: !hasContext
                                ? Math.min(titleText.implicitWidth, avail)
                                : Math.min(titleText.implicitWidth, Math.max(0, avail - gap - allocatedContextWidth))
                            implicitWidth: titleText.implicitWidth + (hasContext ? gap + contextText.implicitWidth : 0)
                            implicitHeight: Math.max(titleText.implicitHeight, hasContext ? contextText.implicitHeight : 0)
                            Text {
                                id: titleText
                                objectName: "noteTabTitle"
                                x: 0
                                width: parent.allocatedTitleWidth
                                height: parent.height
                                text: (tab.modelData.dirty ? "• " : "") + tab.modelData.name
                                font: label.font
                                color: strip.viewState.colors.text
                                elide: Text.ElideRight
                                verticalAlignment: Text.AlignVCenter
                                textFormat: Text.PlainText
                            }
                            Text {
                                id: contextText
                                objectName: "noteTabParentContext"
                                visible: parent.hasContext
                                x: titleText.width + parent.gap
                                width: parent.allocatedContextWidth
                                height: parent.height
                                text: tab.parentContext
                                font.family: label.font.family
                                font.pixelSize: 12
                                font.weight: Font.Normal
                                color: strip.viewState.colors.muted
                                elide: Text.ElideMiddle
                                verticalAlignment: Text.AlignVCenter
                                textFormat: Text.PlainText
                            }
                        }
                    }
                    ActionButton {
                        id: closeTabBtn
                        objectName: "noteTabCloseButton"
                        glyph: "X"
                        compact: true
                        implicitWidth: 36
                        Accessible.name: "Close " + tab.displayName
                        ToolTip.text: tab.isActive ? strip.shortcutHint("Close " + tab.displayName, "close_tab", "") : "Close " + tab.displayName
                        onActiveFocusChanged: if (activeFocus) Qt.callLater(function() { if (closeTabBtn && closeTabBtn.activeFocus) strip.scrollTabIntoView(tab, false) })
                        onClicked: studio.closeTabSafely(modelData.id)
                    }
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
            DropArea { anchors.fill: parent; keys: ["application/x-supermd-tab"]; onDropped: function(drop) { strip.receive(drop, strip.viewState.tabs.length) } }
        }
    }
}
