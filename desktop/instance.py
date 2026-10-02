"""One process owns native preferences/recovery; subsequent launches open a window."""
import hashlib
import json
from pathlib import Path
from PySide6.QtCore import QObject, Signal, QLockFile, QStandardPaths, QTimer, QUrl
from PySide6.QtNetwork import QLocalServer, QLocalSocket


class InstanceBroker(QObject):
    requested = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        root = Path(QStandardPaths.writableLocation(QStandardPaths.AppDataLocation))
        root.mkdir(parents=True, exist_ok=True)
        self.lock = QLockFile(str(root / "native-instance.lock"))
        self.lock.setStaleLockTime(0)
        self.name = "supermd-qt-" + hashlib.sha256(str(root).encode()).hexdigest()[:20]
        self.server = QLocalServer(self)
        self.server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
        self.server.newConnection.connect(self.accept)

    def claim_or_forward(self, note):
        if self.lock.tryLock(0):
            QLocalServer.removeServer(self.name)  # Only the exclusive owner may remove a stale socket.
            if not self.server.listen(self.name):
                self.lock.unlock()
                raise RuntimeError("Unable to start the native application file-opening service")
            return True
        socket = QLocalSocket()
        socket.connectToServer(self.name)
        if not socket.waitForConnected(2000):
            raise RuntimeError("Super MD is starting or busy. Please try opening the note again.")
        url = QUrl(note or "")
        local = url.toLocalFile() if url.isLocalFile() else note
        socket.write(json.dumps({"note": str(Path(local).resolve()) if local else ""}).encode() + b"\n")
        socket.waitForBytesWritten(1000)
        if not socket.waitForReadyRead(2000) or bytes(socket.readAll()) != b"ok\n":
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
                    note = request["note"]
                    if set(request) != {"note"} or not isinstance(note, str) or "\0" in note:
                        raise ValueError("Invalid file-opening request")
                except (ValueError, TypeError, KeyError):
                    socket.disconnectFromServer()
                    return
                socket.write(b"ok\n")
                socket.flush()
                self.requested.emit(note)
                socket.disconnectFromServer()
            socket.readyRead.connect(read)
            socket.disconnected.connect(socket.deleteLater)
            QTimer.singleShot(5000, socket, socket.disconnectFromServer)
            read()

    def close(self):
        self.server.close()
        self.lock.unlock()
