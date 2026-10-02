import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material

// Skin the native ComboBox; keep its keyboard, type-ahead and accessibility behavior.
ComboBox {
    id: control
    property var colors: JSON.parse(studio.snapshot).colors
    property bool motion: JSON.parse(studio.snapshot).settings.motion
    // A menu is constrained by its actual scroll viewport, not the whole window.
    property Item viewportItem: null
    function positionChoices() {
        const overlay = Overlay.overlay
        const field = control.mapToItem(overlay, 0, 0)
        const bounds = viewportItem ? viewportItem.mapToItem(overlay, 0, 0) : Qt.point(0, 0)
        const top = bounds.y + 6
        const bottom = bounds.y + (viewportItem ? viewportItem.height : overlay.height) - 6
        const below = Math.max(0, bottom - field.y - control.height - 6)
        const above = Math.max(0, field.y - 6 - top)
        // Prefer a short, scrollable menu below the field over flipping across
        // unrelated section labels. Only open above when even two rows won't fit.
        const desired = Math.min(7, control.count) * 44 + 16
        const openBelow = below >= Math.min(104, desired) || below >= above
        const available = openBelow ? below : above
        const rows = Math.max(1, Math.min(7, control.count, Math.floor((available - 16) / 44)))
        choices.height = Math.min(available, rows * 44 + 16)
        choices.x = field.x
        choices.y = openBelow ? field.y + control.height + 6 : field.y - 6 - choices.height
    }
    function revealChoices() { forceActiveFocus(); popup.open() }
    onVisibleChanged: { if (!visible) popup.close() }
    onEnabledChanged: { if (!enabled) popup.close() }
    Connections {
        target: control.Window.window
        function onVisibleChanged() { if (!control.Window.window.visible) control.popup.close() }
    }
    Connections {
        target: control.viewportItem
        ignoreUnknownSignals: true
        function onContentYChanged() { if (control.popup.visible) control.positionChoices() }
        function onHeightChanged() { if (control.popup.visible) control.positionChoices() }
        function onWidthChanged() { if (control.popup.visible) control.positionChoices() }
    }
    implicitHeight: 48
    implicitWidth: 200
    leftPadding: 16
    rightPadding: 44
    topInset: 0
    bottomInset: 0
    font.family: "Noto Sans"
    font.pixelSize: 14
    Material.elevation: 0
    contentItem: TextField {
        text: control.editable ? control.editText : control.displayText
        enabled: control.editable
        readOnly: !control.editable
        autoScroll: control.editable
        selectByMouse: control.editable
        padding: 0
        color: control.colors.text
        font: control.font
        verticalAlignment: Text.AlignVCenter
        renderType: Text.NativeRendering
        background: null
    }
    indicator: Item {
        x: control.width - width - 12
        y: (control.height - height) / 2
        width: 24
        height: 24
        rotation: control.popup.visible ? 180 : 0
        // Qt's IconLabel handles SVG tinting without rasterizing at a fixed display scale.
        ToolButton { anchors.fill: parent; focusPolicy: Qt.NoFocus; padding: 0; icon.source: "../icons/CaretDown.svg"; icon.color: control.colors.text; icon.width: 20; icon.height: 20; background: null; onClicked: control.popup.visible ? control.popup.close() : control.revealChoices() }
        Behavior on rotation { enabled: control.motion; NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
    }
    background: Rectangle {
        radius: control.popup.visible ? 14 : 18
        antialiasing: true
        color: control.colors["surface-high"]
        border.width: control.visualFocus || control.activeFocus ? 2 : 0
        border.color: control.colors.primary
        Behavior on radius { enabled: control.motion; NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
    }
    delegate: ItemDelegate {
        required property var modelData
        required property int index
        width: control.popup.availableWidth
        height: 44
        text: modelData.toString()
        font: control.font
        highlighted: control.highlightedIndex === index
        leftPadding: 14
        rightPadding: 14
        contentItem: Text { text: parent.text; font: control.font; color: parent.highlighted ? control.colors["on-primary-container"] : control.colors.text; elide: Text.ElideRight; verticalAlignment: Text.AlignVCenter; renderType: Text.NativeRendering }
        background: Rectangle { radius: 12; antialiasing: true; color: parent.highlighted ? control.colors["primary-container"] : parent.hovered ? control.colors["surface-high"] : "transparent" }
    }
    popup: Popup {
        id: choices
        objectName: control.objectName ? control.objectName + "Popup" : "choicePopup"
        parent: Overlay.overlay
        width: control.width
        padding: 8
        modal: true
        dim: false
        onAboutToShow: control.positionChoices()
        onOpened: choicesList.positionViewAtIndex(control.currentIndex, ListView.Contain)
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
        contentItem: ListView {
            id: choicesList
            clip: true
            implicitHeight: contentHeight
            model: control.popup.visible ? control.delegateModel : null
            currentIndex: control.highlightedIndex
            highlightMoveDuration: control.motion ? 120 : 0
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        }
        background: Item {
            // Mask covered form text at the rounded corners as well. Without
            // this backing, fragments of the next label peek around the menu.
            Rectangle { anchors.fill: parent; color: control.colors.surface }
            Rectangle { anchors.fill: parent; radius: 22; antialiasing: true; color: control.colors["surface-low"]; border.width: 1; border.color: control.colors.outline }
        }
        enter: Transition { NumberAnimation { property: "opacity"; from: 0; to: 1; duration: control.motion ? 120 : 0 } }
        exit: Transition { NumberAnimation { property: "opacity"; from: 1; to: 0; duration: control.motion ? 90 : 0 } }
    }
}
