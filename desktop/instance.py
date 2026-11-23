"""One process owns native preferences/recovery; subsequent launches open a window."""
import hashlib
import json
from pathlib import Path
from PySide6.QtCore import QObject, Signal, QLockFile, QStandardPaths, QTimer, QUrl
from PySide6.QtNetwork import QLocalServer, QLocalSocket


class InstanceBroker(QObject):
    requested = Signal(str)
    serviceRequested = Signal(str)

    def __init__(self, parent=None, *, service_handler=None):
        super().__init__(parent)
        self.service_handler = service_handler
        root = Path(QStandardPaths.writableLocation(QStandardPaths.AppDataLocation))
        root.mkdir(parents=True, exist_ok=True)
        self.lock = QLockFile(str(root / "native-instance.lock"))
        self.lock.setStaleLockTime(0)
        self.name = "supermd-qt-" + hashlib.sha256(str(root).encode()).hexdigest()[:20]
        self.server = QLocalServer(self)
        self.server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
        self.server.newConnection.connect(self.accept)

    def set_service_handler(self, handler):
        self.service_handler = handler

    def claim_or_forward(self, note):
        def listen():
            QLocalServer.removeServer(self.name)  # Only the exclusive owner may remove a stale socket.
            if not self.server.listen(self.name):
                self.lock.unlock()
                raise RuntimeError("Unable to start the native application file-opening service")
            return True
        if self.lock.tryLock(0):
            return listen()
        socket = QLocalSocket()
        socket.connectToServer(self.name)
        if not socket.waitForConnected(2000):
            if self.lock.tryLock(3000):
                return listen()
            raise RuntimeError("Super MD is starting or busy. Please try opening the note again.")
        url = QUrl(note or "")
        local = url.toLocalFile() if url.isLocalFile() else note
        socket.write(json.dumps({"note": str(Path(local).resolve()) if local else ""}).encode() + b"\n")
        socket.waitForBytesWritten(1000)
        raw = bytes(socket.readAll())
        while b"\n" not in raw and socket.waitForReadyRead(2000):
            raw += bytes(socket.readAll())
        if b"\n" not in raw:
            raw += bytes(socket.readAll())
        if raw != b"ok\n":
            raise RuntimeError("The existing Super MD process did not acknowledge the new window")
        socket.disconnectFromServer()
        return False

    def accept(self):
        while self.server.hasPendingConnections():
            socket = self.server.nextPendingConnection()
            buffer = bytearray()
            def read(socket=socket, buffer=buffer):
                buffer.extend(bytes(socket.readAll()))
                if len(buffer) > 16384:
                    socket.disconnectFromServer()
                    return
                if b"\n" not in buffer:
                    return
                try:
                    request = json.loads(buffer.split(b"\n", 1)[0])
                    if not isinstance(request, dict):
                        raise ValueError("Invalid IPC request")
                    if set(request) == {"service"} and request["service"] in ("start", "status", "stop", "quit"):
                        raw_action = request["service"]
                        action = "stop" if raw_action == "quit" else raw_action
                        self.serviceRequested.emit(raw_action)
                        reply = (
                            self.service_handler(action)
                            if self.service_handler is not None
                            else {"ok": False, "running": False, "error": "Background service is unavailable"}
                        )
                        if socket.state() == QLocalSocket.LocalSocketState.ConnectedState:
                            socket.write(json.dumps(reply, separators=(",", ":")).encode("utf-8") + b"\n")
                            socket.flush()
                            if socket.state() == QLocalSocket.LocalSocketState.ConnectedState:
                                socket.waitForBytesWritten(500)
                            socket.disconnectFromServer()
                        return
                    note = request["note"]
                    if set(request) != {"note"} or not isinstance(note, str) or "\0" in note:
                        raise ValueError("Invalid file-opening request")
                except (ValueError, TypeError, KeyError):
                    socket.disconnectFromServer()
                    return
                socket.write(b"ok\n")
                socket.flush()
                socket.waitForBytesWritten(500)
                self.requested.emit(note)
                socket.disconnectFromServer()
            socket.readyRead.connect(read)
            socket.disconnected.connect(socket.deleteLater)
            QTimer.singleShot(5000, socket, socket.disconnectFromServer)
            read()

    def stop_accepting(self):
        self.server.close()
        while self.server.hasPendingConnections():
            pending = self.server.nextPendingConnection()
            if pending is not None:
                pending.abort()
        for child in self.findChildren(QLocalSocket):
            child.abort()

    def close(self):
        self.stop_accepting()
        self.lock.unlock()
