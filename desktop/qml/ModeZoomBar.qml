import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Pane {
    id: bar
    required property var viewState
    required property bool wide
    required property var modeChoices
    required property string fullscreenHintText
    signal enterFullscreen()
    padding: 12
    background: ThemeSurface {
        area: "toolbar"
        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: bar.viewState.colors.outline; opacity: .4 }
    }
    RowLayout {
        anchors.fill: parent
        ModeGroup { objectName: "documentModeGroup"; choices: bar.modeChoices; selected: bar.viewState.mode; onChosen: key => studio.setMode(key) }
        Item { Layout.fillWidth: true }
        ExpressiveSlider { visible: bar.wide; Layout.preferredWidth: 140; from: 40; to: 300; value: bar.viewState.zoom; onMoved: studio.setZoom(value); Accessible.name: "Content zoom" }
        TextField {
            objectName: "zoomPercentage"
            Layout.preferredWidth: 76
            Layout.preferredHeight: 36
            Layout.alignment: Qt.AlignVCenter
            text: Math.round(bar.viewState.zoom).toString() + "%"
            font.family: "Noto Sans"
            font.pixelSize: 13
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            selectByMouse: true
            color: bar.viewState.colors.text
            padding: 6
            validator: RegularExpressionValidator { regularExpression: /[0-9]{1,3}%?/ }
            onEditingFinished: { const value = Number(text.replace("%","")); if (value >= 40 && value <= 300) studio.setZoom(value); else text = Math.round(bar.viewState.zoom) + "%" }
            background: Rectangle { radius: 12; antialiasing: true; color: bar.viewState.colors["surface-high"]; border.width: parent.activeFocus ? 2 : 0; border.color: bar.viewState.colors.primary }
            Accessible.name: "Zoom percentage"
        }
        ActionButton { objectName: "fullscreenButton"; glyph: "Fullscreen"; icon.width: 24; icon.height: 24; compact: true; tonal: true; ToolTip.text: bar.fullscreenHintText; onClicked: bar.enterFullscreen() }
        ActionButton { objectName: "centerLockButton"; glyph: bar.viewState.settings.centerLock ? "Lock" : "LockOpen"; compact: true; tonal: bar.viewState.settings.centerLock; ToolTip.text: bar.viewState.settings.centerLock ? "Centre locked · click to allow horizontal movement" : "Lock document to centre"; onClicked: studio.setting("centerLock", JSON.stringify(!bar.viewState.settings.centerLock)) }
    }
}
