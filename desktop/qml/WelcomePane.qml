import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// A dedicated welcome surface rather than a stack of modal setup steps.
Pane {
    id: welcome
    required property var host
    required property color backgroundColor
    required property var viewState
    signal openNoteRequested()
    anchors.fill: parent
    padding: 40
    background: Rectangle { color: welcome.backgroundColor }
    WindowControls {
        visible: studio.fedoraWindowFrame
        anchors.right: parent.right
        anchors.top: parent.top
        host: welcome.host
        colors: welcome.viewState.colors
        onCloseRequested: studio.closeWindowSafely()
    }
    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(600, parent.width - 40)
        spacing: 24
        Image { source: studio.brand; sourceSize.width: 64; sourceSize.height: 64; Layout.preferredWidth: 64; Layout.preferredHeight: 64 }
        Label { text: "Your notes. More room to think."; font.pixelSize: 32; font.weight: Font.DemiBold; Layout.fillWidth: true; wrapMode: Text.WordWrap }
        Label { text: "Open a Markdown note, or keep images together in a portable .smd. No vault or import process."; Layout.fillWidth: true; wrapMode: Text.WordWrap; font.pixelSize: 17; opacity: .8 }
        ModeGroup { Layout.fillWidth: true; choices: [{key:"system",label:"System"},{key:"light",label:"Light"},{key:"dark",label:"Dark"},{key:"black",label:"Pure black"}]; selected: welcome.viewState.settings.theme; onChosen: key => studio.setting("theme", JSON.stringify(key)) }
        Switch { text: "Expressive motion"; checked: welcome.viewState.settings.motion; onToggled: studio.setting("motion", JSON.stringify(checked)) }
        Switch { text: "Add to Applications (experimental)"; visible: studio.desktopIntegrationAvailable; checked: welcome.viewState.settings.desktopIntegration; enabled: !studio.updateBusy; onToggled: studio.setDesktopIntegration(checked) }
        Label { text: "Optional per-user launcher and Open With support. Your default apps are unchanged."; visible: studio.desktopIntegrationAvailable; Layout.fillWidth: true; wrapMode: Text.WordWrap; opacity: .7 }
        RowLayout {
            ActionButton { text: "Open note"; prominent: true; onClicked: { studio.setting("welcomed", "true"); welcome.openNoteRequested() } }
            ActionButton { text: "Explore a sample"; onClicked: studio.setting("welcomed", "true") }
        }
        Label { text: "PDFs are typeset locally. Python runs only when you choose Run."; Layout.fillWidth: true; wrapMode: Text.WordWrap; opacity: .7 }
    }
}
