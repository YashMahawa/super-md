import QtQuick
import QtQuick.Controls

Repeater {
    id: edges
    required property var host
    parent: Overlay.overlay
    model: edges.host && studio.fedoraWindowFrame && edges.host.visibility === Window.Windowed
        ? [Qt.LeftEdge, Qt.RightEdge, Qt.TopEdge, Qt.BottomEdge,
           Qt.LeftEdge | Qt.TopEdge, Qt.RightEdge | Qt.TopEdge,
           Qt.LeftEdge | Qt.BottomEdge, Qt.RightEdge | Qt.BottomEdge] : []
    delegate: MouseArea {
        required property int modelData
        readonly property int horizontalEdge: modelData & (Qt.LeftEdge | Qt.RightEdge)
        readonly property int verticalEdge: modelData & (Qt.TopEdge | Qt.BottomEdge)
        width: horizontalEdge ? 5 : parent.width
        height: verticalEdge ? 5 : parent.height
        x: modelData & Qt.RightEdge ? parent.width - width : 0
        y: modelData & Qt.BottomEdge ? parent.height - height : 0
        z: -1
        cursorShape: !horizontalEdge ? Qt.SizeVerCursor : !verticalEdge ? Qt.SizeHorCursor
            : (horizontalEdge === Qt.LeftEdge) === (verticalEdge === Qt.TopEdge) ? Qt.SizeFDiagCursor : Qt.SizeBDiagCursor
        onPressed: edges.host.startSystemResize(modelData)
    }
}
