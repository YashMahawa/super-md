"""One process owns native preferences/recovery; subsequent launches open a window."""
from collections import deque
import errno
import hashlib
import json
import os
import socket
import threading
import time
from pathlib import Path
from PySide6.QtCore import QDir, QLockFile, QMetaMethod, QObject, QStandardPaths, QTimer, QUrl, Qt, Signal, Slot
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


def posix_socket_path(name: str) -> str:
    if os.path.isabs(name):
        return name
    return os.path.join(QDir.tempPath(), name)


def remove_local_server(name: str) -> None:
    if os.name == "nt":
        QLocalServer.removeServer(name)
        return
    path = posix_socket_path(name)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError:
        QLocalServer.removeServer(name)


def posix_ipc_exchange(
    name: str,
    payload: bytes,
    *,
    connect_timeout: float = 1.0,
    read_timeout: float = 2.0,
) -> tuple[bool, bytes, bool]:
    """Exchange one newline-delimited IPC frame over AF_UNIX.

    Returns (connected, raw_bytes, peer_closed). Interoperates directly with both
    _PosixLocalServer and Qt's QLocalServer on macOS and Linux without relying on
    QCFSocketNotifier.
    """
    path = posix_socket_path(name)
    connect_deadline = time.monotonic() + max(0.0, connect_timeout)
    retry_errnos = {errno.EINTR, errno.EAGAIN, errno.EWOULDBLOCK}
    sock = None
    while True:
        candidate = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            os.set_inheritable(candidate.fileno(), False)
            remaining = max(0.05, connect_deadline - time.monotonic())
            candidate.settimeout(remaining)
            candidate.connect(path)
            sock = candidate
            break
        except TimeoutError:
            try:
                candidate.close()
            except OSError:
                pass
            return (False, b"", True)
        except OSError as exc:
            try:
                candidate.close()
            except OSError:
                pass
            if exc.errno in retry_errnos and time.monotonic() < connect_deadline:
                time.sleep(0.01)
                continue
            return (False, b"", True)
    try:
        sock.settimeout(1.0)
        sock.sendall(payload)
    except OSError:
        try:
            sock.close()
        except OSError:
            pass
        return (True, b"", True)
    raw = bytearray()
    peer_closed = False
    read_deadline = time.monotonic() + max(0.01, read_timeout)
    while b"\n" not in raw:
        remaining = read_deadline - time.monotonic()
        if remaining <= 0:
            break
        sock.settimeout(remaining)
        try:
            chunk = sock.recv(4096)
        except TimeoutError:
            break
        except OSError as exc:
            if exc.errno == errno.EINTR:
                continue
            peer_closed = True
            break
        if not chunk:
            peer_closed = True
            break
        raw.extend(chunk)
        if len(raw) > 65536:
            break
    try:
        sock.close()
    except OSError:
        pass
    return (True, bytes(raw), peer_closed)


class _NoopSignal:
    def connect(self, *_args, **_kwargs) -> None:
        pass

    def disconnect(self, *_args, **_kwargs) -> None:
        pass


