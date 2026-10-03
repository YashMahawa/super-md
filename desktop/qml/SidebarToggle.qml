import QtQuick
import QtQuick.Controls

ActionButton {
    id: control
    objectName: "sidebarToggle"
    property bool expanded: true
    property real expansion: expanded ? 1 : 0
    ToolTip.text: expanded ? "Hide files" : "Show files"
    Accessible.name: ToolTip.text
    Behavior on expansion { enabled: control.motion; NumberAnimation { duration: 200; easing.type: Easing.OutCubic } }
    contentItem: Canvas {
        id: symbol
        property color ink: control.colors.text
        onInkChanged: requestPaint()
        Connections { target: control; function onExpansionChanged() { symbol.requestPaint() } }
        onPaint: {
            const c=getContext("2d");c.reset();c.strokeStyle=ink;c.lineWidth=2.2;c.lineCap="round";c.lineJoin="round";
            const x=width/2-10,y=height/2-9;c.translate(x,y);
            c.beginPath();c.roundedRect(1,2,18,14,2,2);c.stroke();
            const divider=3+control.expansion*4;
            c.globalAlpha=control.expansion;c.beginPath();c.moveTo(divider,3);c.lineTo(divider,15);c.stroke();
            c.globalAlpha=1-control.expansion;c.beginPath();c.moveTo(8,6);c.lineTo(11,9);c.lineTo(8,12);c.stroke();
        }
    }
}
