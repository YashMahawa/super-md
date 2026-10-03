import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: controls
    required property var options
    property var viewportItem: null
    signal edited(var options)
    spacing: 8
    function update(key, value) {
        const next = Object.assign({}, options)
        next[key] = value
        edited(next)
    }
    ColumnLayout {
        Layout.fillWidth: true; spacing: 4
        Label { text: "Page size" }
        ChoiceField { viewportItem: controls.viewportItem; Accessible.name: "PDF page size"; Layout.fillWidth: true; property var keys:["a3","a4","a5","a6","iso-b4","iso-b5","iso-b6","letter","legal","tabloid","executive"]; model: ["A3", "A4", "A5", "A6", "B4 (ISO)", "B5 (ISO)", "B6 (ISO)", "Letter", "Legal", "Tabloid", "Executive"]; currentIndex: keys.indexOf(controls.options.pageSize); onActivated: controls.update("pageSize", keys[currentIndex]) }
    }
    ColumnLayout {
        Layout.fillWidth: true; spacing: 4
        Label { text: "Document font" }
        FontField { objectName: "pdfFontChoice"; viewportItem: controls.viewportItem; Accessible.name: "PDF font"; Layout.fillWidth: true; families: studio.fonts; value: controls.options.fontFamily; onChosen: family => controls.update("fontFamily", family) }
    }
    ColumnLayout {
        Layout.fillWidth: true; spacing: 4
        Label { text: "Margins: " + Math.round(marginSlider.value) + " mm" }
        ExpressiveSlider { id: marginSlider; Layout.fillWidth: true; Layout.preferredHeight: 36; from: 4; to: 60; stepSize: 1; value: controls.options.margin; Accessible.name: "PDF margins"; onMoved: if (!pressed) controls.update("margin", value); onPressedChanged: if (!pressed) controls.update("margin", value) }
    }
    ColumnLayout {
        Layout.fillWidth: true; spacing: 4
        Label { text: "Text size: " + textSlider.value.toFixed(1) + " pt" }
        ExpressiveSlider { id: textSlider; Layout.fillWidth: true; Layout.preferredHeight: 36; from: 5; to: 24; stepSize: .5; value: controls.options.fontSize; Accessible.name: "PDF text size"; onMoved: if (!pressed) controls.update("fontSize", value); onPressedChanged: if (!pressed) controls.update("fontSize", value) }
    }
    ColumnLayout {
        Layout.fillWidth: true; spacing: 4
        Label { text: "Line spacing: " + spacingSlider.value.toFixed(2) }
        ExpressiveSlider { id: spacingSlider; Layout.fillWidth: true; Layout.preferredHeight: 36; from: .9; to: 2.2; stepSize: .05; value: controls.options.lineHeight; Accessible.name: "PDF line spacing"; onMoved: if (!pressed) controls.update("lineHeight", value); onPressedChanged: if (!pressed) controls.update("lineHeight", value) }
    }
    Label { text: "Paragraph spacing: " + paragraphSlider.value.toFixed(2) }
    ExpressiveSlider { id: paragraphSlider; Layout.fillWidth: true; from: 0; to: 3; stepSize: .1; value: controls.options.paragraphSpacing ?? 1.2; Accessible.name: "PDF paragraph spacing"; onMoved: if (!pressed) controls.update("paragraphSpacing", value); onPressedChanged: if (!pressed) controls.update("paragraphSpacing", value) }
    Switch { objectName: "pdfPageNumbers"; text: "Page numbers"; checked: controls.options.pageNumbers; onToggled: controls.update("pageNumbers", checked) }
    Switch { objectName: "pdfThemed"; text: "Light Material theme"; checked: controls.options.themed === true; onToggled: controls.update("themed", checked) }
    Label { text: "Off uses plain paper. On uses your accent with light surfaces, even in dark mode."; wrapMode: Text.WordWrap; Layout.fillWidth: true; color: JSON.parse(studio.snapshot).colors.muted }
}
