import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs

ColumnLayout {
    id: panel
    required property var hostStudio
    required property var viewState
    Layout.fillWidth: true
    spacing: 16

    Label { text: "AI agent access"; font.pixelSize: 22; font.weight: Font.DemiBold }
    Label {
        Layout.fillWidth: true
        wrapMode: Text.WordWrap
        color: panel.viewState.colors.muted
        text: "Allow a local MCP agent to inspect the Markdown tabs currently open in Super MD, including unsaved edits, search sections, apply revision-checked edits, and view the current reader viewport."
    }
    Switch {
        objectName: "liveAgentAccessSwitch"
        text: "Allow access to open tabs for this app session"
        checked: panel.hostStudio.agentAccessEnabled
        onToggled: panel.hostStudio.setAgentAccessEnabled(checked)
    }
    Label {
        objectName: "liveAgentAccessStatus"
        Layout.fillWidth: true
        wrapMode: Text.WordWrap
        text: panel.hostStudio.agentAccessStatus
        color: panel.hostStudio.agentAccessEnabled ? panel.viewState.colors.primary : panel.viewState.colors.muted
    }
    Label {
        Layout.fillWidth: true
        wrapMode: Text.WordWrap
        color: panel.viewState.colors.muted
        text: panel.hostStudio.agentAccessTabsSummary
    }
    Label {
        Layout.fillWidth: true
        wrapMode: Text.WordWrap
        color: panel.viewState.colors.muted
        text: "Off by default. When enabled, a temporary bearer token is stored in a private app-session file and a server listens only on this computer's loopback interface. Disabling access revokes the token and closes the bridge."
    }
    ActionButton {
        objectName: "copyLiveAgentSetup"
        text: "Copy MCP server config"
        glyph: "Export"
        tonal: true
        enabled: panel.hostStudio.agentAccessEnabled
        onClicked: panel.hostStudio.copyAgentSetupInstructions()
    }
    ActionButton {
        objectName: "downloadLiveAgentGuide"
        text: "Save setup guide…"
        glyph: "DownloadSimple"
        tonal: true
        enabled: panel.hostStudio.agentAccessEnabled
        onClicked: setupGuideDialog.open()
    }
    Label {
        Layout.fillWidth: true
        wrapMode: Text.WordWrap
        color: panel.viewState.colors.muted
        text: "An agent sees only tabs in this app session. It cannot open files outside the roots you explicitly give its MCP server."
    }
    Rectangle { Layout.fillWidth: true; height: 1; color: panel.viewState.colors.outline }
    Label { text: "Cloud relay"; font.pixelSize: 18; font.weight: Font.DemiBold }
    Label {
        Layout.fillWidth: true
        wrapMode: Text.WordWrap
        color: panel.viewState.colors.muted
        text: "Pair this computer with the Super MD relay or your own server. The app makes an outbound TLS/WebSocket connection; documents and images are forwarded only when the connected MCP client requests them."
    }
    TextField {
        id: relayOrigin
        objectName: "agentRelayOrigin"
        Layout.fillWidth: true
        placeholderText: "https://relay.example.net"
        text: "https://supermd-agent-relay.onrender.com"
    }
    RowLayout {
        Layout.fillWidth: true
        ActionButton { objectName: "createAgentPairing"; text: "Create pairing"; glyph: "Plus"; tonal: true; enabled: !panel.hostStudio.cloudAgentRevocationPending; onClicked: panel.hostStudio.createAgentPairing(relayOrigin.text) }
        ActionButton { objectName: "importAgentPairing"; text: "Import pairing…"; glyph: "DownloadSimple"; tonal: true; enabled: !panel.hostStudio.cloudAgentRevocationPending; onClicked: importPairingDialog.open() }
        ActionButton { objectName: "exportAgentPairing"; text: "Export pairing…"; glyph: "Export"; tonal: true; enabled: panel.hostStudio.cloudAgentConfigured && !panel.hostStudio.cloudAgentRevocationPending; onClicked: exportPairingDialog.open() }
    }
    Switch {
        objectName: "cloudAgentAccessSwitch"
        text: "Connect this computer to the cloud relay"
        checked: panel.hostStudio.cloudAgentEnabled
        enabled: panel.hostStudio.cloudAgentConfigured && !panel.hostStudio.cloudAgentRevocationPending
        onToggled: panel.hostStudio.setCloudAgentEnabled(checked)
    }
    Label {
        objectName: "cloudAgentAccessStatus"
        Layout.fillWidth: true
        wrapMode: Text.WordWrap
        text: panel.hostStudio.cloudAgentStatus
        color: panel.hostStudio.cloudAgentEnabled ? panel.viewState.colors.primary : panel.viewState.colors.muted
    }
    RowLayout {
        Layout.fillWidth: true
        ActionButton { objectName: "copyCloudConnectorUrl"; text: "Copy MCP connector URL"; glyph: "Export"; tonal: true; enabled: panel.hostStudio.cloudAgentConfigured && !panel.hostStudio.cloudAgentRevocationPending; onClicked: panel.hostStudio.copyCloudConnectorUrl() }
        Label { Layout.fillWidth: true; wrapMode: Text.WordWrap; color: panel.viewState.colors.muted; text: "The URL is a secret that grants access to this paired workspace. Share it only with the intended MCP client." }
    }
    ActionButton {
        objectName: "revokeCloudAgentPairing"
        text: panel.hostStudio.cloudAgentRevocationPending ? "Revoking pairing…" : "Revoke pairing and erase credentials"
        glyph: "X"
        tonal: true
        enabled: panel.hostStudio.cloudAgentConfigured && !panel.hostStudio.cloudAgentRevocationPending
        onClicked: panel.hostStudio.revokeCloudAgent()
    }
    FileDialog {
        id: importPairingDialog
        objectName: "importAgentPairingDialog"
        fileMode: FileDialog.OpenFile
        title: "Import Super MD relay pairing"
        nameFilters: ["Pairing file (*.json)"]
        onAccepted: panel.hostStudio.importAgentPairing(selectedFile)
    }
    FileDialog {
        id: exportPairingDialog
        objectName: "exportAgentPairingDialog"
        fileMode: FileDialog.SaveFile
        title: "Export Super MD relay pairing"
        nameFilters: ["Pairing file (*.json)"]
        defaultSuffix: "json"
        onAccepted: panel.hostStudio.exportAgentPairing(selectedFile)
    }
    FileDialog {
        id: setupGuideDialog
        objectName: "liveAgentSetupGuideDialog"
        fileMode: FileDialog.SaveFile
        title: "Save Super MD live-tab setup guide"
        nameFilters: ["Markdown guide (*.md)"]
        defaultSuffix: "md"
        onAccepted: panel.hostStudio.saveAgentSetupInstructions(selectedFile)
    }
}
