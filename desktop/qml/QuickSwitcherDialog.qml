import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

AppDialog {
    id: dialog
    objectName: "quickSwitcherDialog"
    title: "Quick switcher"
    property var stateData: studio.quickSwitcherState
    property int selectedIndex: 0
    width: Math.min(parent ? parent.width - 32 : 580, 580)
    height: Math.min(parent ? parent.height - 48 : 520, 520)

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

    function activateIndex(idx) {
        const items = stateData && stateData.items ? stateData.items : []
        if (idx < 0 || idx >= items.length) return
        const entry = items[idx]
        dialog.close()
        studio.activateQuickSwitcherItem(entry.tabId || "", entry.path || "")
    }

    onStateDataChanged: clampSelection()

    ColumnLayout {
        anchors.fill: parent
        spacing: 12

        TextField {
            id: queryField
            objectName: "quickSwitcherInput"
            Layout.fillWidth: true
            placeholderText: "Switch to a note by name or path…"
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
                const items = dialog.stateData.items || []
                if (items.length > 0) {
                    dialog.selectedIndex = (dialog.selectedIndex + 1) % items.length
                    resultsList.positionViewAtIndex(dialog.selectedIndex, ListView.Contain)
                }
            }
            Keys.onUpPressed: event => {
                event.accepted = true
                const items = dialog.stateData.items || []
                if (items.length > 0) {
                    dialog.selectedIndex = (dialog.selectedIndex - 1 + items.length) % items.length
                    resultsList.positionViewAtIndex(dialog.selectedIndex, ListView.Contain)
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
                objectName: "quickSwitcherSectionHint"
                Layout.fillWidth: true
                elide: Text.ElideRight
                font.pixelSize: 12
                color: dialog.colors.muted
                text: (dialog.stateData.query || "").trim().length > 0
                    ? ((dialog.stateData.items || []).length + " matching notes · Enter to open")
                    : "Pinned and recent notes first · Type to fuzzy-match open tabs and folders"
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
                width: ListView.view ? ListView.view.width - 8 : 500
                implicitHeight: 54
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
                    Image {
                        source: modelData.pinned ? "../icons/PushPin.svg" : "../icons/File.svg"
                        sourceSize.width: 18
                        sourceSize.height: 18
                        Layout.preferredWidth: 18
                        Layout.preferredHeight: 18
                        opacity: modelData.pinned ? 1.0 : 0.78
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 2
                        Label {
                            Layout.fillWidth: true
                            text: modelData.name || "Untitled.md"
                            textFormat: Text.PlainText
                            elide: Text.ElideRight
                            font.pixelSize: 14
                            font.weight: Font.Medium
                            color: dialog.colors.text
                        }
                        Label {
                            visible: !!modelData.relative && modelData.relative !== modelData.name
                            Layout.fillWidth: true
                            text: modelData.relative || ""
                            textFormat: Text.PlainText
                            elide: Text.ElideMiddle
                            font.pixelSize: 12
                            color: dialog.colors.muted
                        }
                    }
                    Rectangle {
                        visible: !!modelData.pinned || !!modelData.dirty || !!modelData.open
                        radius: 10
                        color: dialog.colors.surface
                        border.width: 1
                        border.color: dialog.colors.outline
                        implicitHeight: 22
                        implicitWidth: badgeText.implicitWidth + 14
                        Label {
                            id: badgeText
                            anchors.centerIn: parent
                            font.pixelSize: 11
                            color: modelData.dirty ? dialog.colors.primary : dialog.colors.muted
                            text: modelData.dirty ? "Unsaved" : (modelData.pinned ? "Pinned" : "Open")
                        }
                    }
                }
            }
            Label {
                visible: !dialog.stateData.loading && (dialog.stateData.items || []).length === 0
                anchors.centerIn: parent
                width: parent.width - 32
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.WordWrap
                color: dialog.colors.muted
                text: (dialog.stateData.query || "").trim().length > 0
                    ? "No matching notes found."
                    : "No recent notes or open tabs yet. Open a note or folder to switch quickly."
            }
            ScrollBar.vertical: ExpressiveScrollBar { }
        }
    }

    onOpened: {
        queryField.text = stateData.query || ""
        selectedIndex = 0
        Qt.callLater(function() {
            queryField.forceActiveFocus()
            queryField.selectAll()
        })
    }

    onClosed: {
        studio.closeQuickSwitcher()
    }
}
