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
            Layout.fillWidth: true
            Layout.fillHeight: true
            contentWidth: availableWidth
            ColumnLayout {
                width: parent.width
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
                Label { text: "Text size: " + Math.round(viewState.settings.size) + " px" }
                ExpressiveSlider { Layout.fillWidth: true; from: 12; to: 32; stepSize: 1; value: viewState.settings.size; onMoved: page.save("size", value) }
                Switch { text: "Use full available reading width"; checked: viewState.settings.width === 0; onToggled: page.save("width", checked ? 0 : 1600) }
                Label { visible: viewState.settings.width !== 0; text: "Maximum width: " + viewState.settings.width + " px" }
                ExpressiveSlider { visible: viewState.settings.width !== 0; Layout.fillWidth: true; from: 600; to: 4000; stepSize: 50; value: viewState.settings.width || 1600; onMoved: page.save("width", value) }
                Label { text: "Python"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.topMargin: 12 }
                Label { text: "Interpreter or virtual environment Python executable" }
                TextField { Layout.fillWidth: true; text: viewState.settings.python; selectByMouse: true; onEditingFinished: page.save("python", text) }
                Label { text: "Code runs only when you press Run. Use a Python environment with matplotlib installed. Local Python code is not sandboxed."; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: viewState.colors.muted }
                Label { text: "PDF defaults"; font.pixelSize: 22; font.weight: Font.DemiBold; Layout.topMargin: 12 }
                Label { text: "Page size" }
                ChoiceField { viewportItem: settingsScroll.contentItem; Accessible.name: "PDF page size"; Layout.fillWidth: true; model: ["a4", "a5", "letter", "legal"]; currentIndex: model.indexOf(viewState.settings.pdf.pageSize); onActivated: { const options = Object.assign({}, viewState.settings.pdf); options.pageSize = currentText; page.save("pdf", options) } }
                Label { text: "PDF font" }
                ChoiceField { viewportItem: settingsScroll.contentItem; Accessible.name: "PDF font"; Layout.fillWidth: true; model: ["Noto Sans", "Libertinus Serif", "New Computer Modern", "DejaVu Sans Mono"]; currentIndex: model.indexOf(viewState.settings.pdf.fontFamily); onActivated: { const options = Object.assign({}, viewState.settings.pdf); options.fontFamily = currentText; page.save("pdf", options) } }
                Label { text: "Margins: " + Math.round(viewState.settings.pdf.margin) + " mm" }
                ExpressiveSlider { Layout.fillWidth: true; from: 4; to: 60; stepSize: 1; value: viewState.settings.pdf.margin; onMoved: { const options = Object.assign({}, viewState.settings.pdf); options.margin = value; page.save("pdf", options) } }
                Label { text: "PDF text: " + viewState.settings.pdf.fontSize + " pt" }
                ExpressiveSlider { Layout.fillWidth: true; from: 7; to: 24; stepSize: .5; value: viewState.settings.pdf.fontSize; onMoved: { const options = Object.assign({}, viewState.settings.pdf); options.fontSize = value; page.save("pdf", options) } }
                Switch { text: "Page numbers"; checked: viewState.settings.pdf.pageNumbers; onToggled: { const options = Object.assign({}, viewState.settings.pdf); options.pageNumbers = checked; page.save("pdf", options) } }
                Item { height: 24 }
            }
        }
    }
}
