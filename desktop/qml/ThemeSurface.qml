import QtQuick

Rectangle {
    id: surface
    property string area: "toolbar"
    property var artwork: studio.themeArtwork ? studio.themeArtwork[area] || ({}) : ({})
    color: studio.palette["surface-low"]
    clip: true
    Image {
        anchors.fill: parent
        source: surface.artwork.image || ""
        opacity: Math.min(.12, Math.max(0,surface.artwork.opacity === undefined ? .06 : surface.artwork.opacity))
        fillMode: surface.artwork.fit === "contain" ? Image.PreserveAspectFit : Image.PreserveAspectCrop
        horizontalAlignment: (surface.artwork.position || "center").indexOf("left") >= 0 ? Image.AlignLeft : (surface.artwork.position || "center").indexOf("right") >= 0 ? Image.AlignRight : Image.AlignHCenter
        verticalAlignment: (surface.artwork.position || "center").indexOf("top") >= 0 ? Image.AlignTop : (surface.artwork.position || "center").indexOf("bottom") >= 0 ? Image.AlignBottom : Image.AlignVCenter
        sourceSize.width: 1024
        sourceSize.height: 1024
        asynchronous: true
        cache: true
    }
}
