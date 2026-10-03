import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Search is inside the popup, separate from the committed font name. Typing
// never changes the document until an existing family is explicitly chosen.
ActionButton {
    id: field
    property var families: []
    property string value: "Manrope"
    property Item viewportItem: null
    signal chosen(string family)
    function revealChoices() { picker.open() }
    onVisibleChanged: { if (!visible) picker.close() }
    onEnabledChanged: { if (!enabled) picker.close() }
    Connections {
        target: field.Window.window
        function onVisibleChanged() { if (!field.Window.window.visible) picker.close() }
    }
    text: value
    glyph: "CaretDown"
    tonal: true
    implicitHeight: 48
    Accessible.name: "Font: " + value
    onClicked: picker.open()
    Popup {
        id: picker
        objectName: field.objectName + "Popup"
        parent: Overlay.overlay
        width: Math.min(field.width, picker.parent ? picker.parent.width - 32 : field.width)
        height: Math.min(400, picker.parent ? picker.parent.height - 48 : 400)
        modal: true
        dim: false
        padding: 12
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
        onAboutToShow: {
            const position = field.mapToItem(Overlay.overlay, 0, 0)
            x = Math.max(16, Math.min(position.x, Overlay.overlay.width - width - 16))
            const below = Overlay.overlay.height - position.y - field.height - 22
            const above = position.y - 22
            height = Math.min(400, Math.max(below, above), Overlay.overlay.height - 48)
            y = below >= height ? position.y + field.height + 6 : Math.max(16, position.y - height - 6)
            query.text = ""
        }
        onOpened: { query.forceActiveFocus(); results.currentIndex = Math.max(0, results.model.indexOf(field.value)); results.positionViewAtIndex(results.currentIndex, ListView.Contain) }
        background: Rectangle { radius: 24; antialiasing: true; color: field.colors["surface-low"]; border.width: 1; border.color: field.colors.outline }
        contentItem: ColumnLayout {
            spacing: 8
            TextField {
                id: query
                objectName: "fontSearch"
                Layout.fillWidth: true
                placeholderText: "Search fonts"
                Accessible.name: "Search fonts"
                selectByMouse: true
                color: field.colors.text
                onTextChanged: results.currentIndex = 0
                Keys.onDownPressed: results.currentIndex = Math.min(results.count - 1, results.currentIndex + 1)
                Keys.onUpPressed: results.currentIndex = Math.max(0, results.currentIndex - 1)
                onAccepted: { if (results.count) { field.chosen(results.model[results.currentIndex]); picker.close() } }
            }
            Label { visible: !results.count; text: "No matching fonts"; color: field.colors.muted; Layout.fillWidth: true; Layout.preferredHeight: 44 }
            ListView {
                id: results
                objectName: "fontResults"
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                model: field.families.filter(name => name.toLowerCase().includes(query.text.trim().toLowerCase()))
                onCurrentIndexChanged: positionViewAtIndex(currentIndex, ListView.Contain)
                delegate: ItemDelegate {
                    required property string modelData
                    required property int index
                    width: results.width - 18
                    height: 44
                    text: modelData
                    highlighted: index === results.currentIndex
                    onClicked: { field.chosen(modelData); picker.close() }
                    background: Rectangle { radius: 12; antialiasing: true; color: parent.highlighted ? field.colors["primary-container"] : parent.hovered ? field.colors["surface-high"] : "transparent" }
                }
                ScrollBar.vertical: ExpressiveScrollBar {}
            }
        }
        enter: Transition { NumberAnimation { property: "opacity"; from: 0; to: 1; duration: field.motion ? 120 : 0 } }
        exit: Transition { NumberAnimation { property: "opacity"; from: 1; to: 0; duration: field.motion ? 90 : 0 } }
    }
}
