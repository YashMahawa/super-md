import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts

Pane {
    id: page
    required property var viewState
    signal back()
    function save(key, value) { studio.setting(key, JSON.stringify(value)) }
    padding: 0
    background: null
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
                Label { text: "Interpreter or virtual environment Python executable" }
                TextField { Layout.fillWidth: true; text: viewState.settings.python; selectByMouse: true; onEditingFinished: page.save("python", text) }
                Label { text: "Code runs only when you press Run. Use a Python environment with matplotlib installed. Local Python code is not sandboxed."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
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
