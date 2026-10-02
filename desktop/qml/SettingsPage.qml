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
                Switch { text: "Expressive motion"; checked: viewState.settings.motion; onToggled: page.save("motion", checked) }
                Label { text: "Reading"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.topMargin: 12 }
                Label { text: "Reading font" }
                ChoiceField { objectName: "readingFontChoice"; viewportItem: settingsScroll.contentItem; Accessible.name: "Reading font"; Layout.fillWidth: true; model: studio.fonts; editable: true; currentIndex: model.indexOf(viewState.settings.font); onActivated: page.save("font", currentText); onAccepted: page.save("font", editText) }
                ActionButton { text:"Import font…";glyph:"Plus";onClicked:studio.chooseFont() }
                Label { text:"TTF and OTF fonts stay private to the app and also appear in PDF export and sharing."; Layout.fillWidth:true;wrapMode:Text.WordWrap;color:viewState.colors.muted }
                Label { text: "Text size: " + Math.round(viewState.settings.size) + " px" }
                ExpressiveSlider { Layout.fillWidth: true; from: 12; to: 32; stepSize: 1; value: viewState.settings.size; onMoved: page.save("size", value) }
                Label { text: "Reading width: " + Math.round(viewState.settings.widthPercent) + "%" }
                ExpressiveSlider { Layout.fillWidth: true; from: 50; to: 100; stepSize: 1; value: viewState.settings.widthPercent; onMoved: page.save("widthPercent", value) }
                Label { text: "Adapts to this window and fullscreen, without a fixed pixel limit."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: "Vertical spacing: " + viewState.settings.lineHeight.toFixed(2) }
                ExpressiveSlider { Layout.fillWidth: true; from: 1.15; to: 2.2; stepSize: .05; value: viewState.settings.lineHeight; onMoved: page.save("lineHeight", value) }
                Switch { text: "Autosave existing notes"; checked: viewState.settings.autosave; onToggled: page.save("autosave", checked) }
                Label { text: "New notes stay recoverable until you choose a file. Empty untitled notes are discarded."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: "Python"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.topMargin: 12 }
                Label { text: "Interpreter or virtual environment Python executable" }
                TextField { Layout.fillWidth: true; text: viewState.settings.python; selectByMouse: true; onEditingFinished: page.save("python", text) }
                Label { text: "Code runs only when you press Run. Use a Python environment with matplotlib installed. Local Python code is not sandboxed."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: "PDF defaults"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.topMargin: 12 }
                PdfControls { Layout.fillWidth: true; viewportItem: settingsScroll.contentItem; options: viewState.settings.pdf; onEdited: options => page.save("pdf", options) }
                Item { height: 24 }
            }
        }
    }
}
