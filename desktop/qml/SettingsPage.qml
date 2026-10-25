import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts

Pane {
    id: page
    required property var viewState
    property var ownerPopup: null
    signal back()
    readonly property bool pythonReady: JSON.parse(studio.pythonChoices).some(choice => choice.matplotlib)
    readonly property var storageSummary: JSON.parse(studio.storageReport)
    function save(key, value) { studio.setting(key, JSON.stringify(value)) }
    function formatBytes(value) {
        if (value < 1024) return value + " B"
        if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB"
        if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " MB"
        return (value / (1024 * 1024 * 1024)).toFixed(2) + " GB"
    }
    padding: 0
    background: null
    Component.onCompleted: studio.refreshPython()
    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 28
        spacing: 20
        RowLayout {
            Label { text: "Settings"; font.pixelSize: 30; font.weight: Font.DemiBold; Layout.fillWidth: true }
            ActionButton { glyph: "X"; ToolTip.text: "Close settings"; onClicked: page.back() }
        }
        ScrollView {
            id: settingsScroll
            objectName: "settingsScroll"
            Layout.fillWidth: true
            Layout.fillHeight: true
            contentWidth: availableWidth
            rightPadding: 24
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
            ScrollBar.vertical: ExpressiveScrollBar { parent: settingsScroll; x: settingsScroll.width - width; y: 0; height: settingsScroll.height }
            ColumnLayout {
                width: settingsScroll.availableWidth
                spacing: 16
                Label { text: "Appearance"; font.pixelSize: 22; font.weight: Font.DemiBold }
                Label { text: "System follows your desktop colors. Fullscreen can have a different theme."; wrapMode: Text.WordWrap; Layout.fillWidth: true; color: viewState.colors.muted }
                Label { text: "Workspace theme" }
                ModeGroup { Layout.fillWidth: true; choices: [{key:"system",label:"System"},{key:"light",label:"Light"},{key:"dark",label:"Dark"},{key:"black",label:"Pure black"}]; selected: viewState.settings.theme; onChosen: key => page.save("theme", key) }
                Label { text: "Fullscreen theme" }
                ModeGroup { Layout.fillWidth: true; choices: [{key:"system",label:"System"},{key:"light",label:"Light"},{key:"dark",label:"Dark"},{key:"black",label:"Pure black"}]; selected: viewState.settings.fullTheme; onChosen: key => page.save("fullTheme", key) }
                Label { text: "Theme color" }
                ChoiceField { Layout.fillWidth: true; enabled:!studio.customThemeActive; model: ["System accent", "Blue", "Violet", "Rose", "Amber"]; currentIndex: ["system","blue","violet","rose","amber"].indexOf(viewState.settings.accent); onActivated: page.save("accent",["system","blue","violet","rose","amber"][currentIndex]) }
                Label { text: studio.customThemeActive ? "The imported theme supplies its palette. Reset to built-in below to use this accent picker." : "System uses your desktop accent when available; otherwise app blue. Choose a color independently of light or dark mode."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Switch { text: "Expressive motion"; checked: viewState.settings.motion; onToggled: page.save("motion", checked) }
                Label { text: "Custom theme"; font.pixelSize:22; font.weight:Font.DemiBold; Layout.topMargin:12 }
                Label { text:studio.customThemeName; textFormat:Text.PlainText; Layout.fillWidth:true; font.weight:Font.DemiBold }
                Label { text:"Editable theme files style controls, reading colors, typography and background patterns. Your reading font and text size remain yours. Invalid edits keep the last valid theme."; Layout.fillWidth:true; wrapMode:Text.WordWrap; color:viewState.colors.muted }
                Flow {
                    Layout.fillWidth:true;spacing:8
                    ActionButton { text:"Import theme…";glyph:"FolderOpen";tonal:true;onClicked:studio.chooseCustomTheme() }
                    ActionButton { text:studio.customThemeActive ? "Export theme…" : "Export template…";glyph:"Export";tonal:true;onClicked:studio.chooseThemeExport() }
                    ActionButton { text:"Share theme…";glyph:"ShareNetwork";visible:studio.customThemeActive;tonal:true;onClicked:studio.chooseThemeExport();ToolTip.text:"Save a portable theme file to send to another device" }
                    ActionButton { text:"Authoring guide";enabled:viewState.readerReady===true;onClicked:{if(page.ownerPopup)page.ownerPopup.close();studio.openThemeGuide();const host=page.Window.window;if(host&&typeof host.focusReader==="function")host.focusReader()} }
                    ActionButton { text:"Edit theme file";visible:studio.customThemeActive;onClicked:studio.editCustomTheme() }
                    ActionButton { text:"Reload";visible:studio.customThemeActive;onClicked:studio.reloadCustomTheme() }
                    ActionButton { text:"Reset to built-in";visible:studio.customThemeActive;onClicked:studio.resetCustomTheme() }
                }
                ColumnLayout {
                    visible:studio.customThemeActive
                    Layout.fillWidth:true;spacing:12
                    Label { text:"Reading background";font.weight:Font.DemiBold }
                    ChoiceField { Layout.fillWidth:true;model:["None","Cat paws","Dots","Grid","Diagonal","Gradient"];currentIndex:["none","paws","dots","grid","diagonal","gradient"].indexOf(studio.themeBackground.pattern);onActivated:page.save("patternKind",["none","paws","dots","grid","diagonal","gradient"][currentIndex]) }
                    Label { text:"Visibility: "+Math.round(studio.themeBackground.opacity*100)+"%" }
                    ExpressiveSlider { Layout.fillWidth:true;from:0;to:.25;stepSize:.01;value:studio.themeBackground.opacity;onMoved:page.save("patternOpacity",value) }
                    Label { visible:studio.themeBackground.pattern==="paws";text:"Paw size: "+Math.round(studio.themeBackground.size)+" px" }
                    ExpressiveSlider { visible:studio.themeBackground.pattern==="paws";Layout.fillWidth:true;from:8;to:64;stepSize:1;value:studio.themeBackground.size;onMoved:page.save("patternSize",value) }
                    Label { visible:studio.themeBackground.pattern!=="gradient";text:"Pattern spacing: "+Math.round(studio.themeBackground.spacing)+" px" }
                    ExpressiveSlider { visible:studio.themeBackground.pattern!=="gradient";Layout.fillWidth:true;from:12;to:192;stepSize:1;value:studio.themeBackground.spacing;onMoved:page.save("patternSpacing",value) }
                    Label { text:"Viewing only. These controls leave your theme file, notes and PDF exports unchanged.";Layout.fillWidth:true;wrapMode:Text.WordWrap;color:viewState.colors.muted }
                    ActionButton { text:"Use theme's background settings";onClicked:studio.resetThemeBackground() }
                }
                Label { text: "Images & diagrams"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.topMargin: 12 }
                Label { text: "Auto adapts neutral ink and paper, preserving readable colours. Theme monochrome recolours the whole image. Separation keeps original colours and adds a readable backing and edge. Original files and PDF exports are unchanged."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: "Image appearance" }
                ChoiceField { Layout.fillWidth: true; model: ["Original (off)","Invert in dark themes","Auto adapt to theme","Theme monochrome","Separate from theme"]; currentIndex: ["original","invert-dark","auto","monochrome","contrast"].indexOf(viewState.settings.imageAppearance); onActivated: page.save("imageAppearance",["original","invert-dark","auto","monochrome","contrast"][currentIndex]) }
                Label { text: "Diagram appearance (SVG, Mermaid & charts)" }
                ChoiceField { Layout.fillWidth: true; model: ["Original (off)","Invert in dark themes","Auto adapt to theme","Theme monochrome","Separate from theme"]; currentIndex: ["original","invert-dark","auto","monochrome","contrast"].indexOf(viewState.settings.svgAppearance); onActivated: page.save("svgAppearance",["original","invert-dark","auto","monochrome","contrast"][currentIndex]) }
                Label { text: "Separation strength: " + viewState.settings.imageContrast.toFixed(2) }
                ExpressiveSlider { Layout.fillWidth: true; from: 1; to: 2; stepSize: .05; value: viewState.settings.imageContrast; onMoved: page.save("imageContrast",value) }
                Label { text: "Reading"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.topMargin: 12 }
                Label { text: "Reading font" }
                FontField { objectName: "readingFontChoice"; ownerPopup: page.ownerPopup; viewportItem: settingsScroll.contentItem; Accessible.name: "Reading font"; Layout.fillWidth: true; families: studio.fonts; value: viewState.settings.font; onChosen: family => page.save("font", family) }
                ActionButton { text:"Import font…";glyph:"Plus";onClicked:studio.chooseFont() }
                Label { text:"TTF and OTF fonts stay private to the app and also appear in PDF export and sharing."; Layout.fillWidth:true;wrapMode:Text.WordWrap;color:viewState.colors.muted }
                Label { text: "Text size: " + Math.round(viewState.settings.size) + " px" }
                ExpressiveSlider { Layout.fillWidth: true; from: 6; to: 32; stepSize: 1; value: viewState.settings.size; onMoved: page.save("size", value) }
                Label { text: "Reading width: " + Math.round(viewState.settings.widthPercent) + "%" }
                ExpressiveSlider { Layout.fillWidth: true; from: 50; to: 150; stepSize: 1; value: viewState.settings.widthPercent; onMoved: page.save("widthPercent", value) }
                Label { text: "Adapts to this window and fullscreen, without a fixed pixel limit."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: "Vertical spacing: " + viewState.settings.lineHeight.toFixed(2) }
                ExpressiveSlider { Layout.fillWidth: true; from: 1.15; to: 2.2; stepSize: .05; value: viewState.settings.lineHeight; onMoved: page.save("lineHeight", value) }
                Switch { text: "Full document accessibility"; checked: viewState.settings.fullDocumentAccessibility; onToggled: page.save("fullDocumentAccessibility", checked) }
                Label { text: "Keeps the complete document in the semantic tree for assistive technology and browser Find. Large notes may use substantially more memory."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Switch { text: "Autosave existing notes"; checked: viewState.settings.autosave; onToggled: page.save("autosave", checked) }
                Switch { text: "Continue from the last reading position"; checked: viewState.settings.restorePosition; onToggled: page.save("restorePosition", checked) }
                Label { text: "On startup" }
                ChoiceField { Layout.fillWidth: true; model: ["Restore previous tabs","Open a new blank note"]; currentIndex: viewState.settings.startup === "new" ? 1 : 0; onActivated: page.save("startup", currentIndex === 1 ? "new" : "restore") }
                Label { text: "Unsaved drafts are recovered in either mode. Welcome is shown only on first use."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: "New note location"; font.weight: Font.DemiBold }
                ActionButton { Layout.fillWidth: true; text: viewState.settings.newNoteLocation || "Downloads"; glyph: "FolderOpen"; tonal: true; onClicked: studio.chooseNoteLocation(); ToolTip.text: viewState.settings.newNoteLocation || "Downloads" }
                Label { text: "New notes stay recoverable until you choose a file. Empty untitled notes are discarded."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: "Writing assistance"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.topMargin: 12 }
                Switch { text: "Spell check"; checked: viewState.settings.spellCheck; onToggled: page.save("spellCheck", checked) }
                Switch { text: "Grammar check"; checked: viewState.settings.grammarCheck; onToggled: page.save("grammarCheck", checked) }
                Switch { text: "LaTeX autofix on paste"; checked: viewState.settings.latexAutofix === true; onToggled: page.save("latexAutofix", checked) }
                Label { text: "Off by default. Repairs validated LaTeX errors in pasted text in Source, Split and Live. Existing code, links and formula fragments are protected; Undo restores the paste."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: "Offline English suggestions in Source and Live editing. Grammar checks repeated words and a/an. Code, links and LaTeX are excluded; no text is uploaded or automatically replaced."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: "Selected text"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.topMargin: 12 }
                ChoiceField { Layout.fillWidth: true; Accessible.name: "Selection assistant"; model: ["ChatGPT", "Gemini", "Claude"]; currentIndex: Math.max(0,["chatgpt","gemini","claude"].indexOf(viewState.settings.selectionAssistant)); onActivated: page.save("selectionAssistant",["chatgpt","gemini","claude"][currentIndex]) }
                Label { Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted; text: "Right-click selected text to search Google or ask this assistant. Ask copies the text and opens its site for you to paste and review, since prefill-only web links are not verified. It never submits a prompt automatically." }
                Label { text: "Python"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.topMargin: 12 }
                Label { text: "Code runs only when you press Run. Pick where it runs; numpy and matplotlib are needed for plots."; wrapMode: Text.WordWrap; Layout.fillWidth: true; color: viewState.colors.muted }
                Repeater {
                    id: pythonChoices
                    objectName: "pythonChoices"
                    model: JSON.parse(studio.pythonChoices)
                    delegate: ItemDelegate {
                        id: choice
                        required property var modelData
                        readonly property bool current: modelData.path === viewState.settings.python
                        Layout.fillWidth: true
                        implicitHeight: 64
                        leftPadding: 16
                        rightPadding: 16
                        Accessible.name: modelData.label + ", " + modelData.detail
                        background: Rectangle {
                            radius: choice.current ? 20 : 14
                            color: choice.current ? viewState.colors["primary-container"] : viewState.colors["surface-high"]
                            border.width: choice.visualFocus ? 2 : 0
                            border.color: viewState.colors.primary
                            Behavior on radius { enabled: viewState.settings.motion; NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
                            Rectangle { anchors.fill: parent; radius: parent.radius; color: viewState.colors.text; opacity: choice.down ? .1 : choice.hovered ? .05 : 0 }
                        }
                        contentItem: RowLayout {
                            spacing: 14
                            ToolButton { enabled: false; focusPolicy: Qt.NoFocus; padding: 0; background: null; icon.source: "../icons/" + (choice.current ? "CheckCircle" : (choice.modelData.matplotlib ? "Code" : "Warning")) + ".svg"; icon.color: choice.current ? viewState.colors["on-primary-container"] : viewState.colors.muted; icon.width: 22; icon.height: 22; Layout.preferredWidth: 28; Layout.preferredHeight: 28 }
                            ColumnLayout {
                                spacing: 2
                                Layout.fillWidth: true
                                Label { text: choice.modelData.label; font.weight: Font.DemiBold; color: choice.current ? viewState.colors["on-primary-container"] : viewState.colors.text; elide: Text.ElideRight; Layout.fillWidth: true }
                                Label { text: choice.modelData.detail; font.pixelSize: 12; color: choice.current ? viewState.colors["on-primary-container"] : viewState.colors.muted; elide: Text.ElideMiddle; Layout.fillWidth: true }
                            }
                        }
                        onClicked: page.save("python", modelData.path)
                    }
                }
                ActionButton {
                    // One tap for the selected environment when it lacks the plotting packages.
                    readonly property var selected: JSON.parse(studio.pythonChoices).find(choice => choice.path === viewState.settings.python)
                    visible: !!selected && !selected.matplotlib && selected.venv
                    objectName: "installPythonPackages"
                    text: "Install numpy + matplotlib here"; glyph: "DownloadSimple"; prominent: true; enabled: !studio.pythonBusy
                    onClicked: studio.installPythonPackages(viewState.settings.python)
                }
                Label { text: studio.pythonStatus; visible: text.length > 0; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.text }
                ExpressiveLoading { visible: studio.pythonBusy; Layout.preferredWidth: 48; Layout.preferredHeight: 48 }
                Flow {
                    Layout.fillWidth: true
                    spacing: 8
                    ActionButton { objectName: "setupPython"; text: "Set up Python"; glyph: "DownloadSimple"; prominent: !page.pythonReady; tonal: page.pythonReady; enabled: !studio.pythonBusy; ToolTip.text: "Creates a private Python environment with numpy and matplotlib"; onClicked: studio.setupPython() }
                    ActionButton { text: "Scan again"; glyph: "ArrowClockwise"; tonal: true; enabled: !studio.pythonBusy; onClicked: studio.refreshPython() }
                }
                Label { text: "Custom interpreter path"; Layout.topMargin: 4 }
                TextField { objectName: "pythonPath"; Layout.fillWidth: true; text: viewState.settings.python === "bundled" ? "" : viewState.settings.python; placeholderText: studio.pythonBundled ? "Using built-in Python" : "/path/to/venv/bin/python"; selectByMouse: true; onEditingFinished: if (text.trim().length && text.trim() !== viewState.settings.python) page.save("python", text.trim()) }
                Label { text: "Local Python is not sandboxed. Only run cells from notes you trust."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: "About & updates"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.topMargin: 12 }
                Label { text: "Super MD " + studio.appVersion + " · © Yash Mahawar · MIT License"; Layout.fillWidth: true; wrapMode: Text.WordWrap }
                Switch { text: "Check for updates on opening"; checked: viewState.settings.checkUpdates; onToggled: page.save("checkUpdates", checked) }
                Switch { text: "Automatically download updates"; checked: viewState.settings.autoUpdate; onToggled: page.save("autoUpdate", checked) }
                Label { text: "Verified installers are kept in Downloads and remembered between launches. Portable Linux updates are installed side-by-side for your next launch; previous versions stay recoverable. System packages use your package manager."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Switch { text: "Add to Applications (experimental)"; visible: studio.desktopIntegrationAvailable; checked: viewState.settings.desktopIntegration; enabled: !studio.updateBusy; onToggled: studio.setDesktopIntegration(checked) }
                Label { text: "Adds a per-user launcher and Open With entries. Off by default. Turning this off stops automatic registration; it does not remove an existing launcher or change file defaults."; visible: studio.desktopIntegrationAvailable; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: studio.updateStatus; visible: text.length > 0; Layout.fillWidth: true; wrapMode: Text.WordWrap }
                RowLayout {
                    ActionButton { text: "Check for updates"; tonal: true; enabled: !studio.updateBusy; onClicked: studio.checkUpdates() }
                    ActionButton { text: studio.updateReady ? "Install update" : "Download update"; visible: studio.updateAvailable; enabled: !studio.updateBusy; prominent: true; onClicked: studio.updateReady ? studio.installUpdate() : studio.downloadUpdate() }
                }
                Label { text: "App storage"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.topMargin: 12 }
                Label { text: "A read-only inventory of known Super MD app data. It does not scan notes, Downloads or your home folder."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Flow {
                    Layout.fillWidth: true
                    spacing: 8
                    ActionButton { objectName: "inspectAppStorage"; text: studio.storageBusy ? "Inspecting…" : "Inspect app storage"; glyph: "MagnifyingGlass"; tonal: true; enabled: !studio.storageBusy; onClicked: studio.inspectStorage() }
                    ActionButton { objectName: "cancelStorageInspection"; text: "Cancel"; visible: studio.storageBusy; onClicked: studio.cancelStorageInspection() }
                }
                Label {
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    color: viewState.colors.muted
                    text: studio.storageBusy ? "Scanning app-owned storage…" : page.storageSummary.status === "complete" ? "Inventory complete · " + page.storageSummary.scannedEntries + " entries checked" : page.storageSummary.status === "partial" ? "Partial inventory · some entries could not be checked or the scan was bounded/cancelled" : "No inventory has been run."
                }
                Repeater {
                    model: page.storageSummary.categories || []
                    delegate: RowLayout {
                        required property var modelData
                        Layout.fillWidth: true
                        spacing: 10
                        Label { text: modelData.label; Layout.fillWidth: true; wrapMode: Text.WordWrap; font.weight: Font.DemiBold }
                        Label { text: modelData.classification === "managed" ? "Managed" : "Preserved"; color: viewState.colors.muted }
                        Label { text: page.formatBytes(modelData.bytes) + " · " + modelData.files + " files"; color: viewState.colors.muted; horizontalAlignment: Text.AlignRight }
                    }
                }
                Label { text: "Recovery snapshots and Python execution results are preserved. This tool does not delete anything; no disposable app-managed cache is tracked or cleared."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Item { height: 24 }
            }
        }
    }
}
