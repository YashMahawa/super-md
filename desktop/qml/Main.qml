import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import QtQuick.Dialogs
import QtWebEngine
import QtWebChannel

ApplicationWindow {
    id: window
    signal readerViewChanged(var readerView)
    onReaderViewChanged: function(view) { if (typeof studio.attachWindowDropFilter === "function") studio.attachWindowDropFilter(window, view) }
    property bool readerActivated: !Boolean(studio.deferReaderActivation)
    function activateReaderIfNeeded() {
        if (typeof studio.ensureReaderProfile === "function") studio.ensureReaderProfile()
        if (!readerActivated) readerActivated = true
        if (!readerLoader.active) readerLoader.active = true
    }
    Component.onCompleted: { if (visible || !Boolean(studio.deferReaderActivation)) activateReaderIfNeeded(); if (typeof studio.attachWindowDropFilter === "function") studio.attachWindowDropFilter(window, window.reader) }
    onVisibleChanged: if (visible) activateReaderIfNeeded()
    width: 1320
    height: 880
    minimumWidth: 760
    minimumHeight: 520
    visible: false
    flags: (studio.fedoraWindowFrame || windowModes.immersive) ? Qt.Window | Qt.FramelessWindowHint : Qt.platform.os === "osx" || Qt.platform.os === "windows" ? Qt.Window | Qt.ExpandedClientAreaHint | Qt.NoTitleBarBackgroundHint : Qt.Window
    title: viewState.name + " - Super MD"
    property var viewState: JSON.parse(studio.snapshot)
    property var tabsState: JSON.parse(studio.tabsSnapshot)
    property string activeTabId: studio.activeTabId
    property var sidebarState: JSON.parse(studio.sidebarSnapshot)
    property var reader: readerLoader.item
    property bool sidebar: true
    property bool settingsOpen: false
    property int contextMenuCount: 0
    property int modalDialogCount: 0
    property bool capturingShortcut: false
    property var shortcutBindings: JSON.parse(studio.shortcutBindings)
    property var shortcutLabels: JSON.parse(studio.shortcutLabels)
    onSettingsOpenChanged: settingsOpen ? settingsDialog.open() : settingsDialog.close()
    property bool closingAllowed: false
    property bool intentionalShutdown: false
    property bool readerRecoveryPending: false
    property bool readerRecoveryLoading: false
    property bool readerRecoveryExhausted: false
    property int readerRetryCount: 0
    property string readerRecoveryMessage: ""
    property string outputFormat: "pdf"
    property bool sharing: false
    property string sidebarSection: "folder"
    property bool chromeAwake: true
    readonly property real readerVisibleChromeInset: studyToolbar.visible && studyToolbar.shown ? studyToolbar.height : 0
    onReaderVisibleChromeInsetChanged: syncVisibleReaderChrome()
    Timer { id: chromeIdle; interval: 2200; onTriggered: { if(studyToolbar.hovered || studyToolbar.focusWithin) restart(); else window.chromeAwake = false } }
    // Deliberate desktop reveal target; ordinary pointer movement in a note
    // does not summon controls. Scrolling only hides; clicks may toggle them.
    HoverHandler { onPointChanged: { if(window.viewState.fullscreen && point.position.y < 56) window.chromeAwake = true; if(window.chromeAwake) chromeIdle.restart() } }
    WindowModes { id: windowModes; host: window; onFullscreenChanged: { window.chromeAwake = !fullscreen; chromeIdle.stop(); studio.setFullscreen(fullscreen) } }
    WindowResizeEdges { host: window }
    function runDocumentScript(script) {
        if (!reader) return
        reader.runJavaScript(script)
    }
    function runDocumentScriptWithCallback(script, callback) {
        if (!reader) return
        reader.runJavaScript(script, callback)
    }
    function routeAgentRequest(raw) {
        let request
        try { request = JSON.parse(raw) } catch (error) { return }
        if (request.action === "render_tab") {
            window.routeAgentRender(request)
            return
        }
        const requestId = JSON.stringify(request.requestId || "")
        const failure = "window.SuperMD?.post(" + requestId + ", 'agent_result', JSON.stringify({requestId:" + requestId + ",error:'reader is unavailable'}))"
        if (!window.visible) {
            if (request.action === "flush_current") {
                studio.post(request.requestId || "", "agent_result", JSON.stringify({requestId: request.requestId, result: {flushed: false}, error: ""}))
                return
            }
            if (request.action === "list_tabs") {
                studio.post(request.requestId || "", "agent_result", JSON.stringify({requestId: request.requestId, result: {tabs: request.tabs || []}, error: ""}))
                return
            }
        }
        if (!window.reader || !viewState.readerReady) {
            studio.post(request.requestId || "", "agent_result", JSON.stringify({requestId: request.requestId, error: "Reader is not ready"}))
            return
        }
        const encoded = JSON.stringify(request)
        const script = "(function(){const request=" + encoded + ";if(typeof window[request._snapshot?'supermdAgentCompute':'supermdAgentRequest']!=='function'){" + failure + ";return;}window[request._snapshot?'supermdAgentCompute':'supermdAgentRequest'](request,function(result,error){window.SuperMD?.post(request.requestId,'agent_result',JSON.stringify({requestId:request.requestId,result:result,error:error||''}));});})()"
        window.reader.runJavaScript(script)
    }
    function routeAgentRender(request) {
        if (!window.reader || !viewState.readerReady) {
            studio.post(request.requestId || "", "agent_render_bounds", JSON.stringify({requestId:request.requestId,error:"Reader is not ready"}))
            return
        }
        const webView = window.reader
        const contextValue = {requestId:request.requestId, tabId:request.tabId, action:"get_context", limit:6000}
        if (request.expectedRevision !== undefined) contextValue.expectedRevision = request.expectedRevision
        const contextRequest = JSON.stringify(contextValue)
        const captureWidth = JSON.stringify(request.width || 1600)
        const captureFormat = JSON.stringify(request.imageFormat || "png")
        const requestId = JSON.stringify(request.requestId || "")
        const script = "(function(){const request=" + contextRequest + ";if(typeof window[request._snapshot?'supermdAgentCompute':'supermdAgentRequest']!=='function'){window.SuperMD?.post(" + requestId + ",'agent_render_bounds',JSON.stringify({requestId:request.requestId,error:'Reader agent hook is unavailable'}));return;}window.supermdAgentRequest(request,function(context,error){if(error){window.SuperMD?.post(request.requestId,'agent_render_bounds',JSON.stringify({requestId:request.requestId,error:error}));return;}window.SuperMD?.post(request.requestId,'agent_render_bounds',JSON.stringify({requestId:request.requestId,tabId:context&&context.tabId,revision:context&&context.revision,width:" + captureWidth + ",imageFormat:" + captureFormat + ",context:context}));});})()"
        webView.runJavaScript(script)
    }
    function syncVisibleReaderChrome() {
        window.runDocumentScript("document.documentElement.style.setProperty('--native-visible-chrome-inset','" + readerVisibleChromeInset + "px')")
    }
    function openFind(replace) {
        if (!reader) return
        const target = reader
        const script = replace ? "window.supermdFind?.(true)" : "window.supermdFind?.()"
        target.forceActiveFocus()
        target.runJavaScript(script, function() {
            if (window.reader === target) target.forceActiveFocus()
        })
    }
    function hintWithShortcut(label, key, fallback) {
        const map = window.shortcutLabels || {}
        const raw = map[key] !== undefined ? map[key] : (fallback || "")
        return raw && raw !== "Disabled" ? label + " (" + raw + ")" : label
    }
    function fullscreenHint() {
        const map = window.shortcutLabels || {}
        const full = map.fullscreen && map.fullscreen !== "Disabled" ? map.fullscreen : ""
        const exitKey = map.dismiss && map.dismiss !== "Disabled" ? map.dismiss + " to exit" : ""
        const parts = [full, exitKey].filter(Boolean)
        return parts.length > 0 ? "Fullscreen (" + parts.join(" · ") + ")" : "Fullscreen"
    }
    function modeChoices(includeSplit) {
        const items = [
            { key: "live", label: "Live", tooltip: window.hintWithShortcut("Live mode", "mode_live") },
            { key: "editor", label: "Source", tooltip: window.hintWithShortcut("Source mode", "mode_editor") },
            { key: "reader", label: "Read", tooltip: window.hintWithShortcut("Read mode", "mode_reader") },
        ]
        if (includeSplit) items.push({ key: "split", label: "Split", tooltip: window.hintWithShortcut("Split mode", "mode_split") })
        return items
    }
    function nativeTextEditorFocused() {
        // Application-level shortcuts must leave real Qt settings fields to
        // their own platform editing commands. WebEngine's DOM inputs are
        // handled by the reader edit-action route below.
        let item = window.activeFocusItem
        while (item) {
            if (item instanceof TextInput || item instanceof TextEdit) return true
            item = item.parent
        }
        return false
    }
    function shortcutEnabled(action) {
        // App actions must not escape a modal into the note underneath. Native
        // Qt text fields keep their own editing bindings because these QML
        // application shortcuts are disabled while the modal is open.
        if (modalDialogCount > 0) return false
        if (["copy", "cut", "paste", "select_all"].includes(action) && window.nativeTextEditorFocused()) return false
        if (["bold", "italic", "inline_code", "link", "heading", "list", "quote", "inline_math"].includes(action)) {
            return !modalDialogCount && !window.nativeTextEditorFocused() && !viewState.readerOverlay && viewState.mode !== "reader"
        }
        if (action === "undo" || action === "redo") return !modalDialogCount && !viewState.readerOverlay
        if (action === "mode_live" || action === "mode_editor" || action === "mode_reader" || action === "mode_split")
            return !modalDialogCount && !viewState.fullscreen && !viewState.readerOverlay && !viewState.imageOverlay && (action !== "mode_split" || window.width >= 1000)
        if (action === "close_tab") return !modalDialogCount
        if (action === "dismiss") return !modalDialogCount && !contentsPopup.visible
        return true
    }
    function nativeReaderEditAction(action) {
        if (!reader) return
        if (action === "copy") {
            // Chromium's WebAction.Copy uses native focus, which may still be
            // on a toolbar item while the rendered selection remains visible.
            // Restore the view's focus before dispatching the native action so
            // its copy event reaches MarkdownPreview's source serializer.
            reader.forceActiveFocus()
            reader.triggerWebAction(WebEngineView.Copy)
            return
        }
        // A QML toolbar can retain focus while Chromium still paints a DOM
        // selection. Refocus the view and dispatch its native action directly
        // in the key event's turn; this preserves Chromium's user gesture and
        // lets MarkdownPreview's copy handler serialize source (including math).
        reader.forceActiveFocus()
        if (action === "cut") reader.triggerWebAction(WebEngineView.Cut)
        else if (action === "paste") reader.triggerWebAction(WebEngineView.Paste)
        else if (action === "select_all") reader.triggerWebAction(WebEngineView.SelectAll)
    }
    function activateShortcut(action) {
        if (action.startsWith("tab_")) { studio.tabNumber(Number(action.slice(4))); return }
        switch (action) {
        case "new_window": studio.command("window"); break
        case "new_note": studio.newNote(); break
        case "open": openDialog.open(); break
        case "save": studio.saveSafely(); break
        case "save_as": studio.saveAsSafely(); break
        case "undo": studio.command("undo"); break
        case "redo": studio.command("redo"); break
        case "copy": window.nativeReaderEditAction("copy"); break
        case "cut": window.nativeReaderEditAction("cut"); break
        case "paste": window.nativeReaderEditAction("paste"); break
        case "select_all": window.nativeReaderEditAction("select_all"); break
        case "bold":
        case "italic":
        case "inline_code":
        case "link":
        case "heading":
        case "list":
        case "quote":
        case "inline_math":
            window.focusReader()
            studio.command("format_" + action)
            break
        case "find": window.openFind(false); break
        case "replace": window.openFind(true); break
        case "find_next": window.focusReader(); studio.command("find_next"); break
        case "find_previous": window.focusReader(); studio.command("find_previous"); break
        case "quick_switcher": studio.openQuickSwitcher(); break
        case "search_folder": studio.openFolderSearch(); break
        case "close_tab": studio.closeTabSafely(window.activeTabId || viewState.active); break
        case "next_tab": studio.cycleTab(1); break
        case "previous_tab": studio.cycleTab(-1); break
        case "move_tab_left": studio.moveActiveTab(-1); break
        case "move_tab_right": studio.moveActiveTab(1); break
        case "reopen_tab": studio.reopenTab(); break
        case "close_window": studio.closeWindowSafely(); break
        case "settings": settingsOpen = !settingsOpen; break
        case "fullscreen": windowModes.setFullscreen(!windowModes.fullscreen); break
        case "dismiss": window.runDocumentScriptWithCallback("window.supermdDismiss?.() || false", function(dismissed) { if (!dismissed && windowModes.fullscreen) windowModes.setFullscreen(false) }); break
        case "zoom_in": window.runDocumentScript("window.supermdZoomBy?.(1.1)"); break
        case "zoom_out": window.runDocumentScript("window.supermdZoomBy?.(1/1.1)"); break
        case "zoom_reset": window.runDocumentScript("window.supermdResetZoom?.()"); break
        case "typewriter_scroll": studio.setting("typewriterScroll", JSON.stringify(!viewState.settings.typewriterScroll)); break
        case "new_folder_note": sidebar = true; sidebarSection = "folder"; folderSidebar.triggerNewFolderNote(); break
        case "new_subfolder": sidebar = true; sidebarSection = "folder"; folderSidebar.triggerNewSubfolder(); break
        case "rename_entry": folderSidebar.triggerRenameSelectedOrActive(); break
        case "mode_live": studio.setMode("live"); break
        case "mode_editor": studio.setMode("editor"); break
        case "mode_reader": studio.setMode("reader"); break
        case "mode_split": if (window.width >= 1000) studio.setMode("split"); break
        }
    }
    function focusReader() { if (reader) reader.forceActiveFocus() }
    function scheduleReaderRemount(delay) {
        readerRecoveryPending = true
        readerRetryTimer.interval = delay
        readerRetryTimer.restart()
    }
    function handleReaderCrash(terminationStatus) {
        if (intentionalShutdown || closingAllowed || studio.retired || readerRecoveryPending || terminationStatus === WebEngineView.NormalTerminationStatus) return
        console.warn("Qt reader recovery: renderer terminated", terminationStatus)
        studio.readerCrashed()
        const retryDelays = [500, 1500, 4000]
        if (readerRetryCount >= retryDelays.length) {
            readerRecoveryPending = false
            readerRecoveryExhausted = true
            readerRecoveryMessage = "The document reader stopped repeatedly. Your last received changes are preserved. Retry when ready."
            return
        }
        readerRecoveryMessage = "The document reader stopped unexpectedly. Reopening it…"
        scheduleReaderRemount(retryDelays[readerRetryCount])
        readerRetryCount += 1
    }
    function retryReaderManually() {
        if (intentionalShutdown || closingAllowed || studio.retired || readerRecoveryPending) return
        readerRetryCount = 0
        readerRecoveryExhausted = false
        readerRecoveryMessage = "Reopening the document reader…"
        scheduleReaderRemount(0)
    }
    function chooseSaveDestination(dialogTitle, folderUrl, fileUrl) {
        const dialog = saveDestinationComponent.createObject(window, {
            title: dialogTitle,
            portableNote: Boolean(viewState.portable),
            currentFolder: folderUrl,
            selectedFile: fileUrl
        })
        dialog.open()
    }
    function showExport(share) { sharing = share; outputFormat = "pdf"; exportDialog.open() }
    function chooseExportDestination() {
        // A fresh native chooser for every operation: some portal helpers keep
        // the first selected URL/filter when a FileDialog instance is reused.
        // Keep the format with the chooser, never in mutable options UI state.
        const format = outputFormat
        exportDialog.close()
        const dialog = exportDestinationComponent.createObject(window, {
            exportFormat: format,
            selectedFile: studio.defaultExportLocation(format)
        })
        dialog.open()
    }
    function hideExport() { exportDialog.close() }
    Material.theme: viewState.dark ? Material.Dark : Material.Light
    Material.primary: viewState.colors.primary
    Material.accent: viewState.colors.primary
    Material.background: viewState.colors.surface
    Material.foreground: viewState.colors["on-surface"]
    color: viewState.colors.surface
    font.family: "Noto Sans"
    onClosing: function(close) {
        if (window.visible && !windowModes.fullscreen) studio.rememberWindow(visibility === Window.Maximized ? viewState.settings.window.width : width, visibility === Window.Maximized ? viewState.settings.window.height : height, visibility === Window.Maximized)
        close.accepted = closingAllowed; if (closingAllowed) intentionalShutdown = true; else studio.closeWindowSafely()
    }

    Connections {
        target: studio
        function onAllowClose() {
            flushDialog.close(); closeDialog.close()
            if (studio.backgroundEnabled && !studio.hasOtherOpenWindows()) { window.hide(); return }
            intentionalShutdown = true; closingAllowed = true
            readerRetryTimer.stop(); readerRecoveryRestoreTimer.stop(); readerStableTimer.stop()
            if (readerLoader.active) readerLoader.active = false
            window.close()
        }
        function onFlushFailed(canClose) { if(!closingAllowed && !closeDialog.visible) { if (!window.visible) { window.show(); window.raise(); window.requestActivate() } flushDialog.canClose = canClose; flushDialog.open() } }
        function onCloseRequested(name) { flushDialog.close(); closeDialog.title = "Save changes to " + name + "?"; if(!closeDialog.visible) { if (!window.visible) { window.show(); window.raise(); window.requestActivate() } closeDialog.open() } }
        function onSaveRequested(name) { window.chooseSaveDestination("Save note", studio.defaultSaveFolder(), studio.defaultSaveLocation(name)) }
        function onSaveAsRequested(name) { window.chooseSaveDestination("Save as", studio.defaultSaveAsFolder(), studio.defaultSaveAsLocation(name)) }
        function onSaveConflictRequested(name) { flushDialog.close(); closeDialog.close(); saveConflictDialog.title = name + " changed on disk"; if (!saveConflictDialog.visible) { if (!window.visible) { window.show(); window.raise(); window.requestActivate() } saveConflictDialog.open() } }
        function onNoteLocationPickerRequested() { noteFolderDialog.open() }
        function onExportRequested(format) { sharing = false; outputFormat = format; exportDialog.open() }
        function onFolderPickerRequested() { folderDialog.open() }
        function onFontPickerRequested() { fontDialog.open() }
        function onThemePickerRequested() { themeDialog.open() }
        function onThemeExportRequested() { themeExportDialog.selectedFile = studio.defaultThemeExportLocation("My theme.supermd-theme.json"); themeExportDialog.open() }
        function onReaderLoad(payload) {
            const script = "(function(){if(!window.supermdLoad)return false;window.supermdLoad(" + payload + ");window.supermdChromeInset?.(" + (studio.readerFullscreen ? 56 : 0) + ");document.documentElement.style.setProperty('--native-visible-chrome-inset','" + window.readerVisibleChromeInset + "px');return true})()"
            window.runDocumentScript(script)
        }
        function onReaderCall(script) { window.runDocumentScript(script) }
        function onReaderReloadRequested() { if (window.reader) window.reader.reload() }
        function onChromeRequested(action) { window.chromeAwake = action === "toggle" ? !window.chromeAwake : action === "show"; if(window.chromeAwake) chromeIdle.restart(); else { chromeIdle.stop(); window.focusReader() } }
        function onAgentRequest(payload) { window.routeAgentRequest(payload) }
        function onWorkspaceSearchChanged() { if (studio.folderSearchState.open && !folderSearchDialog.visible) folderSearchDialog.open(); else if (!studio.folderSearchState.open && folderSearchDialog.visible) folderSearchDialog.close() }
        function onQuickSwitcherChanged() { if (studio.quickSwitcherState.open && !quickSwitcherDialog.visible) quickSwitcherDialog.openWithFocusCapture(); else if (!studio.quickSwitcherState.open && quickSwitcherDialog.visible) quickSwitcherDialog.close() }
        function onWorkspaceFolderDropped() { window.sidebar = true; window.sidebarSection = "folder" }
    }
    onViewStateChanged: {
        if (!viewState.readerReady) readerStableTimer.stop()
        else if (!readerStableTimer.running && (readerRetryCount > 0 || readerRecoveryLoading)) readerStableTimer.start()
    }
    Timer {
        id: readerRetryTimer
        interval: 500
        repeat: false
        onTriggered: {
            readerRecoveryPending = false
            if (!window.intentionalShutdown && !window.closingAllowed && !studio.retired && reader) {
                console.warn("Qt reader recovery: recreating view", window.readerRetryCount)
                window.readerRecoveryLoading = true
                readerLoader.active = false
                readerRecoveryRestoreTimer.start()
            }
        }
    }
    Timer {
        id: readerRecoveryRestoreTimer
        interval: 120
        repeat: false
        onTriggered: {
            if (!window.intentionalShutdown && !window.closingAllowed && !studio.retired && readerLoader) {
                if (typeof studio.ensureReaderProfile === "function") studio.ensureReaderProfile()
                readerLoader.active = true
            }
        }
    }
    Timer {
        id: readerStableTimer
        interval: 15000
        repeat: false
        onTriggered: if (viewState.readerReady) {
            window.readerRecoveryLoading = false
            readerRetryCount = 0
            readerRecoveryExhausted = false
            readerRecoveryMessage = ""
        }
    }
    Repeater {
        model: JSON.parse(studio.shortcutActions)
        delegate: Item {
            required property var modelData; width: 0; height: 0
            Shortcut { sequences: window.shortcutBindings[modelData.id]; enabled: !window.capturingShortcut && window.shortcutEnabled(modelData.id); context: Qt.WindowShortcut; onActivated: window.activateShortcut(modelData.id) }
        }
    }
    FileDialog { id:fontDialog;title:"Import a font";fileMode:FileDialog.OpenFile;nameFilters:["Fonts (*.ttf *.otf)"];onAccepted:studio.importFont(selectedFile.toString()) }
    FileDialog { id:themeDialog;title:"Import a Super MD theme";fileMode:FileDialog.OpenFile;nameFilters:["Theme files (*.json)"];onAccepted:studio.importCustomTheme(selectedFile.toString()) }
    FileDialog { id:themeExportDialog;title:"Export editable theme";fileMode:FileDialog.SaveFile;defaultSuffix:"json";selectedFile:studio.defaultThemeExportLocation("My theme.supermd-theme.json");nameFilters:["Theme files (*.json)"];onAccepted:studio.exportCustomTheme(selectedFile.toString()) }
    // Qt's chrome never scales. Keyboard/pinch zoom is routed to the content pane.

    header: Column {
        visible: !viewState.fullscreen && !viewState.imageOverlay && viewState.settings.welcomed
        width: parent.width
        Rectangle { width: parent.width; height: window.SafeArea.margins.top; color: viewState.colors["surface-low"] }
        Pane {
            width: parent.width
            padding: 12
            background: ThemeSurface { area:"toolbar" }
            RowLayout {
                anchors.fill: parent
                spacing: 8
                SidebarToggle { expanded: sidebar; onClicked: sidebar = !sidebar }
                ActionButton { glyph: "FolderOpen"; ToolTip.text: "Open folder"; Accessible.name: "Open folder"; onClicked: studio.chooseFolder() }
                ActionButton { text: window.width < 1060 ? "" : "Open note"; glyph: "File"; ToolTip.text: window.hintWithShortcut("Open note", "open"); onClicked: openDialog.open() }
                ActionButton { glyph: "FloppyDisk"; ToolTip.text: window.hintWithShortcut("Save note", "save"); onClicked: studio.saveSafely(); enabled: !viewState.busy }
                ActionButton { glyph: "Undo"; ToolTip.text: window.hintWithShortcut("Undo", "undo"); onClicked: studio.command("undo") }
                ActionButton { glyph: "Redo"; ToolTip.text: window.hintWithShortcut("Redo", "redo"); onClicked: studio.command("redo") }
                Item {
                    Layout.fillWidth: true; Layout.fillHeight: true
                    DragHandler { enabled: studio.fedoraWindowFrame; target: null; onActiveChanged: if (active) window.startSystemMove() }
                    TapHandler { enabled: studio.fedoraWindowFrame; onDoubleTapped: window.visibility === Window.Maximized ? window.showNormal() : window.showMaximized() }
                }
                ActionButton { objectName: "findInNoteButton"; glyph: "MagnifyingGlass"; ToolTip.text: window.hintWithShortcut("Find in note", "find"); onClicked: window.openFind() }
                ActionButton { visible: window.width >= 1060; glyph: "Image"; ToolTip.text: "Insert image or link"; onClicked: studio.command("insert") }
                ActionButton { visible: window.width >= 1060; glyph: "Bug"; ToolTip.text: "Fix LaTeX"; onClicked: studio.command("repair") }
                ActionButton { visible: window.width >= 1060; glyph: "ShareNetwork"; ToolTip.text: "Share note"; onClicked: window.showExport(true) }
                ActionButton {
                    objectName: "moreActionsButton"; glyph: "More"; ToolTip.text: "More note actions"; onClicked: noteActions.popup()
                    NoteContextMenu {
                        id: noteActions
                        objectName: "compactNoteActions"
                        implicitWidth: 250
                        NoteMenuItem { objectName: "reopenClosedTabAction"; text: "Reopen closed tab"; shortcutText: typeof window.shortcutLabels !== "undefined" ? (window.shortcutLabels.reopen_tab || "") : ""; icon.source: "../icons/Undo.svg"; enabled: typeof viewState !== "undefined" ? Boolean(viewState.closedCount) : true; onTriggered: studio.reopenTab() }
                        NoteMenuItem { objectName: "saveAsAction"; text: "Save as"; shortcutText: typeof window.shortcutLabels !== "undefined" ? (window.shortcutLabels.save_as || "") : ""; icon.source: "../icons/FloppyDisk.svg"; enabled: typeof viewState !== "undefined" ? !viewState.busy : true; onTriggered: studio.saveAsSafely() }
                        NoteMenuItem { objectName: "quickSwitcherAction"; text: "Quick switcher"; shortcutText: typeof window.shortcutLabels !== "undefined" ? (window.shortcutLabels.quick_switcher || "") : ""; icon.source: "../icons/File.svg"; onTriggered: studio.openQuickSwitcher() }
                        NoteMenuItem { text: "Insert image or link"; actionVisible: window.width < 1060; icon.source: "../icons/Image.svg"; onTriggered: studio.command("insert") }
                        NoteMenuItem { text: "Fix LaTeX"; actionVisible: window.width < 1060; icon.source: "../icons/Bug.svg"; onTriggered: studio.command("repair") }
                        NoteMenuItem { text: "Share note"; actionVisible: window.width < 1060; icon.source: "../icons/ShareNetwork.svg"; onTriggered: window.showExport(true) }
                    }
                }
                ActionButton { text: window.width < 1060 ? "" : "Export"; glyph: "Export"; ToolTip.text: "Export note"; prominent: true; enabled: !viewState.busy; onClicked: window.showExport(false) }
                ActionButton { objectName: "settingsButton"; glyph: "GearSix"; ToolTip.text: window.hintWithShortcut("Settings", "settings"); onClicked: settingsOpen = !settingsOpen }
                WindowControls { visible: studio.showToolbarWindowControls; host: window; colors: viewState.colors; Layout.preferredWidth: 124; Layout.preferredHeight: 36; Layout.alignment: Qt.AlignVCenter; onCloseRequested: studio.closeWindowSafely() }
            }
        }
        TabStrip {
            width: parent.width; viewState: window.viewState; tabs: window.tabsState; activeTabId: window.activeTabId; shortcutLabels: window.shortcutLabels
        }
        Rectangle { width: parent.width; height: 1; color: viewState.colors.outline; opacity: .55 }
    }
    SplitView {
        anchors.fill: parent
        orientation: Qt.Horizontal
        handle: Rectangle { implicitWidth: 6; color: window.viewState.colors["surface-low"]; Rectangle { anchors.horizontalCenter: parent.horizontalCenter; width: SplitHandle.pressed || SplitHandle.hovered ? 3 : 1; height: parent.height; color: SplitHandle.pressed || SplitHandle.hovered ? window.Material.primary : window.viewState.colors.outline } }
        WorkspaceSidebar {
            id: folderSidebar; visible: sidebar && !viewState.fullscreen && !viewState.imageOverlay
            viewState: window.viewState; tabsState: window.tabsState; activeTabId: window.activeTabId; sidebarState: window.sidebarState; shortcutLabels: window.shortcutLabels
            section: window.sidebarSection; onSectionEdited: value => window.sidebarSection = value
        }
        Item {
            SplitView.fillWidth: true
            ColumnLayout {
                anchors.fill: parent
                spacing: 0
                ModeZoomBar {
                    visible: !viewState.fullscreen && !viewState.imageOverlay; Layout.fillWidth: true
                    viewState: window.viewState; wide: window.width >= 1000; modeChoices: window.modeChoices(window.width >= 1000); fullscreenHintText: window.fullscreenHint(); onEnterFullscreen: windowModes.setFullscreen(true)
                }
                Pane {
                    id: conflictBanner
                    objectName: "conflictBanner"
                    visible: Boolean(viewState.conflict) && !viewState.imageOverlay
                    Layout.fillWidth: true
                    leftPadding: 16
                    rightPadding: 16
                    topPadding: viewState.fullscreen && studyToolbar.visible && studyToolbar.shown ? studyToolbar.height + 10 : 10
                    bottomPadding: 10
                    background: Rectangle {
                        color: viewState.colors["surface-high"]
                        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: viewState.colors.outline; opacity: .55 }
                    }
                    contentItem: RowLayout {
                        spacing: 10
                        ToolButton {
                            enabled: false
                            focusPolicy: Qt.NoFocus
                            padding: 0
                            background: null
                            icon.source: "../icons/Warning.svg"
                            icon.color: viewState.colors.primary
                            icon.width: 20
                            icon.height: 20
                            Layout.preferredWidth: 24
                            Layout.preferredHeight: 24
                            Layout.alignment: Qt.AlignVCenter
                        }
                        Label {
                            objectName: "conflictBannerLabel"
                            text: "This file changed on disk. Autosave is paused so your draft isn't overwritten."
                            color: viewState.colors.text
                            font.pixelSize: 13
                            font.weight: Font.Medium
                            wrapMode: Text.WordWrap
                            Layout.fillWidth: true
                            Layout.alignment: Qt.AlignVCenter
                        }
                        ActionButton {
                            objectName: "conflictSaveAsButton"
                            text: "Save as"
                            glyph: "FloppyDisk"
                            compact: true
                            prominent: true
                            enabled: !viewState.busy
                            onClicked: studio.resolveConflict("save_as")
                        }
                        ActionButton {
                            objectName: "conflictReloadButton"
                            text: "Reload from disk"
                            glyph: "ArrowClockwise"
                            compact: true
                            tonal: true
                            enabled: !viewState.busy
                            onClicked: studio.resolveConflict("reload")
                        }
                        ActionButton {
                            objectName: "conflictOverwriteButton"
                            text: "Overwrite"
                            compact: true
                            tonal: true
                            enabled: !viewState.busy
                            onClicked: studio.resolveConflict("overwrite")
                        }
                    }
                }
                Loader {
                    id: readerLoader
                    objectName: "documentReaderLoader"
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    active: window.readerActivated
                    sourceComponent: readerComponent
                    onItemChanged: window.readerViewChanged(item)
                }
                Component {
                    id: readerComponent
                    WebEngineView {
                    objectName: "documentReader"
                    anchors.fill: parent
                    backgroundColor: window.color
                    webChannel: WebChannel { id: documentChannel; Component.onCompleted: registerObject("studio", studio) }
                    settings.localContentCanAccessRemoteUrls: false
                    settings.localContentCanAccessFileUrls: false
                    settings.javascriptCanOpenWindows: false
                    settings.fullScreenSupportEnabled: false
                    onContextMenuRequested: function(request) {
                        request.accepted = true
                        readerContextMenu.selectionText = request.selectedText
                        readerContextMenu.editFlags = request.editFlags
                        readerContextMenu.hasLink = request.linkUrl.toString().length > 0
                        const x = request.position.x, y = request.position.y
                        window.reader.runJavaScript("({handled: Boolean(window.supermdMediaMenuAt && window.supermdMediaMenuAt(" + x + "," + y + ")), text: typeof window.supermdSelectedText === 'function' ? window.supermdSelectedText() : null})", function(result) {
                            const handled = Boolean(result && result.handled)
                            if (result && typeof result.text === "string") readerContextMenu.selectionText = result.text
                            if (!handled) readerContextMenu.popup(x, y)
                        })
                    }
                    NoteContextMenu {
                        id: readerContextMenu
                        objectName: "readerContextMenu"
                        property string selectionText: ""
                        property int editFlags: 0
                        property bool hasLink: false
                        NoteMenuItem { text: "Undo"; shortcutText: window.shortcutLabels.undo || ""; actionVisible: Boolean(readerContextMenu.editFlags & ContextMenuRequest.CanUndo); onTriggered: window.reader.triggerWebAction(WebEngineView.Undo) }
                        NoteMenuItem { text: "Redo"; shortcutText: window.shortcutLabels.redo || ""; actionVisible: Boolean(readerContextMenu.editFlags & ContextMenuRequest.CanRedo); onTriggered: window.reader.triggerWebAction(WebEngineView.Redo) }
                        NoteMenuItem { text: "Cut"; shortcutText: window.shortcutLabels.cut || ""; actionVisible: Boolean(readerContextMenu.editFlags & ContextMenuRequest.CanCut); onTriggered: window.reader.triggerWebAction(WebEngineView.Cut) }
                        NoteMenuItem { text: "Copy"; shortcutText: window.shortcutLabels.copy || ""; enabled: Boolean(readerContextMenu.editFlags & ContextMenuRequest.CanCopy) || readerContextMenu.selectionText.trim().length > 0; onTriggered: { window.reader.forceActiveFocus(); window.reader.triggerWebAction(WebEngineView.Copy) } }
                        NoteMenuItem { text: "Paste"; shortcutText: window.shortcutLabels.paste || ""; actionVisible: Boolean(readerContextMenu.editFlags & ContextMenuRequest.CanPaste); onTriggered: window.reader.triggerWebAction(WebEngineView.Paste) }
                        NoteMenuItem { text: "Copy link address"; actionVisible: readerContextMenu.hasLink; onTriggered: window.reader.triggerWebAction(WebEngineView.CopyLinkToClipboard) }
                        NoteMenuItem { text: "Select all"; shortcutText: window.shortcutLabels.select_all || ""; onTriggered: window.reader.triggerWebAction(WebEngineView.SelectAll) }
                        MenuSeparator {}
                        NoteMenuItem { objectName: "reloadMenuItem"; text: "Reload"; enabled: viewState.readerReady && !viewState.busy; onTriggered: studio.reloadReaderSafely() }
                        MenuSeparator { visible: readerContextMenu.selectionText.trim().length > 0; height: visible ? implicitHeight : 0 }
                        NoteMenuItem { text: "Search Google"; actionVisible: readerContextMenu.selectionText.trim().length > 0; onTriggered: studio.selectionAction("google", readerContextMenu.selectionText) }
                        NoteMenuItem { text: "Ask " + (studio.selectionAssistantLabel || "ChatGPT") + "…"; actionVisible: readerContextMenu.selectionText.trim().length > 0; onTriggered: studio.selectionAction("assistant", readerContextMenu.selectionText) }
                    }
                    MouseArea {
                        objectName: "readerWheelOverlay"
                        anchors.fill: parent
                        z: 1
                        acceptedButtons: Qt.NoButton
                        onWheel: function(event) {
                            // Stack above QtWebEngine's internal Chromium child item so Qt
                            // retains the device's pixel deltas before Chromium consumes them,
                            // while acceptedButtons: Qt.NoButton leaves clicks/drags/menus untouched.
                            if (event.modifiers & (Qt.ControlModifier | Qt.MetaModifier)) {
                                // Consume before Chromium applies browser zoom:
                                // resetting zoomFactor afterward flashes a stale scale.
                                event.accepted = true
                                const dy = event.pixelDelta.y || event.angleDelta.y
                                reader.runJavaScript("window.supermdNativeWheel?.(0," + (-dy) + "," + JSON.stringify({x:event.x,y:event.y}) + ",true,true)")
                            } else if (event.pixelDelta.x || event.pixelDelta.y || (event.buttons & Qt.LeftButton)) {
                                event.accepted = true
                                // The reader gives text drags priority over held-button zoom.
                                const held = Boolean(event.buttons & Qt.LeftButton)
                                const hasPixelDelta = Boolean(event.pixelDelta.x || event.pixelDelta.y)
                                const dx = hasPixelDelta ? event.pixelDelta.x : event.angleDelta.x
                                const dy = hasPixelDelta ? event.pixelDelta.y : event.angleDelta.y
                                reader.runJavaScript("window.supermdNativeWheel?.(" + (-dx) + "," + (-dy) + "," + JSON.stringify({x:event.x,y:event.y}) + "," + held + ")")
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
                    onRenderProcessTerminated: function(terminationStatus, exitCode) {
                        // Do not log renderer diagnostics or document data.
                        console.warn("Qt reader recovery: renderer terminated", terminationStatus, exitCode)
                        window.handleReaderCrash(terminationStatus)
                    }
                    onZoomFactorChanged: {
                        if (Math.abs(zoomFactor - 1) > .001) {
                            const factor = zoomFactor
                            zoomFactor = 1
                            runJavaScript("if (window.dispatchEvent(new CustomEvent('supermd-chart-native-zoom',{detail:" + factor + ",cancelable:true}))) window.supermdZoomBy?.(" + factor + ")")
                        }
                    }
                    onNavigationRequested: function(request) {
                        const target = request.url.toString()
                        if (!request.isMainFrame) {
                            if (target === "about:blank") return
                            const readerBase = readerUrl.toString().replace(/\/[^/]*([?#].*)?$/, "")
                            const rel = target.startsWith(readerBase) ? target.slice(readerBase.length) : ""
                            if (/^\/assets\/mermaid-sandbox-[A-Za-z0-9_-]+\.html$/.test(rel) || rel === "/@mermaid-sandbox.html") return
                            request.reject()
                            return
                        }
                        if (window.readerRecoveryLoading && target === "about:blank") return
                        if (target.split("#")[0] !== readerUrl.toString()) {
                            request.reject()
                            if (target.startsWith("https://") || target.startsWith("http://") || target.startsWith("mailto:")) Qt.openUrlExternally(request.url)
                        }
                    }
                    }
                }
            }
            StudyControls {
                id: studyToolbar; anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
                visible: viewState.fullscreen && !viewState.readerOverlay; awake: window.chromeAwake; noteName: viewState.name; shortcutLabels: window.shortcutLabels
                ready: viewState.readerReady && !viewState.busy; centerLocked: viewState.settings.centerLock
                onCenterLockRequested: studio.setting("centerLock",JSON.stringify(!viewState.settings.centerLock))
                onContentsRequested: contentsPopup.open(); onExitRequested: windowModes.setFullscreen(false); onSaveRequested: studio.saveSafely(); onExportRequested: window.showExport(false)
            }
            FullscreenStatusBanner {
                id: fullscreenStatusBanner; anchors.horizontalCenter: parent.horizontalCenter; anchors.bottom: parent.bottom; anchors.bottomMargin: 20
                maxWidth: Math.min(680, Math.max(180, parent.width - 48)); footerHidden: (viewState.fullscreen || viewState.imageOverlay) && viewState.readerReady
                busy: Boolean(viewState.busy); message: viewState.message || ""; messageRevision: viewState.messageRevision || 0
            }
            Rectangle {
                objectName: "readerLoadingOverlay"
                anchors.fill: parent
                visible: !viewState.readerReady
                color: viewState.colors.surface
                Column {
                    anchors.centerIn: parent; spacing: 16
                    ExpressiveLoading { visible: !readerRecoveryExhausted; anchors.horizontalCenter: parent.horizontalCenter }
                    Label { text: readerRecoveryMessage || "Opening your workspace"; color: viewState.colors.muted; wrapMode: Text.WordWrap; horizontalAlignment: Text.AlignHCenter; width: Math.min(460, window.width - 80) }
                    ActionButton { visible: readerRecoveryExhausted; text: "Retry reader"; prominent: true; anchors.horizontalCenter: parent.horizontalCenter; onClicked: retryReaderManually() }
                }
            }
        }
    }
    ContentsPopup {
        id: contentsPopup; windowWidth: window.width; windowHeight: window.height; viewState: window.viewState; sidebarState: window.sidebarState
        onHeadingChosen: { window.chromeAwake = false; window.focusReader() }
    }
    AppDialog {
        id: settingsDialog
        objectName: "settingsDialog"; width: Math.min(840, window.width - 48); height: Math.min(760, window.height - 48); padding: 0
        onClosed: settingsOpen = false
        SettingsPage { ownerPopup: settingsDialog; viewState: window.viewState; anchors.fill: parent; onBack: settingsOpen = false }
    }
    footer: Pane {
        visible: !viewState.fullscreen && !viewState.imageOverlay
        padding: 6
        RowLayout { anchors.fill: parent; Label { textFormat:Text.PlainText; text: viewState.busy ? "Preparing document…" : viewState.message || "Local files. Automatic draft recovery."; elide: Text.ElideRight; Layout.fillWidth: true; color: viewState.colors.muted; font.pixelSize: 12 } ExpressiveLoading { running: viewState.busy; implicitHeight: 24; implicitWidth: 24 } }
    }
    FileDialog { id: openDialog; title: "Open note"; nameFilters: ["Notes (*.md *.smd *.fmd *.markdown *.txt)", "All files (*)"]; onAccepted: studio.openNote(selectedFile.toString()) }
    FolderDialog { id: folderDialog; title: "Open folder"; onAccepted: studio.openFolder(selectedFolder.toString()) }
    FolderDialog { id: noteFolderDialog; title: "Default location for new notes"; onAccepted: studio.setNoteLocation(selectedFolder.toString()) }
    Component {
        id: saveDestinationComponent
        FileDialog {
            property bool portableNote: false
            objectName: "saveDestination"
            title: "Save note"
            fileMode: FileDialog.SaveFile
            nameFilters: portableNote ? ["Portable Super MD (*.smd)", "Markdown (*.md)"] : ["Markdown (*.md)", "Portable Super MD (*.smd)"]
            onAccepted: { studio.saveAs(selectedFile.toString()); destroy() }
            onRejected: { studio.resolveClose("cancel"); destroy() }
        }
    }
    Component {
        id: exportDestinationComponent
        FileDialog {
            property string exportFormat: "pdf"
            objectName: "exportDestination"
            title: "Export note"
            fileMode: FileDialog.SaveFile
            defaultSuffix: exportFormat === "mdzip" ? "zip" : exportFormat
            nameFilters: exportFormat === "pdf" ? ["PDF (*.pdf)"] : exportFormat === "md" ? ["Markdown (*.md)"] : exportFormat === "mdzip" ? ["Markdown bundle (*.zip)"] : ["Portable Super MD (*.smd)"]
            onAccepted: { studio.exportTo(selectedFile.toString(), exportFormat); destroy() }
            onRejected: destroy()
        }
    }
    AppDialog {
        id: exportDialog
        objectName: "exportDialog"
        property var availableFormats: ["pdf", "smd", "md", "mdzip"]
        title: sharing ? "Share note" : "Export note"
        width: Math.min(window.width - 48, Math.max(500, Math.min(720, window.width * .44)))
        height: Math.min(window.height - 48, Math.max(460, Math.min(900, window.height * .85)))
        standardButtons: Dialog.Cancel
        ColumnLayout {
            anchors.fill: parent
            spacing: 16 * exportDialog.uiScale
            Label { text: sharing ? "Choose a format. Sharing availability depends on your desktop." : "PDF preserves the layout. Portable SMD includes editable Markdown and images."; wrapMode: Text.WordWrap; Layout.fillWidth: true }
            ChoiceField { Layout.fillWidth: true; Layout.minimumHeight: 48 * exportDialog.uiScale; font: exportDialog.font; visible: model.length > 1; model: exportDialog.availableFormats.map(format => format === "pdf" ? "PDF" : format === "smd" ? "Portable SMD" : format === "md" ? "Markdown" : "Markdown ZIP"); currentIndex: Math.max(0, exportDialog.availableFormats.indexOf(outputFormat)); onActivated: outputFormat = exportDialog.availableFormats[currentIndex] }
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
                    PdfControls { objectName: "exportPdfControls"; uiScale: exportDialog.uiScale; controlFont: exportDialog.font; ownerPopup: exportDialog; visible: outputFormat === "pdf"; Layout.fillWidth: true; viewportItem: exportScroll.contentItem; options: viewState.settings.pdf; onEdited: options => studio.setting("pdf", JSON.stringify(options)) }
                    Label { visible: outputFormat !== "pdf"; Layout.fillWidth: true; wrapMode: Text.WordWrap; text: outputFormat === "md" ? "Editable Markdown with raster images beside the file. Vector diagrams are embedded as SVG source." : outputFormat === "mdzip" ? "Obsidian-ready Markdown and images in one ZIP. Sliders become static figures; diagrams and charts become linked SVG images." : "A portable .smd keeps the editable Markdown and images together. Source mode never shows embedded image bytes." }
                }
            }
            ActionButton { text: sharing ? "Prepare share copy" : "Choose destination"; font: exportDialog.font; prominent: true; Layout.fillWidth: true; Layout.minimumHeight: 44 * exportDialog.uiScale; onClicked: window.chooseExportDestination() }
        }
        onOpened: {
            forceActiveFocus()
            Qt.callLater(() => exportScroll.contentItem.contentY = 0)
        }
    }
    AppDialog {
        id: closeDialog
        objectName: "closeDialog"
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
    AppDialog {
        id: saveConflictDialog
        objectName: "saveConflictDialog"
        width: 480
        closePolicy: Popup.NoAutoClose
        ColumnLayout {
            width: parent.width
            spacing: 20
            Label { text: "This note was modified outside Super MD since you opened or last saved it. Choose Save as to keep both versions, or Overwrite to replace the file on disk."; Layout.fillWidth: true; wrapMode: Text.WordWrap }
            RowLayout {
                ActionButton { objectName: "saveConflictCancelButton"; text: "Cancel"; onClicked: { saveConflictDialog.close(); studio.resolveConflict("cancel") } }
                ActionButton { objectName: "saveConflictOverwriteButton"; text: "Overwrite"; tonal: true; onClicked: { saveConflictDialog.close(); studio.resolveConflict("overwrite") } }
                ActionButton { objectName: "saveConflictSaveAsButton"; text: "Save as"; prominent: true; onClicked: { saveConflictDialog.close(); studio.resolveConflict("save_as") } }
            }
        }
    }
    AppDialog {
        id: flushDialog
        objectName: "flushDialog"
        property bool canClose: false
        title: "The document reader is busy"
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
    WelcomePane {
        visible: !viewState.settings.welcomed; host: window; backgroundColor: window.color; viewState: window.viewState
        onOpenNoteRequested: openDialog.open()
    }
    FolderSearchDialog { id: folderSearchDialog }
    QuickSwitcherDialog { id: quickSwitcherDialog }
}
