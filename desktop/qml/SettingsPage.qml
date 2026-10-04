import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts

Pane {
    id: page
    required property var viewState
    signal back()
    readonly property bool pythonReady: JSON.parse(studio.pythonChoices).some(choice => choice.matplotlib)
    function save(key, value) { studio.setting(key, JSON.stringify(value)) }
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
                ChoiceField { Layout.fillWidth: true; model: ["System accent", "Blue", "Violet", "Rose", "Amber"]; currentIndex: ["system","blue","violet","rose","amber"].indexOf(viewState.settings.accent); onActivated: page.save("accent",["system","blue","violet","rose","amber"][currentIndex]) }
                Label { text: "System uses your desktop accent when available; otherwise app blue. Choose a color independently of light or dark mode."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Switch { text: "Expressive motion"; checked: viewState.settings.motion; onToggled: page.save("motion", checked) }
                Label { text: "Reading"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.topMargin: 12 }
                Label { text: "Reading font" }
                FontField { objectName: "readingFontChoice"; viewportItem: settingsScroll.contentItem; Accessible.name: "Reading font"; Layout.fillWidth: true; families: studio.fonts; value: viewState.settings.font; onChosen: family => page.save("font", family) }
                ActionButton { text:"Import font…";glyph:"Plus";onClicked:studio.chooseFont() }
                Label { text:"TTF and OTF fonts stay private to the app and also appear in PDF export and sharing."; Layout.fillWidth:true;wrapMode:Text.WordWrap;color:viewState.colors.muted }
                Label { text: "Text size: " + Math.round(viewState.settings.size) + " px" }
                ExpressiveSlider { Layout.fillWidth: true; from: 6; to: 32; stepSize: 1; value: viewState.settings.size; onMoved: page.save("size", value) }
                Label { text: "Reading width: " + Math.round(viewState.settings.widthPercent) + "%" }
                ExpressiveSlider { Layout.fillWidth: true; from: 50; to: 100; stepSize: 1; value: viewState.settings.widthPercent; onMoved: page.save("widthPercent", value) }
                Label { text: "Adapts to this window and fullscreen, without a fixed pixel limit."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: "Vertical spacing: " + viewState.settings.lineHeight.toFixed(2) }
                ExpressiveSlider { Layout.fillWidth: true; from: 1.15; to: 2.2; stepSize: .05; value: viewState.settings.lineHeight; onMoved: page.save("lineHeight", value) }
                Switch { text: "Autosave existing notes"; checked: viewState.settings.autosave; onToggled: page.save("autosave", checked) }
                Label { text: "New note location"; font.weight: Font.DemiBold }
                ActionButton { Layout.fillWidth: true; text: viewState.settings.newNoteLocation || "Downloads"; glyph: "FolderOpen"; tonal: true; onClicked: studio.chooseNoteLocation(); ToolTip.text: viewState.settings.newNoteLocation || "Downloads" }
                Label { text: "New notes stay recoverable until you choose a file. Empty untitled notes are discarded."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: "Writing assistance"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.topMargin: 12 }
                Switch { text: "Spell check"; checked: viewState.settings.spellCheck; onToggled: page.save("spellCheck", checked) }
                Switch { text: "Grammar check"; checked: viewState.settings.grammarCheck; onToggled: page.save("grammarCheck", checked) }
                Label { text: "Offline English suggestions in Source and Live editing. Grammar checks repeated words and a/an. Code, links and LaTeX are excluded; no text is uploaded or automatically replaced."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
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
                Label { text: "Downloads are verified. Installation is your choice; running windows and notes are never replaced. Linux downloads a portable AppImage; package-managed installs can use the release packages."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: studio.updateStatus; visible: text.length > 0; Layout.fillWidth: true; wrapMode: Text.WordWrap }
                RowLayout {
                    ActionButton { text: "Check for updates"; tonal: true; onClicked: studio.checkUpdates() }
                    ActionButton { text: studio.updateReady ? "Open installer" : "Download update"; visible: studio.updateAvailable; prominent: true; onClicked: studio.updateReady ? studio.installUpdate() : studio.downloadUpdate() }
                }
                Item { height: 24 }
            }
        }
    }
}
