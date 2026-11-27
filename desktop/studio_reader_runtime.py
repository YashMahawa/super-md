"""Reader runtime helpers for Studio: SSRF-safe networking, note assets, tab lookup, PDF engine, and Python cells."""
from __future__ import annotations

import base64
import http.client
import ipaddress
import os
import socket
import sys
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path

from PySide6.QtCore import QUrl

if __package__:
    from . import folder_ops, python_runtime
    from .core.paths import resource_root
    from .documents import MAX_IMAGE, MIMES
    from .network_tls import client_context
else:
    import folder_ops
    import python_runtime
    from core.paths import resource_root
    from documents import MAX_IMAGE, MIMES
    from network_tls import client_context


def public_address(url: str) -> str:
    """Resolve once and return a global IP for the URL's host, or refuse."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Use a public web URL")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(address[4][0]).is_global for address in addresses):
        raise ValueError("Private, local and reserved network addresses are not allowed")
    return addresses[0][4][0]


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, *args, pinned="", **kwargs):
        super().__init__(host, *args, **kwargs)
        self.pinned = pinned

    def connect(self):
        self.sock = socket.create_connection((self.pinned, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, *args, pinned="", **kwargs):
        super().__init__(host, *args, **kwargs)
        self.pinned = pinned

    def connect(self):
        # TLS still verifies the certificate against the requested hostname.
        raw_sock = socket.create_connection((self.pinned, self.port), self.timeout)
        self.sock = self._context.wrap_socket(raw_sock, server_hostname=self.host)


class PinnedHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, debuglevel: int = 0, *, public_address_fn: Callable[[str], str] | None = None, connection_cls=None):
        super().__init__(debuglevel)
        self._public_address_fn = public_address_fn
        self._connection_cls = connection_cls

    def http_open(self, request, *, public_address_fn=None, connection_cls=None):
        resolve_addr = public_address_fn or self._public_address_fn or public_address
        conn_cls = connection_cls or self._connection_cls or _PinnedHTTPConnection
        pinned = resolve_addr(request.full_url)
        return self.do_open(lambda host, **kwargs: conn_cls(host, pinned=pinned, **kwargs), request)


class PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(
        self, debuglevel: int = 0, context=None, check_hostname=None, *,
        public_address_fn: Callable[[str], str] | None = None, connection_cls=None, client_context_fn: Callable | None = None,
    ):
        super().__init__(debuglevel, context=context, check_hostname=check_hostname)
        self._public_address_fn = public_address_fn
        self._connection_cls = connection_cls
        self._client_context_fn = client_context_fn

    def https_open(self, request, *, public_address_fn=None, connection_cls=None, client_context_fn=None):
        resolve_addr = public_address_fn or self._public_address_fn or public_address
        conn_cls = connection_cls or self._connection_cls or _PinnedHTTPSConnection
        ctx_fn = client_context_fn or self._client_context_fn or client_context
        pinned = resolve_addr(request.full_url)
        return self.do_open(lambda host, **kwargs: conn_cls(host, pinned=pinned, **kwargs), request, context=ctx_fn())


def reader_crashed(studio_obj) -> None:
    if studio_obj.retired:
        return
    # Native tab text and persisted positions are authoritative. Reloading
    # a renderer must not restore an older recovery snapshot or run cells.
    studio_obj.ready = False
    studio_obj._last_reader_text = None
    if hasattr(studio_obj, "_last_reader_agent_seq"):
        studio_obj._last_reader_agent_seq.clear()
    studio_obj.reader_overlay = False
    studio_obj.image_overlay = False
    studio_obj._emit(False)


def _resolve_contained_note_asset(
    tab, relative_path: str, *, missing_note_msg: str, outside_msg: str,
    max_bytes: int, size_msg: str, reject_symlinks: bool = False,
) -> Path:
    if not tab.get("path"):
        raise ValueError(missing_note_msg)
    root = Path(tab["path"]).parent.resolve()
    requested = root / relative_path
    if reject_symlinks:
        current = root
        for part in Path(relative_path).parts:
            current = current / part
            if current.is_symlink():
                raise ValueError("Diagram source symlink paths are not allowed")
        path = requested.resolve(strict=True)
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError(outside_msg)
    else:
        path = requested.resolve()
        if not path.is_relative_to(root):
            raise ValueError(outside_msg)
    if path.stat().st_size > max_bytes:
        raise ValueError(size_msg)
    return path


def resolve_image_asset(studio_obj, tab, source, *, max_image_bytes: int = MAX_IMAGE, mimes: dict[str, str] = MIMES) -> str:
    if source in tab["assets"]:
        return tab["assets"][source]
    path = _resolve_contained_note_asset(
        tab, urllib.parse.unquote(source),
        missing_note_msg="Save this note to resolve relative images",
        outside_msg="Image is outside the note folder",
        max_bytes=max_image_bytes, size_msg="Image exceeds 25 MB",
    )
    mime = mimes.get(path.suffix[1:].lower())
    if not mime:
        raise ValueError("Unsupported image type")
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def resolve_text_asset(studio_obj, tab, source) -> str:
    if not isinstance(source, str) or len(source) > 4096 or Path(source).suffix.lower() not in (".mmd", ".mermaid"):
        raise ValueError("Only local .mmd or .mermaid source files can be inlined")
    relative = urllib.parse.unquote(source.split("#", 1)[0].split("?", 1)[0])
    path = _resolve_contained_note_asset(
        tab, relative,
        missing_note_msg="Save this note to resolve relative diagram source files",
        outside_msg="Diagram source is outside the note folder",
        max_bytes=2_000_000, size_msg="Diagram source exceeds 2 MB",
        reject_symlinks=True,
    )
    return path.read_text(encoding="utf-8")


def _default_local_path(value: str) -> Path:
    url = QUrl(value)
    resolved = Path(url.toLocalFile() if url.isLocalFile() else value).expanduser().resolve()
    return Path(folder_ops.strip_extended_length_prefix(str(resolved)))


def find_open_tab(
    studio_obj, reference, *, canonicalize_local: bool = False,
    local_path_fn: Callable[[str], Path] = _default_local_path,
):
    if not isinstance(reference, str) or not reference:
        return None
    match = next((item for item in studio_obj.tabs if reference in (item["id"], item["path"])), None)
    if match is not None or not canonicalize_local or "\x00" in reference:
        return match
    try:
        if QUrl(reference).isLocalFile() or Path(reference).is_absolute():
            canonical = str(local_path_fn(reference))
            exact = next(
                (item for item in studio_obj.tabs if item["path"] == canonical or (item["path"] and folder_ops.same_path(item["path"], canonical))),
                None,
            )
            if exact is not None:
                return exact
            return next(
                (item for item in studio_obj.tabs if item["path"] and not Path(item["path"]).is_symlink() and os.path.samefile(item["path"], canonical)),
                None,
            )
    except OSError:
        pass
    return None


def fetch_public_resource(
    studio_obj, args, *,
    public_address_fn: Callable[[str], str] = public_address,
    http_handler_cls=PinnedHTTPHandler,
    https_handler_cls=PinnedHTTPSHandler,
    max_image_bytes: int = MAX_IMAGE,
    mimes: dict[str, str] = MIMES,
) -> dict[str, str]:
    url = args["url"]
    owner = studio_obj
    (owner._public_url if hasattr(owner, "_public_url") else public_address_fn)(url)

    class PublicRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            (owner._public_url if hasattr(owner, "_public_url") else public_address_fn)(newurl)
            return super().redirect_request(request, fp, code, msg, headers, newurl)

    # Connect to the exact address that was validated. Resolving again in
    # the socket layer would allow DNS rebinding onto a private network.
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), http_handler_cls(), https_handler_cls(), PublicRedirect()
    )
    request = urllib.request.Request(url, headers={"User-Agent": "SuperMD/Qt"})
    limit = max_image_bytes if args.get("image") else 2_000_000
    with opener.open(request, timeout=20) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Resource is too large")
        if args.get("image"):
            mime = response.headers.get_content_type()
            if mime not in mimes.values():
                raise ValueError("URL did not return a supported image")
            return {"body": f"data:{mime};base64,{base64.b64encode(data).decode()}"}
        return {"body": data.decode("utf-8", errors="replace")}


def resolve_pdf_engine(studio_obj=None, *, root_dir: Path | None = None, sys_platform: str | None = None) -> Path:
    executable = "smd-engine.exe" if (sys.platform if sys_platform is None else sys_platform) == "win32" else "smd-engine"
    root = resource_root() if root_dir is None else root_dir
    candidates = [root / "desktop" / executable, root / "smd-core" / "target" / "release" / executable, root / "smd-core" / "target" / "debug" / executable]
    for path in candidates:
        if path.is_file():
            return path
    raise ValueError("Native PDF engine is not installed. Build smd-core's smd-engine binary.")


def run_python_cell(studio_obj, executable, code, folder=None, job=None, *, run_fn: Callable | None = None):
    # Explicit Run only. Python is trusted local code, not a sandbox.
    runner = python_runtime.run if run_fn is None else run_fn
    owned_job = None
    if job is None and hasattr(studio_obj, "_python_jobs"):
        owned_job = studio_obj._python_jobs.register("")
        job = owned_job
    try:
        return runner(executable or studio_obj.settings["python"], code, cwd=folder, job=job)
    finally:
        if owned_job is not None:
            studio_obj._python_jobs.discard(owned_job)
