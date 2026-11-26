import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: banner
    objectName: "fullscreenStatusBanner"
    property bool footerHidden: false
    property bool busy: false
    property string message: ""
    property int messageRevision: 0
    property real maxWidth: 680
    property int dismissInterval: 3600
    property var colors: studio.palette
    property bool motion: studio.motionEnabled
    property bool showingMessage: false
    property int seenRevision: 0
    property string seenMessage: ""
    property bool initialized: false
    readonly property bool shown: footerHidden && (busy || (showingMessage && message.length > 0))
    readonly property string displayText: busy ? "Preparing document…" : message

    implicitWidth: Math.min(Math.max(180, maxWidth), Math.max(180, contentRow.implicitWidth + 28))
    implicitHeight: Math.max(40, contentRow.implicitHeight + 16)
    width: implicitWidth
    height: implicitHeight
    radius: 20
    color: colors["surface-high"]
    border.width: 1
    border.color: colors.outline
    antialiasing: true
    visible: shown || opacity > 0
    opacity: shown ? 1 : 0
    Behavior on opacity { NumberAnimation { duration: banner.motion ? 140 : 0 } }

    Accessible.role: Accessible.StatusBar
    Accessible.name: banner.displayText

    function sync() {
        if (!initialized) return
        if (!footerHidden) {
            showingMessage = false
            dismissTimer.stop()
            if (message.length > 0 || messageRevision === seenRevision) {
                seenRevision = messageRevision
                seenMessage = message
            }
            return
        }
        if (message.length === 0) {
            seenMessage = ""
            showingMessage = false
            dismissTimer.stop()
            return
        }
        const revisionAdvanced = messageRevision !== seenRevision
        const unversionedChange = messageRevision === 0 && message !== seenMessage
        if (revisionAdvanced || unversionedChange) {
            seenRevision = messageRevision
            seenMessage = message
            showingMessage = true
            if (busy) dismissTimer.stop()
            else dismissTimer.restart()
        } else {
            seenMessage = message
        }
    }

    Component.onCompleted: {
        seenRevision = messageRevision
        seenMessage = message
        initialized = true
        if (footerHidden && busy) dismissTimer.stop()
    }
    onFooterHiddenChanged: sync()
    onMessageChanged: sync()
    onMessageRevisionChanged: sync()
    onBusyChanged: {
        if (!initialized) return
        if (busy) dismissTimer.stop()
        else if (footerHidden && showingMessage && message.length > 0) dismissTimer.restart()
    }

    Timer {
        id: dismissTimer
        objectName: "fullscreenStatusDismissTimer"
        interval: banner.dismissInterval
        repeat: false
        onTriggered: {
            if (!banner.busy) banner.showingMessage = false
        }
    }

    RowLayout {
        id: contentRow
        anchors.fill: parent
        anchors.leftMargin: 14
        anchors.rightMargin: 14
        anchors.topMargin: 8
        anchors.bottomMargin: 8
        spacing: 10
        ExpressiveLoading {
            objectName: "fullscreenStatusSpinner"
            running: banner.busy
            motion: banner.motion
            ink: banner.colors.primary
            implicitWidth: 20
            implicitHeight: 20
            Layout.alignment: Qt.AlignVCenter
        }
        Label {
            objectName: "fullscreenStatusLabel"
            textFormat: Text.PlainText
            text: banner.displayText
            color: banner.colors.text
            font.pixelSize: 13
            font.weight: Font.Medium
            elide: Text.ElideRight
            maximumLineCount: 2
            wrapMode: Text.Wrap
            Layout.fillWidth: true
            Layout.alignment: Qt.AlignVCenter
        }
    }
}
