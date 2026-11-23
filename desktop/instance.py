"""One process owns native preferences/recovery; subsequent launches open a window."""
import hashlib
import json
import os
import time
from pathlib import Path
from PySide6.QtCore import QObject, Signal, QLockFile, QStandardPaths, QTimer, QUrl
from PySide6.QtNetwork import QLocalServer, QLocalSocket

_PROCESS_EXIT_LOCKS = []


def _try_lock_lifecycle(fh) -> bool:
    try:
        if os.name == "nt":
            import msvcrt
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _unlock_lifecycle(fh) -> None:
    try:
        if os.name == "nt":
            import msvcrt
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass


def is_process_exit_clear(root: Path) -> bool:
    lifecycle = Path(root) / "native-instance.lifecycle"
    if not lifecycle.is_file():
        return True
    try:
        fd = os.open(str(lifecycle), os.O_RDWR)
    except OSError:
        return True
    fh = os.fdopen(fd, "r+b")
    try:
        if not _try_lock_lifecycle(fh):
            return False
        _unlock_lifecycle(fh)
        return True
    finally:
        fh.close()


def wait_for_process_exit(root: Path, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        if is_process_exit_clear(root):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.02)


class InstanceBroker(QObject):
    requested = Signal(str)
    serviceRequested = Signal(str)

    def __init__(self, parent=None, *, service_handler=None):
        super().__init__(parent)
        self.service_handler = service_handler
        root = Path(QStandardPaths.writableLocation(QStandardPaths.AppDataLocation))
        root.mkdir(parents=True, exist_ok=True)
        self.root = root
        self.lock = QLockFile(str(root / "native-instance.lock"))
        self.lock.setStaleLockTime(0)
        self.name = "supermd-qt-" + hashlib.sha256(str(root).encode()).hexdigest()[:20]
        self.server = QLocalServer(self)
        self.server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
        self.server.newConnection.connect(self.accept)

    def hold_process_exit_lock(self, timeout: float = 15.0) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        lifecycle = self.root / "native-instance.lifecycle"
        deadline = time.monotonic() + timeout
        while True:
            fd = os.open(str(lifecycle), os.O_RDWR | os.O_CREAT, 0o600)
            fh = os.fdopen(fd, "r+b")
            try:
                if fh.seek(0, os.SEEK_END) == 0:
                    fh.write(b"\0")
                    fh.flush()
                if _try_lock_lifecycle(fh):
                    _PROCESS_EXIT_LOCKS.append(fh)
                    fh = None
                    return
            finally:
                if fh is not None:
                    fh.close()
            if time.monotonic() >= deadline:
                raise RuntimeError("Previous Super MD process did not finish exiting in time")
            time.sleep(0.02)

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
