import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material

// One painted surface, including with Qt Quick's software backend. The stock
// Material elevation effect can leave the body transparent while its separate
// header/footer still paint; its dark-mode scrim also washes the page white.
Dialog {
    id: control
    property var colors: studio.palette
    property bool motion: studio.motionEnabled
    property real uiScale: 1
    font.pixelSize: Math.round(14 * uiScale)
    readonly property var hostWindow: parent ? parent.Window.window : null
    property bool blockingHints: false
    parent: Overlay.overlay
    popupType: Popup.Item
    anchors.centerIn: parent
    modal: true
    dim: true
    focus: true
    closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
    width: Math.min(440, parent ? parent.width - 32 : 440)
    padding: 24 * uiScale
    topPadding: 16 * uiScale
    spacing: 16 * uiScale
    Material.theme: hostWindow && hostWindow.viewState !== undefined ? (hostWindow.viewState.dark ? Material.Dark : Material.Light) : Material.System
    Material.primary: colors.primary
    Material.accent: colors.primary
    Material.background: colors["surface-low"]
    Material.foreground: colors.text
    Material.elevation: 0
    background: Rectangle {
        objectName: "dialogSurface"
        color: control.colors["surface-low"]
        radius: 28
        antialiasing: true
        border.width: 1
        border.color: control.colors.outline
    }
    header: Label {
        text: control.title
        textFormat: Text.PlainText
        visible: text.length > 0
        wrapMode: Text.Wrap
        leftPadding: 24 * control.uiScale; rightPadding: 24 * control.uiScale; topPadding: 24 * control.uiScale; bottomPadding: 0
        color: control.colors.text
        font.pixelSize: Math.round(22 * control.uiScale)
        font.weight: Font.DemiBold
    }
    footer: DialogButtonBox {
        visible: count > 0
        standardButtons: control.standardButtons
        alignment: Qt.AlignRight
        spacing: 8 * control.uiScale
        leftPadding: 24 * control.uiScale; rightPadding: 24 * control.uiScale; topPadding: 8 * control.uiScale; bottomPadding: 24 * control.uiScale
        background: Item {}
        delegate: ActionButton {
            colors: control.colors
            font: control.font
            implicitHeight: 44 * control.uiScale
            prominent: DialogButtonBox.buttonRole === DialogButtonBox.AcceptRole || DialogButtonBox.buttonRole === DialogButtonBox.YesRole
        }
    }
    Overlay.modal: Rectangle { objectName: "dialogScrim"; color: "#66000000" }
    enter: Transition { NumberAnimation { property: "opacity"; from: 0; to: 1; duration: control.motion ? 120 : 0 } }
    exit: Transition { NumberAnimation { property: "opacity"; from: 1; to: 0; duration: control.motion ? 90 : 0 } }
    onAboutToShow: {
        if (hostWindow && hostWindow.modalDialogCount !== undefined && !blockingHints) {
            hostWindow.modalDialogCount++
            blockingHints = true
        }
    }
    onClosed: {
        if (blockingHints && hostWindow) hostWindow.modalDialogCount = Math.max(0, hostWindow.modalDialogCount - 1)
        blockingHints = false
    }
    Component.onDestruction: {
        if (blockingHints && hostWindow) hostWindow.modalDialogCount = Math.max(0, hostWindow.modalDialogCount - 1)
    }
}
