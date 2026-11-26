import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

AppDialog {
    id: dialog
    objectName: "quickSwitcherDialog"
    title: "Quick switcher"
    property var stateData: studio.quickSwitcherState
    property int selectedIndex: 0
    property Item previousFocusItem: null
    property bool activatedItem: false
    width: Math.min(parent ? parent.width - 32 : 600, 600)
    height: Math.min(parent ? parent.height - 48 : 540, 540)

    function isInsideItem(candidate, container) {
        if (!candidate || !container) return false
        let cur = candidate
        while (cur) {
            if (cur === container) return true
            cur = cur.parent
        }
        return false
    }

    function isInsideDialog(candidate) {
        return isInsideItem(candidate, dialog)
            || isInsideItem(candidate, dialog.contentItem)
            || isInsideItem(candidate, dialog.background)
    }

    function canRestoreItem(candidate) {
        if (!candidate || isInsideDialog(candidate)) return false
        let cur = candidate
        while (cur) {
            if (cur.visible !== undefined && !cur.visible) return false
            if (cur.enabled !== undefined && !cur.enabled) return false
            cur = cur.parent
        }
        return true
    }

    function capturePreviousFocus() {
        activatedItem = false
        if (!hostWindow) return
        const current = hostWindow.activeFocusItem
        if (current && !isInsideDialog(current)) {
            previousFocusItem = current
        }
    }

    function openWithFocusCapture() {
        capturePreviousFocus()
        dialog.open()
    }

    function restoreTargetFocus(wasActivated, savedTarget) {
        const readerView = hostWindow ? hostWindow.reader : null
        if (wasActivated) {
            if (hostWindow && typeof hostWindow.focusReader === "function") {
                hostWindow.focusReader()
            }
        } else if (readerView && isInsideItem(savedTarget, readerView) && canRestoreItem(readerView)) {
            if (typeof hostWindow.focusReader === "function") {
                hostWindow.focusReader()
            } else {
                readerView.forceActiveFocus(Qt.PopupFocusReason)
            }
        } else if (canRestoreItem(savedTarget) && typeof savedTarget.forceActiveFocus === "function") {
            savedTarget.forceActiveFocus(Qt.PopupFocusReason)
        } else if (hostWindow && typeof hostWindow.focusReader === "function" && readerView && readerView.visible) {
            hostWindow.focusReader()
        } else if (hostWindow && hostWindow.contentItem) {
            hostWindow.contentItem.forceActiveFocus(Qt.PopupFocusReason)
        }
    }

    function clampSelection() {
        const items = stateData && stateData.items ? stateData.items : []
        if (!items.length) {
            selectedIndex = 0
        } else if (selectedIndex >= items.length) {
            selectedIndex = items.length - 1
        } else if (selectedIndex < 0) {
            selectedIndex = 0
        }
    }

    function moveSelection(delta, wrap) {
        const items = stateData && stateData.items ? stateData.items : []
        if (!items.length) return
        if (wrap) {
            selectedIndex = (selectedIndex + delta + items.length) % items.length
        } else {
            selectedIndex = Math.max(0, Math.min(items.length - 1, selectedIndex + delta))
        }
        resultsList.positionViewAtIndex(selectedIndex, ListView.Contain)
    }

    function activateIndex(idx) {
        const items = stateData && stateData.items ? stateData.items : []
        if (idx < 0 || idx >= items.length) return
        const entry = items[idx]
        activatedItem = true
        dialog.close()
        studio.activateQuickSwitcherItem(entry.tabId || "", entry.path || "")
    }

    onStateDataChanged: clampSelection()

    ColumnLayout {
        anchors.fill: parent
        spacing: 12
        Keys.forwardTo: [queryField]

        TextField {
            id: queryField
            objectName: "quickSwitcherInput"
            Layout.fillWidth: true
            placeholderText: "Switch to a .md or .smd note by filename or folder…"
            selectByMouse: true
            color: dialog.colors.text
            onTextChanged: {
                if (dialog.visible && text !== (dialog.stateData.query || "")) {
                    dialog.selectedIndex = 0
                    studio.setQuickSwitcherQuery(text)
                }
            }
            Keys.onDownPressed: event => {
                event.accepted = true
                dialog.moveSelection(1, true)
            }
            Keys.onUpPressed: event => {
                event.accepted = true
                dialog.moveSelection(-1, true)
            }
            Keys.onPressed: event => {
                if (event.key === Qt.Key_PageDown) {
                    event.accepted = true
                    dialog.moveSelection(6, false)
                } else if (event.key === Qt.Key_PageUp) {
                    event.accepted = true
                    dialog.moveSelection(-6, false)
                }
            }
            Keys.onReturnPressed: event => {
                event.accepted = true
                dialog.activateIndex(dialog.selectedIndex)
            }
            Keys.onEnterPressed: event => {
                event.accepted = true
                dialog.activateIndex(dialog.selectedIndex)
            }
            Keys.onEscapePressed: event => {
                event.accepted = true
                dialog.close()
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            ExpressiveLoading {
                visible: !!dialog.stateData.loading
                running: visible
                implicitWidth: 18
                implicitHeight: 18
            }
            Label {
                objectName: "quickSwitcherStatus"
                Layout.fillWidth: true
                elide: Text.ElideRight
                font.pixelSize: 12
                color: dialog.colors.muted
                text: {
                    const count = (dialog.stateData.items || []).length
                    const hasQuery = (dialog.stateData.query || "").trim().length > 0
                    if (dialog.stateData.loading) {
                        return "Indexing workspace notes…"
                    }
                    if (hasQuery) {
                        return count + (count === 1 ? " matching note" : " matching notes") + " · ↑↓ select · Enter open · Esc dismiss"
                    }
                    return "Pinned, open, and recent notes first · Type filename or folder path"
                }
            }
        }

        ListView {
            id: resultsList
            objectName: "quickSwitcherList"
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: 4
            model: dialog.stateData.items || []
            delegate: ItemDelegate {
                id: rowItem
                required property var modelData
                required property int index
                objectName: "quickSwitcherRow_" + index
                width: ListView.view ? ListView.view.width - 8 : 520
                implicitHeight: (modelData.parentPath || "").length > 0 ? 56 : 46
                padding: 10
                highlighted: index === dialog.selectedIndex
                onClicked: dialog.activateIndex(index)
                background: Rectangle {
                    radius: 14
                    color: rowItem.highlighted
                        ? dialog.colors["surface-high"]
                        : rowItem.hovered ? dialog.colors.surface : "transparent"
                    border.width: rowItem.highlighted ? 1 : 0
                    border.color: dialog.colors.primary
                }
                contentItem: RowLayout {
                    spacing: 10
                    ActionButton {
                        Layout.preferredWidth: 20
                        Layout.preferredHeight: 20
                        implicitWidth: 20
                        implicitHeight: 20
                        topPadding: 0; bottomPadding: 0; leftPadding: 0; rightPadding: 0
                        glyph: modelData.pinned ? "PushPin" : "File"
                        icon.width: 18
                        icon.height: 18
                        icon.color: modelData.pinned ? dialog.colors.primary : dialog.colors.muted
                        background: null
                        enabled: false
                        focusPolicy: Qt.NoFocus
                        Accessible.ignored: true
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 2
                        Label {
                            objectName: "quickSwitcherRowName_" + index
                            Layout.fillWidth: true
                            text: modelData.name || "Untitled.md"
                            textFormat: Text.PlainText
                            elide: Text.ElideRight
                            font.pixelSize: 14
                            font.weight: Font.Medium
                            color: dialog.colors.text
                        }
                        Label {
                            objectName: "quickSwitcherRowParent_" + index
                            visible: !!(modelData.parentPath && modelData.parentPath.length > 0)
                            Layout.fillWidth: true
                            text: modelData.parentPath || ""
                            textFormat: Text.PlainText
                            elide: Text.ElideMiddle
                            font.pixelSize: 12
                            color: dialog.colors.muted
                        }
                    }
                    Rectangle {
                        visible: !!modelData.dirty || !!modelData.pinned || !!modelData.open
                        radius: 10
                        color: dialog.colors.surface
                        border.width: 1
                        border.color: modelData.dirty ? dialog.colors.primary : dialog.colors.outline
                        implicitHeight: 22
                        implicitWidth: badgeText.implicitWidth + 14
                        Label {
                            id: badgeText
                            objectName: "quickSwitcherRowBadge_" + index
                            anchors.centerIn: parent
                            font.pixelSize: 11
                            color: modelData.dirty ? dialog.colors.primary : dialog.colors.muted
                            text: modelData.dirty ? "Unsaved" : (modelData.pinned ? "Pinned" : "Open")
                        }
                    }
                }
            }
            Label {
                objectName: "quickSwitcherEmptyLabel"
                visible: !dialog.stateData.loading && (dialog.stateData.items || []).length === 0
                anchors.centerIn: parent
                width: parent.width - 32
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.WordWrap
                color: dialog.colors.muted
                text: (dialog.stateData.query || "").trim().length > 0
                    ? "No matching .md or .smd notes found."
                    : "No open, recent, or workspace .md/.smd notes yet."
            }
            ScrollBar.vertical: ExpressiveScrollBar { }
        }
    }

    onAboutToShow: {
        if (!previousFocusItem) {
            capturePreviousFocus()
        } else {
            activatedItem = false
        }
        queryField.text = stateData.query || ""
        selectedIndex = 0
        Qt.callLater(function() {
            if (!dialog.visible) return
            queryField.forceActiveFocus()
            if (queryField.text.length > 0 && queryField.text === (dialog.stateData.query || "")) {
                queryField.selectAll()
            }
        })
    }

    onOpened: {
        if (!queryField.activeFocus) {
            queryField.forceActiveFocus()
        }
    }

    onClosed: {
        const wasActivated = activatedItem
        const savedTarget = previousFocusItem
        previousFocusItem = null
        activatedItem = false
        studio.closeQuickSwitcher()
        restoreTargetFocus(wasActivated, savedTarget)
        Qt.callLater(function() {
            if (dialog.visible || !hostWindow) return
            const currentFocus = hostWindow.activeFocusItem
            if (!currentFocus || dialog.isInsideDialog(currentFocus)) {
                dialog.restoreTargetFocus(wasActivated, savedTarget)
            }
        })
    }
}
