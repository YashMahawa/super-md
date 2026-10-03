import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import QtQuick.Dialogs
import QtWebEngine
import QtWebChannel

ApplicationWindow {
    id: window
    width: 1320
    height: 880
    minimumWidth: 760
    minimumHeight: 520
    visible: false
    title: viewState.name + " - Super MD"
    property var viewState: JSON.parse(studio.snapshot)
    property bool sidebar: true
    property bool settingsOpen: false
    onSettingsOpenChanged: settingsOpen ? settingsDialog.open() : settingsDialog.close()
    property bool closingAllowed: false
    property string outputFormat: "pdf"
    property bool sharing: false
    WindowModes {
        id: windowModes
        host: window
        onFullscreenChanged: studio.setFullscreen(fullscreen)
    }
    function runDocumentScript(script) { reader.runJavaScript(script) }
    function showExport(share) { sharing = share; exportDialog.open() }
    function hideExport() { exportDialog.close() }
    Material.theme: viewState.dark ? Material.Dark : Material.Light
    Material.primary: viewState.colors.primary
    Material.accent: viewState.colors.primary
    Material.background: viewState.colors.surface
    Material.foreground: viewState.colors["on-surface"]
    color: viewState.colors.surface
    font.family: "Manrope"
    onClosing: function(close) { close.accepted = closingAllowed; if (!closingAllowed) studio.closeWindowSafely() }

    Connections {
        target: studio
        function onAllowClose() { closingAllowed = true; window.close() }
        function onFlushFailed(canClose) { flushDialog.canClose = canClose; flushDialog.open() }
        function onCloseRequested(name) { closeDialog.title = "Save changes to " + name + "?"; closeDialog.open() }
        function onSaveRequested(name) { saveDialog.selectedFile = studio.defaultSaveLocation(name); saveDialog.open() }
        function onExportRequested(format) { outputFormat = format; exportDialog.open() }
        function onFolderPickerRequested() { folderDialog.open() }
        function onFontPickerRequested() { fontDialog.open() }
        function onReaderLoad(payload) { reader.runJavaScript("window.supermdLoad?.(" + payload + ")") }
        function onReaderCall(script) { reader.runJavaScript(script) }
    }
    Shortcut { sequences: [StandardKey.New]; onActivated: studio.newNote() }
    FileDialog { id:fontDialog;title:"Import a font";fileMode:FileDialog.OpenFile;nameFilters:["Fonts (*.ttf *.otf)"];onAccepted:studio.importFont(selectedFile.toString()) }
    Shortcut { sequences: [StandardKey.Open]; onActivated: openDialog.open() }
    Shortcut { sequences: [StandardKey.Save]; onActivated: studio.saveSafely() }
    Shortcut { sequences: [StandardKey.Undo]; enabled: !settingsOpen && !viewState.readerOverlay && !exportDialog.visible; onActivated: studio.command("undo") }
    Shortcut { sequences: [StandardKey.Redo]; enabled: !settingsOpen && !viewState.readerOverlay && !exportDialog.visible; onActivated: studio.command("redo") }
    Shortcut { sequences: [StandardKey.Find]; onActivated: studio.command("find") }
    Shortcut { sequences: [StandardKey.Close]; onActivated: studio.closeTabSafely(viewState.active) }
    Shortcut { sequence: "Ctrl+Shift+N"; onActivated: studio.command("window") }
    Shortcut { sequence: "Ctrl+,"; onActivated: settingsOpen = !settingsOpen }
    Shortcut { sequence: "F11"; onActivated: windowModes.setFullscreen(!windowModes.fullscreen) }
    Shortcut { sequence: "Escape"; enabled: settingsOpen; onActivated: settingsOpen = false }
    Shortcut { sequence: "Escape"; enabled: windowModes.fullscreen && !settingsOpen && !viewState.readerOverlay; onActivated: reader.runJavaScript("window.supermdDismiss?.() || false", function(dismissed) { if (!dismissed) windowModes.setFullscreen(false) }) }
    // Qt's chrome never scales. Keyboard/pinch zoom is routed to the content pane.
    Shortcut { sequence: "Ctrl++"; onActivated: reader.runJavaScript("window.supermdZoomBy?.(1.1)") }
    Shortcut { sequence: "Ctrl+="; onActivated: reader.runJavaScript("window.supermdZoomBy?.(1.1)") }
    Shortcut { sequence: "Ctrl+-"; onActivated: reader.runJavaScript("window.supermdZoomBy?.(1/1.1)") }
    Shortcut { sequence: "Ctrl+0"; onActivated: reader.runJavaScript("window.supermdResetZoom?.()") }

    header: Column {
        visible: !viewState.fullscreen && viewState.settings.welcomed
        width: parent.width
        Pane {
            width: parent.width
            padding: 12
            background: Rectangle { color: viewState.colors["surface-low"] }
            RowLayout {
                anchors.fill: parent
                spacing: 8
                Image { source: studio.brand; sourceSize.width: 32; sourceSize.height: 32; Layout.preferredWidth: 32; Layout.preferredHeight: 32; Layout.rightMargin: 8 }
                ActionButton { glyph: "SidebarSimple"; onClicked: sidebar = !sidebar; ToolTip.text: "Show or hide files" }
                ActionButton { text: window.width < 1000 ? "" : "New note"; glyph: "Plus"; ToolTip.text: "New note"; onClicked: studio.newNote() }
                ActionButton { text: "Open note"; glyph: "File"; onClicked: openDialog.open() }
                ActionButton { glyph: "FloppyDisk"; ToolTip.text: "Save note"; onClicked: studio.saveSafely(); enabled: !viewState.busy }
                ActionButton { glyph: "Undo"; ToolTip.text: "Undo (Ctrl+Z)"; onClicked: studio.command("undo") }
                ActionButton { glyph: "Redo"; ToolTip.text: "Redo (Ctrl+Y)"; onClicked: studio.command("redo") }
                Item { Layout.fillWidth: true }
                ActionButton { glyph: "MagnifyingGlass"; ToolTip.text: "Find in note (Ctrl+F)"; onClicked: studio.command("find") }
                ActionButton { glyph: "Image"; ToolTip.text: "Insert image or link"; onClicked: studio.command("insert") }
                ActionButton { glyph: "Bug"; ToolTip.text: "Fix LaTeX"; onClicked: studio.command("repair") }
                ActionButton { glyph: "ShareNetwork"; ToolTip.text: "Share note"; onClicked: window.showExport(true) }
                ActionButton { text: "Export"; glyph: "Export"; prominent: true; enabled: !viewState.busy; onClicked: window.showExport(false) }
                ActionButton { glyph: "GearSix"; ToolTip.text: "Settings"; onClicked: settingsOpen = !settingsOpen }
            }
        }
        TabStrip {
            width: parent.width
            viewState: window.viewState
        }
        Rectangle { width: parent.width; height: 1; color: viewState.colors.outline; opacity: .55 }
    }
    SplitView {
        anchors.fill: parent
        orientation: Qt.Horizontal
        handle: Rectangle { implicitWidth: 6; color: window.viewState.colors["surface-low"]; Rectangle { anchors.horizontalCenter: parent.horizontalCenter; width: SplitHandle.pressed || SplitHandle.hovered ? 3 : 1; height: parent.height; color: SplitHandle.pressed || SplitHandle.hovered ? window.Material.primary : window.viewState.colors.outline } }
        Pane {
            visible: sidebar && !viewState.fullscreen
            SplitView.preferredWidth: 260
            SplitView.minimumWidth: 200
            SplitView.maximumWidth: 500
            padding: 16
            background: Rectangle { color: window.viewState.colors["surface-low"] }
            ColumnLayout {
                anchors.fill: parent
                spacing: 12
                Label { text: "Your files"; font.pixelSize: 22; font.weight: Font.DemiBold }
                ActionButton { text: "Open folder"; glyph: "FolderOpen"; tonal: true; Layout.fillWidth: true; onClicked: studio.chooseFolder() }
                RowLayout {
                    visible: !!viewState.folder
                    Layout.fillWidth: true
                    Label { text: viewState.folder.split("/").pop(); Layout.fillWidth: true; elide: Text.ElideMiddle }
                    ToolButton { text: "×"; Accessible.name: "Close folder"; ToolTip.text: "Close folder (notes stay open)"; ToolTip.visible: hovered; onClicked: studio.closeFolder() }
                }
                TextField { id: filter; visible: !!viewState.folder; Layout.fillWidth: true; placeholderText: "Filter files"; selectByMouse: true }
                ListView {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    model: viewState.files
                    delegate: ItemDelegate {
                        required property var modelData
                        width: ListView.view.width - 20
                        height: visible ? 42 : 0
                        visible: !filter.text || modelData.directory || modelData.name.toLowerCase().includes(filter.text.toLowerCase())
                        leftPadding: 8 + modelData.depth * 16
                        text: (modelData.directory ? (modelData.expanded ? "▾ " : "▸ ") : "") + modelData.name
                        onClicked: modelData.directory ? studio.toggleDirectory(modelData.path) : studio.openNote(modelData.path)
                    }
                    ScrollBar.vertical: ExpressiveScrollBar { }
                }
                Rectangle { Layout.fillWidth: true; height: 1; color: viewState.colors.outline }
                Label { text: "Recent notes"; font.weight: Font.DemiBold; color: viewState.colors.text }
                ListView {
                    Layout.fillWidth: true
                    Layout.preferredHeight: Math.min(240, viewState.recent.length * 40)
                    clip: true
                    model: viewState.recent
                    delegate: ItemDelegate { required property string modelData; width: ListView.view.width - 20; height: 40; text: modelData.split("/").pop(); onClicked: studio.openNote(modelData); ToolTip.visible: hovered; ToolTip.text: modelData }
                    ScrollBar.vertical: ExpressiveScrollBar { }
                }
                Label { visible: !viewState.folder && !viewState.recent.length; text: "Open any folder for quick access. Your notes stay ordinary files."; wrapMode: Text.WordWrap; Layout.fillWidth: true; color: viewState.colors.muted }
                Rectangle { Layout.fillWidth: true; height: 1; color: viewState.colors.outline }
                ActionButton { text: "New window"; tonal: true; Layout.fillWidth: true; onClicked: studio.command("window") }
            }
        }
        Item {
            SplitView.fillWidth: true
            ColumnLayout {
                anchors.fill: parent
                spacing: 0
                Pane {
                    visible: !viewState.fullscreen
                    Layout.fillWidth: true
                    padding: 12
                    background: Rectangle { color: viewState.colors["surface-low"]; Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: viewState.colors.outline; opacity: .4 } }
                    RowLayout {
                    anchors.fill: parent
                    ModeGroup { choices: window.width < 1000 ? [{key:"live",label:"Live"},{key:"editor",label:"Source"},{key:"reader",label:"Read"}] : [{key:"live",label:"Live"},{key:"editor",label:"Source"},{key:"reader",label:"Read"},{key:"split",label:"Split"}]; selected: viewState.mode; onChosen: key => studio.setMode(key) }
                    Item { Layout.fillWidth: true }
                    ExpressiveSlider { visible: window.width >= 1000; Layout.preferredWidth: 140; from: 60; to: 240; value: viewState.zoom; onMoved: studio.setZoom(value); Accessible.name: "Content zoom" }
                    TextField {
                        objectName: "zoomPercentage"
                        Layout.preferredWidth: 76
                        Layout.preferredHeight: 36
                        Layout.alignment: Qt.AlignVCenter
                        text: Math.round(viewState.zoom).toString() + "%"
                        font.family: "Noto Sans"
                        font.pixelSize: 13
                        horizontalAlignment: Text.AlignHCenter
                        verticalAlignment: Text.AlignVCenter
                        selectByMouse: true
                        color: viewState.colors.text
                        padding: 6
                        validator: RegularExpressionValidator { regularExpression: /[0-9]{1,3}%?/ }
                        onEditingFinished: { const value = Number(text.replace("%","")); if (value >= 60 && value <= 240) studio.setZoom(value); else text = Math.round(viewState.zoom) + "%" }
                        background: Rectangle { radius: 12; antialiasing: true; color: viewState.colors["surface-high"]; border.width: parent.activeFocus ? 2 : 0; border.color: viewState.colors.primary }
                        Accessible.name: "Zoom percentage"
                    }
                    ActionButton { objectName: "fullscreenButton"; glyph: "Fullscreen"; icon.width: 24; icon.height: 24; compact: true; tonal: true; ToolTip.text: "Fullscreen (F11 · Esc to exit)"; onClicked: windowModes.setFullscreen(true) }
                    }
                }
                WebEngineView {
                    id: reader
                    objectName: "documentReader"
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    backgroundColor: window.color
                    webChannel: WebChannel { id: documentChannel; Component.onCompleted: registerObject("studio", studio) }
                    settings.localContentCanAccessRemoteUrls: false
                    settings.localContentCanAccessFileUrls: true
                    settings.javascriptCanOpenWindows: false
                    settings.fullScreenSupportEnabled: false
                    WheelHandler {
                        target: null
                        acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
                        onWheel: function(event) {
                            // Qt retains the device's pixel deltas. DOM wheel
                            // events lose that distinction, so route touchpad
                            // movement without guessing from notch magnitude.
                            if ((event.pixelDelta.x || event.pixelDelta.y) && !(event.modifiers & (Qt.ControlModifier | Qt.MetaModifier))) {
                                event.accepted = true
                                reader.runJavaScript("window.supermdNativeWheel?.(" + (-event.pixelDelta.x) + "," + (-event.pixelDelta.y) + "," + JSON.stringify({x:event.x,y:event.y}) + "," + !!(event.buttons & Qt.LeftButton) + ")")
                            } else event.accepted = false
                        }
                    }
                    Component.onCompleted: {
                        const script = WebEngine.script()
                        script.injectionPoint = WebEngineScript.DocumentCreation
                        script.worldId = WebEngineScript.MainWorld
                        script.sourceCode = channelScript
                        userScripts.insert(script)
                        url = readerUrl
                    }
                    onZoomFactorChanged: {
                        if (Math.abs(zoomFactor - 1) > .001) {
                            const factor = zoomFactor
                            zoomFactor = 1
                            runJavaScript("if (window.dispatchEvent(new CustomEvent('supermd-chart-native-zoom',{detail:" + factor + ",cancelable:true}))) window.supermdZoomBy?.(" + factor + ")")
                        }
                    }
                    onNavigationRequested: function(request) {
                        if (request.url.toString().split("#")[0] !== readerUrl.toString()) {
                            request.reject()
                            if (request.url.toString().startsWith("https://") || request.url.toString().startsWith("http://")) Qt.openUrlExternally(request.url)
                        }
                    }
                }
            }
            ActionButton { visible: viewState.fullscreen && !viewState.readerOverlay; glyph: "FullscreenExit"; icon.width: 24; icon.height: 24; compact: true; tonal: true; ToolTip.text: "Exit fullscreen (Esc · F11)"; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 12; onClicked: windowModes.setFullscreen(false) }
        }
    }
    Dialog {
        id: settingsDialog
        objectName: "settingsDialog"
        modal: true
        anchors.centerIn: parent
        width: Math.min(640, window.width - 48)
        height: Math.min(780, window.height - 64)
        padding: 0
        background: Rectangle { color: viewState.colors.surface; radius: 28; antialiasing: true }
        Overlay.modal: Rectangle { color: "#66000000" }
        enter: Transition { NumberAnimation { property: "opacity"; from: 0; to: 1; duration: viewState.settings.motion ? 160 : 0 } }
        exit: Transition { NumberAnimation { property: "opacity"; from: 1; to: 0; duration: viewState.settings.motion ? 100 : 0 } }
        onClosed: settingsOpen = false
        SettingsPage { viewState: window.viewState; anchors.fill: parent; onBack: settingsOpen = false }
    }
    footer: Pane {
        visible: !viewState.fullscreen
        padding: 6
        RowLayout { anchors.fill: parent; Label { text: viewState.busy ? "Preparing document…" : viewState.message || "Local files. Automatic draft recovery."; elide: Text.ElideRight; Layout.fillWidth: true; color: viewState.colors.muted; font.pixelSize: 12 } BusyIndicator { running: viewState.busy; implicitHeight: 20; implicitWidth: 20 } }
    }
    FileDialog { id: openDialog; title: "Open note"; nameFilters: ["Notes (*.md *.smd *.fmd *.markdown)", "All files (*)"]; onAccepted: studio.openNote(selectedFile.toString()) }
    FolderDialog { id: folderDialog; title: "Open folder"; onAccepted: studio.openFolder(selectedFolder.toString()) }
    FileDialog { id: saveDialog; title: "Save note"; fileMode: FileDialog.SaveFile; nameFilters: ["Markdown (*.md)", "Portable Super MD (*.smd)"]; onAccepted: studio.saveAs(selectedFile.toString()); onRejected: studio.resolveClose("cancel") }
    FileDialog { id: destination; title: "Export note"; fileMode: FileDialog.SaveFile; nameFilters: outputFormat === "pdf" ? ["PDF (*.pdf)"] : outputFormat === "md" ? ["Markdown (*.md)"] : ["Portable Super MD (*.smd)"]; onAccepted: studio.exportTo(selectedFile.toString(), outputFormat) }
    Dialog {
        id: exportDialog
        objectName: "exportDialog"
        title: sharing ? "Share note" : "Export note"
        modal: true
        anchors.centerIn: parent
        width: Math.min(560, window.width - 48)
        height: Math.min(760, window.height - 64)
        standardButtons: Dialog.Cancel
        background: Rectangle { color: viewState.colors.surface; radius: 28; antialiasing: true }
        Overlay.modal: Rectangle { color: "#66000000" }
        ColumnLayout {
            anchors.fill: parent
            spacing: 16
            Label { text: sharing ? "Choose a format. Sharing availability depends on your desktop." : "PDF preserves the layout. Portable SMD includes editable Markdown and images."; wrapMode: Text.WordWrap; Layout.fillWidth: true }
            ChoiceField { Layout.fillWidth: true; visible: model.length > 1; model: sharing ? ["PDF", "Portable SMD", "Markdown"] : viewState.portable ? ["PDF"] : ["PDF", "Portable SMD"]; currentIndex: outputFormat === "pdf" ? 0 : outputFormat === "smd" ? 1 : 2; onActivated: outputFormat = currentIndex === 0 ? "pdf" : currentIndex === 1 ? "smd" : "md" }
            ScrollView {
                id: exportScroll
                Layout.fillWidth: true
                Layout.fillHeight: true
                contentWidth: availableWidth
                rightPadding: 24
                ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
                ScrollBar.vertical: ExpressiveScrollBar { parent: exportScroll; x: exportScroll.width - width; y: 0; height: exportScroll.height }
                ColumnLayout {
                    width: exportScroll.availableWidth
                    PdfControls { objectName: "exportPdfControls"; visible: outputFormat === "pdf"; Layout.fillWidth: true; viewportItem: exportScroll.contentItem; options: viewState.settings.pdf; onEdited: options => studio.setting("pdf", JSON.stringify(options)) }
                    Label { visible: outputFormat !== "pdf"; Layout.fillWidth: true; wrapMode: Text.WordWrap; text: outputFormat === "md" ? "Editable Markdown text. Choose portable SMD to include images in one file." : "A portable .smd keeps the editable Markdown and images together. Source mode never shows embedded image bytes." }
                }
            }
            ActionButton { text: sharing ? "Prepare share copy" : "Choose destination"; prominent: true; Layout.fillWidth: true; onClicked: { exportDialog.close(); destination.open() } }
        }
        onOpened: {
            outputFormat = "pdf"
            forceActiveFocus()
            Qt.callLater(() => exportScroll.contentItem.contentY = 0)
        }
    }
    Dialog {
        id: closeDialog
        modal: true
        anchors.centerIn: parent
        width: 440
        closePolicy: Popup.NoAutoClose
        ColumnLayout {
            width: parent.width
            spacing: 20
            Label { text: "Save your changes before closing. Cancelling keeps the note open."; Layout.fillWidth: true; wrapMode: Text.WordWrap }
            RowLayout {
                ActionButton { text: "Cancel"; onClicked: { closeDialog.close(); studio.resolveClose("cancel") } }
                ActionButton { text: "Discard"; onClicked: { closeDialog.close(); studio.resolveClose("discard") } }
                ActionButton { text: "Save"; prominent: true; onClicked: { closeDialog.close(); studio.resolveClose("save") } }
            }
        }
    }
    Dialog {
        id: flushDialog
        property bool canClose: false
        title: "The document reader is busy"
        modal: true
        anchors.centerIn: parent
        width: Math.min(480,window.width-48)
        closePolicy: Popup.NoAutoClose
        ColumnLayout {
            width: parent.width
            spacing: 20
            Label { text: "Retry to synchronize your latest edits. Closing with recovery keeps the last received drafts, but edits still inside the unresponsive reader may be lost."; wrapMode: Text.WordWrap; Layout.fillWidth: true }
            RowLayout {
                ActionButton { text: "Cancel"; onClicked: { flushDialog.close(); studio.resolveFlush("cancel") } }
                ActionButton { visible: flushDialog.canClose; text: "Close with recovery"; onClicked: { flushDialog.close(); studio.resolveFlush("recover_close") } }
                ActionButton { text: "Retry"; prominent: true; onClicked: { flushDialog.close(); studio.resolveFlush("retry") } }
            }
        }
    }
    // A dedicated welcome surface rather than a stack of modal setup steps.
    Pane {
        visible: !viewState.settings.welcomed
        anchors.fill: parent
        padding: 40
        background: Rectangle { color: window.color }
        ColumnLayout {
            anchors.centerIn: parent
            width: Math.min(600, parent.width - 40)
            spacing: 24
            Image { source: studio.brand; sourceSize.width: 64; sourceSize.height: 64; Layout.preferredWidth: 64; Layout.preferredHeight: 64 }
            Label { text: "Your notes. More room to think."; font.pixelSize: 32; font.weight: Font.DemiBold; Layout.fillWidth: true; wrapMode: Text.WordWrap }
            Label { text: "Open a Markdown note, or keep images together in a portable .smd. No vault or import process."; Layout.fillWidth: true; wrapMode: Text.WordWrap; font.pixelSize: 17; opacity: .8 }
            ModeGroup { Layout.fillWidth: true; choices: [{key:"system",label:"System"},{key:"light",label:"Light"},{key:"dark",label:"Dark"},{key:"black",label:"Pure black"}]; selected: viewState.settings.theme; onChosen: key => studio.setting("theme", JSON.stringify(key)) }
            Switch { text: "Expressive motion"; checked: viewState.settings.motion; onToggled: studio.setting("motion", JSON.stringify(checked)) }
            RowLayout {
                ActionButton { text: "Open note"; prominent: true; onClicked: { studio.setting("welcomed", "true"); openDialog.open() } }
                ActionButton { text: "Explore a sample"; onClicked: studio.setting("welcomed", "true") }
            }
            Label { text: "PDFs are typeset locally. Python runs only when you choose Run."; Layout.fillWidth: true; wrapMode: Text.WordWrap; opacity: .7 }
        }
    }
}
