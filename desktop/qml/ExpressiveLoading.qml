import QtQuick

// Qt adaptation of M3 Expressive's morphing-shape loading treatment. Android
// uses the official Compose LoadingIndicator; Qt has no official equivalent.
Item {
    id: indicator
    objectName: "expressiveLoading"
    property bool running: true
    property bool motion: JSON.parse(studio.snapshot).settings.motion
    property color ink: JSON.parse(studio.snapshot).colors.primary
    property real phase: 0
    implicitWidth: 48
    implicitHeight: 48
    visible: running
    Accessible.role: Accessible.ProgressBar
    Accessible.name: "Loading document"
    onPhaseChanged: shape.requestPaint()
    onInkChanged: shape.requestPaint()
    NumberAnimation on phase { from: 0; to: 3; duration: 2100; loops: Animation.Infinite; running: indicator.running && indicator.visible && indicator.motion }
    Canvas {
        id: shape
        anchors.fill: parent
        rotation: indicator.motion ? indicator.phase * 120 : 0
        onPaint: {
            const c = getContext("2d"); c.reset(); c.fillStyle = indicator.ink;
            const stage = Math.floor(indicator.phase) % 3;
            let blend = indicator.phase % 1;
            blend = blend * blend * (3 - 2 * blend);
            const points = [];
            function radius(kind, a) {
                if (kind === 0) return 0.73 + 0.12 * Math.cos(4 * a);
                if (kind === 1) return 0.80 + 0.05 * Math.cos(5 * a);
                return 0.72 + 0.12 * Math.cos(6 * a);
            }
            for (let i = 0; i < 48; i++) {
                const a = i / 48 * Math.PI * 2;
                const r = (radius(stage, a) * (1 - blend) + radius((stage + 1) % 3, a) * blend) * Math.min(width, height) / 2;
                points.push({x: width / 2 + Math.cos(a) * r, y: height / 2 + Math.sin(a) * r});
            }
            c.beginPath(); c.moveTo((points[47].x + points[0].x) / 2, (points[47].y + points[0].y) / 2);
            for (let i = 0; i < 48; i++) {
                const next = points[(i + 1) % 48];
                c.quadraticCurveTo(points[i].x, points[i].y, (points[i].x + next.x) / 2, (points[i].y + next.y) / 2);
            }
            c.closePath(); c.fill();
        }
    }
}