class _PosixPendingConnection:
    """Accepted AF_UNIX client connection with its buffered request frame."""

    def __init__(self, conn: socket.socket, initial_data: bytes):
        self._conn = conn
        self._initial_data = initial_data
        self._closed = False
        self.readyRead = _NoopSignal()
        self.disconnected = _NoopSignal()

    def readAll(self) -> bytes:
        data, self._initial_data = self._initial_data, b""
        return data

    def state(self):
        return (
            QLocalSocket.LocalSocketState.UnconnectedState
            if self._closed
            else QLocalSocket.LocalSocketState.ConnectedState
        )

    def write(self, data: bytes) -> int:
        if self._closed:
            return -1
        payload = bytes(data)
        try:
            self._conn.settimeout(1.0)
            self._conn.sendall(payload)
            return len(payload)
        except OSError:
            self._closed = True
            return -1

    def flush(self) -> bool:
        return not self._closed

    def waitForBytesWritten(self, _msec: int = 500) -> bool:
        return not self._closed

    def disconnectFromServer(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._conn.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        try:
            self._conn.close()
        except OSError:
            pass

    def abort(self) -> None:
        self._closed = True
        try:
            self._conn.close()
        except OSError:
            pass

    def deleteLater(self) -> None:
        self.disconnectFromServer()


class _PosixLocalServer(QObject):
    """Thread-backed AF_UNIX server avoiding macOS offscreen QCFSocketNotifier stalls and QTBUG-27239."""

    newConnection = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._lock = threading.Lock()
        self._sock: socket.socket | None = None
        self._bound_path: str = ""
        self._listening = False
        self._error = ""
        self._generation = 0
        self._pending: deque[_PosixPendingConnection] = deque()
        self._inflight_conns: set[socket.socket] = set()

    def setSocketOptions(self, _options) -> None:
        pass

    def isListening(self) -> bool:
        with self._lock:
            return bool(self._listening and self._sock is not None)

    def errorString(self) -> str:
        with self._lock:
            return self._error

    def hasPendingConnections(self) -> bool:
        with self._lock:
            return bool(self._pending)

    def nextPendingConnection(self) -> _PosixPendingConnection | None:
        with self._lock:
            return self._pending.popleft() if self._pending else None

    def waitForNewConnection(self, _msec: int = 0) -> bool:
        return self.hasPendingConnections()

    def listen(self, name: str) -> bool:
        self.close()
        path = posix_socket_path(name)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            os.set_inheritable(sock.fileno(), False)
            sock.bind(path)
            os.chmod(path, 0o700)
            sock.listen(64)
            sock.settimeout(0.2)
        except OSError as exc:
            with self._lock:
                self._error = str(exc)
            try:
                sock.close()
            except OSError:
                pass
            return False
        with self._lock:
            self._sock = sock
            self._bound_path = path
            self._listening = True
            self._error = ""
            self._generation += 1
            gen = self._generation
        threading.Thread(
            target=self._accept_loop,
            args=(sock, gen),
            name=f"supermd-ipc-accept-{gen}",
            daemon=True,
        ).start()
        return True

    def _accept_loop(self, sock: socket.socket, gen: int) -> None:
        transient = {
            errno.EINTR,
            errno.EAGAIN,
            errno.EWOULDBLOCK,
            getattr(errno, "ECONNABORTED", 53),
            getattr(errno, "EPROTO", 71),
        }
        while True:
            with self._lock:
                if not self._listening or self._generation != gen or self._sock is not sock:
                    return
            try:
                conn, _ = sock.accept()
            except TimeoutError:
                continue
            except OSError as exc:
                with self._lock:
                    still_active = self._listening and self._generation != -1 and self._generation == gen and self._sock is sock
                if not still_active:
                    return
                if exc.errno in transient:
                    continue
                with self._lock:
                    if self._listening and self._generation == gen and self._sock is sock:
                        self._error = str(exc)
                        self._listening = False
                        self._sock = None
                try:
                    sock.close()
                except OSError:
                    pass
                return
            try:
                os.set_inheritable(conn.fileno(), False)
            except OSError:
                pass
            with self._lock:
                if not self._listening or self._generation != gen:
                    try:
                        conn.close()
                    except OSError:
                        pass
                    return
                self._inflight_conns.add(conn)
            threading.Thread(
                target=self._read_client,
                args=(conn, gen),
                daemon=True,
            ).start()

    def _read_client(self, conn: socket.socket, gen: int) -> None:
        enqueued = False
        try:
            deadline = time.monotonic() + 5.0
            buffer = bytearray()
            while b"\n" not in buffer:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                conn.settimeout(remaining)
                try:
                    chunk = conn.recv(4096)
                except TimeoutError:
                    return
                except OSError as exc:
                    if exc.errno == errno.EINTR:
                        continue
                    return
                if not chunk:
                    return
                buffer.extend(chunk)
                if len(buffer) > 16384:
                    return
            with self._lock:
                if not self._listening or self._generation != gen:
                    return
                self._pending.append(_PosixPendingConnection(conn, bytes(buffer)))
                enqueued = True
            try:
                self.newConnection.emit()
            except RuntimeError:
                pass
        finally:
            with self._lock:
                self._inflight_conns.discard(conn)
            if not enqueued:
                try:
                    conn.close()
                except OSError:
                    pass

    def close(self) -> None:
        with self._lock:
            self._listening = False
            self._error = ""
            self._generation += 1
            sock, self._sock = self._sock, None
            bound_path, self._bound_path = self._bound_path, ""
            inflight = list(self._inflight_conns)
            self._inflight_conns.clear()
            pending = list(self._pending)
            self._pending.clear()
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
        if bound_path:
            try:
                os.unlink(bound_path)
            except OSError:
                pass
        for conn in inflight:
            try:
                conn.close()
            except OSError:
                pass
        for item in pending:
            item.abort()


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
        if os.name == "nt":
            self.server = QLocalServer(self)
            self.server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
            self.server.newConnection.connect(self.accept)
        else:
            self.server = _PosixLocalServer(self)
            self.server.newConnection.connect(self.accept, Qt.ConnectionType.QueuedConnection)
        self._should_listen = False
        self._listen_watchdog = QTimer(self)
        self._listen_watchdog.setInterval(50)
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
        remove_local_server(self.name)  # Only the exclusive owner may remove a stale socket.
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
            remove_local_server(self.name)
            if not self.server.listen(self.name):
                return
        if self.server.hasPendingConnections() and self.server.isSignalConnected(
            QMetaMethod.fromSignal(self.server.newConnection)
        ):
            self.accept()

    def claim_or_forward(self, note, *, defer_listen: bool = False, open_existing: bool = True):
        if self.lock.tryLock(0):
            return True if defer_listen else self.start_listening()
        if os.name != "nt":
            if not open_existing:
                payload = b'{"service":"status"}\n'
            else:
                url = QUrl(note or "")
                local = url.toLocalFile() if url.isLocalFile() else note
                payload = json.dumps({"note": str(Path(local).resolve()) if local else ""}).encode() + b"\n"
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                connected, raw, peer_closed = posix_ipc_exchange(
                    self.name,
                    payload,
                    connect_timeout=0.4,
                    read_timeout=0.5 if not open_existing else 2.0,
                )
                if connected:
                    if not open_existing:
                        return False
                    if raw == b"ok\n":
                        return False
                    if not raw and peer_closed and self.lock.tryLock(100):
                        return True if defer_listen else self.start_listening()
                    raise RuntimeError("The existing Super MD process did not acknowledge the new window")
                if self.lock.tryLock(100):
                    return True if defer_listen else self.start_listening()
            raise RuntimeError("Super MD is starting or busy. Please try opening the note again.")
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

    @Slot()
    def accept(self):
        while self.server.hasPendingConnections():
            socket = self.server.nextPendingConnection()
            if socket is None:
                continue
            buffer = bytearray()
            state = {"handled": False, "reading": False}
            def finish(state=state):
                state["handled"] = True
            def read(socket=socket, buffer=buffer, state=state):
                if state["handled"] or state["reading"]:
                    return
                state["reading"] = True
                try:
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
            socket.readyRead.connect(read)
            socket.disconnected.connect(socket.deleteLater)
            if isinstance(socket, QLocalSocket):
                QTimer.singleShot(5000, socket, socket.disconnectFromServer)
            read()

    def stop_accepting(self):
        self._should_listen = False
        self._listen_watchdog.stop()
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
