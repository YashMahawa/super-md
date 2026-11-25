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
        root = Path(QStandardPaths.writableLocation(QStandardPaths.StandardLocation.AppDataLocation)).resolve()
        root.mkdir(parents=True, exist_ok=True)
        self.root = root
        self.lock = QLockFile(str(root / "native-instance.lock"))
        self.lock.setStaleLockTime(0)
        self.name = "supermd-qt-" + hashlib.sha256(str(root).encode()).hexdigest()[:20]
        self.server = QLocalServer(self)
        self.server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
        self.server.newConnection.connect(self.accept)
        self._should_listen = False
        self._active_readers = {}
        self._listen_watchdog = QTimer(self)
        self._listen_watchdog.setInterval(25)
        self._listen_watchdog.timeout.connect(self._ensure_listening)

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

    def start_listening(self) -> bool:
        self._should_listen = True
        if self.server.isListening():
            if not self._listen_watchdog.isActive():
                self._listen_watchdog.start()
            return True
        QLocalServer.removeServer(self.name)  # Only the exclusive owner may remove a stale socket.
        if not self.server.listen(self.name):
            self._should_listen = False
            self._listen_watchdog.stop()
            self.lock.unlock()
            raise RuntimeError("Unable to start the native application file-opening service")
        if not self._listen_watchdog.isActive():
            self._listen_watchdog.start()
        return True

    def _ensure_listening(self) -> None:
        if not self._should_listen or not self.lock.isLocked():
            return
        if not self.server.isListening():
            if not self.server.errorString():
                return
            # On BSD/macOS (XNU), an aborted client socket in the backlog makes ::accept() return
            # ECONNABORTED, causing Qt's QLocalServerPrivate::_q_onNewConnection to call setError()
            # and closeServer() (QTBUG-27239). Re-bind automatically while we still own self.lock.
            QLocalServer.removeServer(self.name)
            if not self.server.listen(self.name):
                return
        # Under macOS offscreen QPA without an active WebEngineView pumping Chromium's message loop,
        # QLocalServer's QSocketNotifier may not fire while QTimer ticks continue reliably. Poll the
        # listening descriptor non-blockingly and recover in-place if XNU ECONNABORTED closes it.
        for _ in range(8):
            progressed = False
            if self.server.isListening():
                progressed = bool(self.server.waitForNewConnection(0)) or self.server.hasPendingConnections()
            if not self.server.isListening() and self.server.errorString() and self._should_listen and self.lock.isLocked():
                QLocalServer.removeServer(self.name)
                self.server.listen(self.name)
            if self.server.hasPendingConnections():
                self.accept()
                progressed = True
            if not progressed:
                break
        for reader in list(self._active_readers.values()):
            reader()

    def claim_or_forward(self, note, *, defer_listen: bool = False, open_existing: bool = True):
        if self.lock.tryLock(0):
            return True if defer_listen else self.start_listening()
        socket = None
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            candidate = QLocalSocket()
            candidate.connectToServer(self.name)
            if candidate.waitForConnected(400):
                socket = candidate
                break
            if candidate.state() != QLocalSocket.LocalSocketState.UnconnectedState:
                candidate.abort()
            if self.lock.tryLock(100):
                return True if defer_listen else self.start_listening()
        if socket is None:
            raise RuntimeError("Super MD is starting or busy. Please try opening the note again.")
        if not open_existing:
            # Exchange a read-only status ping before closing so BSD/macOS XNU never sees an
            # unread, already-closed client socket in ::accept() (ECONNABORTED / QTBUG-27239).
            socket.write(b'{"service":"status"}\n')
            socket.flush()
            socket.waitForBytesWritten(500)
            ack = bytes(socket.readAll())
            while b"\n" not in ack and socket.waitForReadyRead(500):
                ack += bytes(socket.readAll())
            socket.disconnectFromServer()
            return False
        url = QUrl(note or "")
        local = url.toLocalFile() if url.isLocalFile() else note
        socket.write(json.dumps({"note": str(Path(local).resolve()) if local else ""}).encode() + b"\n")
        socket.flush()
        socket.waitForBytesWritten(1000)
        raw = bytes(socket.readAll())
        while b"\n" not in raw and socket.waitForReadyRead(2000):
            raw += bytes(socket.readAll())
        if b"\n" not in raw:
            raw += bytes(socket.readAll())
        if raw != b"ok\n":
            socket.disconnectFromServer()
            raise RuntimeError("The existing Super MD process did not acknowledge the new window")
        socket.disconnectFromServer()
        return False

    def accept(self):
        while self.server.hasPendingConnections():
            socket = self.server.nextPendingConnection()
            if socket is None:
                continue
            buffer = bytearray()
            state = {"handled": False, "reading": False}
            def cleanup(socket=socket):
                self._active_readers.pop(socket, None)
            def finish(socket=socket, state=state):
                state["handled"] = True
                self._active_readers.pop(socket, None)
            def read(socket=socket, buffer=buffer, state=state):
                if state["handled"] or state["reading"]:
                    return
                state["reading"] = True
                try:
                    if socket.state() == QLocalSocket.LocalSocketState.ConnectedState and socket.bytesAvailable() == 0 and b"\n" not in buffer:
                        socket.waitForReadyRead(0)
                    if state["handled"]:
                        return
                    buffer.extend(bytes(socket.readAll()))
                    if len(buffer) > 16384:
                        finish()
                        socket.disconnectFromServer()
                        return
                    if b"\n" not in buffer:
                        if socket.state() == QLocalSocket.LocalSocketState.UnconnectedState:
                            finish()
                        return
                    finish()
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
                    if socket.state() == QLocalSocket.LocalSocketState.ConnectedState:
                        socket.write(b"ok\n")
                        socket.flush()
                        if socket.state() == QLocalSocket.LocalSocketState.ConnectedState:
                            socket.waitForBytesWritten(500)
                    self.requested.emit(note)
                    socket.disconnectFromServer()
                finally:
                    state["reading"] = False
            self._active_readers[socket] = read
            socket.readyRead.connect(read)
            socket.disconnected.connect(cleanup)
            socket.disconnected.connect(socket.deleteLater)
            QTimer.singleShot(5000, socket, socket.disconnectFromServer)
            read()

    def stop_accepting(self):
        self._should_listen = False
        self._listen_watchdog.stop()
        self._active_readers.clear()
        self.server.close()
        while self.server.hasPendingConnections():
            pending = self.server.nextPendingConnection()
            if pending is not None:
                pending.disconnectFromServer()
                if pending.state() != QLocalSocket.LocalSocketState.UnconnectedState:
                    pending.abort()
        for child in self.findChildren(QLocalSocket):
            child.disconnectFromServer()
            if child.state() != QLocalSocket.LocalSocketState.UnconnectedState:
                child.abort()

    def close(self):
        self.stop_accepting()
        self.lock.unlock()
