import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

AppDialog {
    id: dialog
    objectName: "folderSearchDialog"
    title: "Search across notes"
    property var stateData: studio.folderSearchState
    property string uiMode: "text"
    readonly property bool isFilesMode: uiMode === "files"
    property int selectedIndex: 0
    property int debounceInterval: 120
    property bool syncingControls: false
    readonly property bool queryPending: searchDebounce.running
        || !!(stateData && stateData.pending)
        || searchField.text !== ((stateData && stateData.query) || "")
        || matchCaseButton.checked !== !!(stateData && stateData.caseSensitive)
        || includeDiagramsButton.checked !== !!(stateData && stateData.includeDiagrams)
        || uiMode !== ((stateData && stateData.mode === "files") ? "files" : "text")
    width: Math.min(parent ? parent.width - 32 : 700, 720)
    height: Math.min(parent ? parent.height - 48 : 580, 620)

    Timer {
        id: searchDebounce
        objectName: "folderSearchDebounce"
        interval: dialog.debounceInterval
        repeat: false
        onTriggered: {
            if (!dialog.visible || !(dialog.stateData && dialog.stateData.open)) return
            dialog.triggerSearch()
        }
    }

    function escapeHtml(value) {
        return String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
    }

    function highlightedSnippet(snippet, start, end) {
        const raw = String(snippet || "")
        const s = Math.max(0, Math.min(raw.length, Number(start || 0)))
        const e = Math.max(s, Math.min(raw.length, Number(end || 0)))
        if (e <= s) return escapeHtml(raw)
        return escapeHtml(raw.slice(0, s))
            + "<font color=\"" + dialog.colors.primary + "\"><b>"
            + escapeHtml(raw.slice(s, e))
            + "</b></font>"
            + escapeHtml(raw.slice(e))
    }

    function clampSelection() {
        const matches = stateData && stateData.matches ? stateData.matches : []
        if (!matches.length) {
            selectedIndex = 0
        } else if (selectedIndex >= matches.length) {
            selectedIndex = matches.length - 1
        } else if (selectedIndex < 0) {
            selectedIndex = 0
        }
    }

    function triggerSearch() {
        searchDebounce.stop()
        selectedIndex = 0
        studio.updateFolderSearch(
            searchField.text,
            matchCaseButton.checked,
            includeDiagramsButton.checked,
            dialog.uiMode
        )
    }

    function scheduleSearch() {
        selectedIndex = 0
        if (!searchField.text.trim().length) {
            triggerSearch()
            return
        }
        searchDebounce.restart()
        studio.prepareFolderSearch(
            searchField.text,
            matchCaseButton.checked,
            includeDiagramsButton.checked,
            dialog.uiMode
        )
    }

    function activateMatch(idx) {
        if (dialog.queryPending) return
        const q = stateData && typeof stateData.query === "string" ? stateData.query : ""
        if (!q.trim().length) return
        const matches = stateData && stateData.matches ? stateData.matches : []
        if (idx < 0 || idx >= matches.length) return
        const hit = matches[idx]
        const fileHit = dialog.isFilesMode || hit.kind === "file" || (typeof hit.line === "number" && hit.line <= 0)
        const findQuery = fileHit ? "" : q
        const cs = !fileHit && !!stateData.caseSensitive
        const sourceStart = !fileHit && typeof hit.sourceStart === "number" ? hit.sourceStart : -1
        const sourceEnd = !fileHit && typeof hit.sourceEnd === "number" ? hit.sourceEnd : -1
        const matchText = !fileHit && typeof hit.matchText === "string" ? hit.matchText : ""
        dialog.close()
        studio.openFolderSearchMatch(hit.tabId || "", hit.path || "", findQuery, cs, sourceStart, sourceEnd, matchText)
    }

    onStateDataChanged: {
        if (!syncingControls && !(stateData && stateData.pending)) {
            const backendMode = (stateData && stateData.mode === "files") ? "files" : "text"
            const backendQuery = (stateData && stateData.query) || ""
            const backendCs = !!(stateData && stateData.caseSensitive)
            const backendDiag = !!(stateData && stateData.includeDiagrams)
            if (uiMode !== backendMode || searchField.text !== backendQuery || matchCaseButton.checked !== backendCs || includeDiagramsButton.checked !== backendDiag) {
                syncingControls = true
                searchDebounce.stop()
                uiMode = backendMode
                if (searchField.text !== backendQuery) searchField.text = backendQuery
                matchCaseButton.checked = backendCs
                includeDiagramsButton.checked = backendDiag
                syncingControls = false
            }
        }
        clampSelection()
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 12

        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            ModeGroup {
                id: searchModeGroup
                objectName: "folderSearchModeGroup"
                implicitHeight: 38
                selected: dialog.uiMode
                choices: [
                    { key: "text", label: "Text", objectName: "folderSearchTextModeButton", tooltip: "Search note contents" },
                    { key: "files", label: "Files", objectName: "folderSearchFilesModeButton", tooltip: "Search file names only" }
                ]
                onChosen: key => {
                    if (key !== dialog.uiMode) {
                        dialog.uiMode = key
                        if (!dialog.syncingControls && dialog.visible) dialog.triggerSearch()
                    }
                    searchField.forceActiveFocus()
                }
            }

            TextField {
                id: searchField
                objectName: "folderSearchInput"
                Layout.fillWidth: true
                placeholderText: dialog.isFilesMode
                    ? (dialog.stateData.hasFolder ? "Search file names across notes…" : "Search open and recent file names…")
                    : (dialog.stateData.hasFolder
                        ? "Search text across .md, .smd, open tabs, and recent notes…"
                        : "Search text across open tabs and recent notes…")
                selectByMouse: true
                color: dialog.colors.text
                onTextChanged: {
                    if (!dialog.syncingControls && dialog.visible) {
                        dialog.scheduleSearch()
                    }
                }
                Keys.onDownPressed: event => {
                    event.accepted = true
                    if (dialog.queryPending) return
                    const matches = dialog.stateData.matches || []
                    if (matches.length > 0) {
                        dialog.selectedIndex = (dialog.selectedIndex + 1) % matches.length
                        matchList.positionViewAtIndex(dialog.selectedIndex, ListView.Contain)
                    }
                }
                Keys.onUpPressed: event => {
                    event.accepted = true
                    if (dialog.queryPending) return
                    const matches = dialog.stateData.matches || []
                    if (matches.length > 0) {
                        dialog.selectedIndex = (dialog.selectedIndex - 1 + matches.length) % matches.length
                        matchList.positionViewAtIndex(dialog.selectedIndex, ListView.Contain)
                    }
                }
                Keys.onReturnPressed: event => {
                    event.accepted = true
                    dialog.activateMatch(dialog.selectedIndex)
                }
                Keys.onEnterPressed: event => {
                    event.accepted = true
                    dialog.activateMatch(dialog.selectedIndex)
                }
                Keys.onEscapePressed: event => {
                    event.accepted = true
                    dialog.close()
                }
            }

            ActionButton {
                id: matchCaseButton
                objectName: "folderSearchCaseToggle"
                text: "Aa"
                compact: true
                checkable: true
                focusPolicy: Qt.TabFocus
                tonal: !checked
                highlighted: checked
                ToolTip.text: "Match case"
                onToggled: if (!dialog.syncingControls && dialog.visible) dialog.triggerSearch()
            }

            ActionButton {
                id: includeDiagramsButton
                objectName: "folderSearchDiagramsToggle"
                text: "Diagrams"
                compact: true
                checkable: true
                enabled: !dialog.isFilesMode
                opacity: enabled ? 1.0 : 0.48
                focusPolicy: Qt.TabFocus
                tonal: !checked
                highlighted: checked
                ToolTip.text: !enabled
                    ? "Diagram filtering applies to Text search"
                    : (checked
                        ? "Including inline SVG, Mermaid, and chart blocks"
                        : "Skipping inline SVG, Mermaid, and chart blocks")
                onToggled: if (!dialog.syncingControls && dialog.visible) dialog.triggerSearch()
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            ExpressiveLoading {
                visible: !!dialog.stateData.scanning
                running: visible
                implicitWidth: 18
                implicitHeight: 18
            }
            Label {
                objectName: "folderSearchStatus"
                Layout.fillWidth: true
                elide: Text.ElideRight
                font.pixelSize: 13
                color: dialog.colors.muted
                text: {
                    const q = (dialog.stateData.query || "").trim()
                    const count = (dialog.stateData.matches || []).length
                    const files = dialog.stateData.scannedFiles || 0
                    const suffix = dialog.stateData.truncated ? "+" : ""
                    if (dialog.stateData.scanning) {
                        return "Scanning " + files + " notes · " + count + suffix + " matches…"
                    }
                    if (!q.length) {
                        return dialog.isFilesMode
                            ? "Matches note file names from metadata without reading note contents."
                            : "Streams live matches without indexing disk or decoding embedded images."
                    }
                    const notesLabel = files === 1 ? "1 note" : (files + " notes")
                    if (dialog.isFilesMode) {
                        const hitsLabel = (count === 1 && !suffix) ? "1 matching note" : (count + suffix + " matching notes")
                        return hitsLabel + " across " + notesLabel + " · Enter opens note"
                    }
                    return count + suffix + " matches across " + notesLabel + " · Enter opens in-note search"
                }
            }
        }

        ListView {
            id: matchList
            objectName: "folderSearchList"
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: 6
            model: dialog.stateData.matches || []
            delegate: ItemDelegate {
                id: matchRow
                required property var modelData
                required property int index
                objectName: "folderSearchRow_" + index
                width: ListView.view ? ListView.view.width - 8 : 620
                implicitHeight: 62
                padding: 10
                highlighted: index === dialog.selectedIndex
                onClicked: dialog.activateMatch(index)
                background: Rectangle {
                    radius: 14
                    color: matchRow.highlighted
                        ? dialog.colors["surface-high"]
                        : matchRow.hovered ? dialog.colors.surface : "transparent"
                    border.width: matchRow.highlighted ? 1 : 0
                    border.color: dialog.colors.primary
                }
                contentItem: ColumnLayout {
                    spacing: 4
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8
                        Label {
                            Layout.fillWidth: true
                            text: modelData.relative || modelData.name || "Untitled.md"
                            textFormat: Text.PlainText
                            elide: Text.ElideMiddle
                            font.pixelSize: 13
                            font.weight: Font.DemiBold
                            color: dialog.colors.muted
                        }
                        Rectangle {
                            visible: !!modelData.dirty
                            radius: 8
                            color: dialog.colors.surface
                            border.width: 1
                            border.color: dialog.colors.primary
                            implicitHeight: 20
                            implicitWidth: dirtyLabel.implicitWidth + 12
                            Label {
                                id: dirtyLabel
                                anchors.centerIn: parent
                                text: "Live buffer"
                                font.pixelSize: 12
                                color: dialog.colors.primary
                            }
                        }
                        Label {
                            visible: (modelData.line || 0) > 0 && modelData.kind !== "file"
                            text: "Line " + (modelData.line || 1)
                            textFormat: Text.PlainText
                            font.pixelSize: 13
                            color: dialog.colors.muted
                        }
                    }
                    Label {
                        Layout.fillWidth: true
                        textFormat: Text.StyledText
                        elide: Text.ElideRight
                        maximumLineCount: 1
                        font.pixelSize: 14
                        color: dialog.colors.text
                        text: dialog.highlightedSnippet(modelData.snippet, modelData.matchStart, modelData.matchEnd)
                    }
                }
            }
            Label {
                visible: !dialog.stateData.scanning && (dialog.stateData.query || "").trim().length > 0 && (dialog.stateData.matches || []).length === 0
                anchors.centerIn: parent
                width: parent.width - 32
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.WordWrap
                color: dialog.colors.muted
                text: dialog.isFilesMode ? "No matching file names found." : "No text matches found."
            }
            ScrollBar.vertical: ExpressiveScrollBar { }
        }
    }

    onAboutToShow: {
        syncingControls = true
        searchDebounce.stop()
        uiMode = (stateData && stateData.mode === "files") ? "files" : "text"
        searchField.text = (stateData && stateData.query) || ""
        matchCaseButton.checked = !!(stateData && stateData.caseSensitive)
        includeDiagramsButton.checked = !!(stateData && stateData.includeDiagrams)
        selectedIndex = 0
        syncingControls = false
        Qt.callLater(function() {
            if (!dialog.visible) return
            searchField.forceActiveFocus()
            if (searchField.text === ((dialog.stateData && dialog.stateData.query) || "")) {
                searchField.selectAll()
            }
        })
    }

    onVisibleChanged: {
        if (!visible) {
            searchDebounce.stop()
        }
    }

    onOpened: {
        if (!searchField.activeFocus) {
            searchField.forceActiveFocus()
        }
    }

    onClosed: {
        searchDebounce.stop()
        studio.closeFolderSearch()
    }
}
