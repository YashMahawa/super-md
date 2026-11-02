"""Safe native writer for a Markdown export and its referenced media."""
from __future__ import annotations

import os
import re
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from documents import image_data, MAX_IMAGE, MIMES

MAX_ASSETS = 512
MAX_ASSET_TOTAL = 110_000_000


def _asset_destination(root: Path, name: str) -> Path:
    if (not isinstance(name, str) or not name or "\\" in name or "\0" in name
            or name.startswith("/") or re.match(r"^[a-zA-Z]:", name)):
        raise ValueError("Markdown asset path must be a safe relative path")
    relative = PurePosixPath(name)
    if any(part in ("", ".", "..") for part in relative.parts):
        raise ValueError("Markdown asset path cannot contain traversal components")
    if any(re.search(r'[<>:"|?*\x00-\x1f]', part) or part.endswith((".", " "))
           or re.match(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part, re.IGNORECASE)
           for part in relative.parts):
        raise ValueError("Markdown asset path contains a filename that is not portable")
    destination = root.joinpath(*relative.parts)
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Markdown assets cannot be written through symlink paths")
    root_resolved = root.resolve(strict=True)
    parent_resolved = destination.parent.resolve(strict=False)
    if parent_resolved != root_resolved and not parent_resolved.is_relative_to(root_resolved):
        raise ValueError("Markdown asset path escapes the export folder")
    return destination


def write_markdown_export(output: str | os.PathLike[str], content: str, assets: dict[str, str] | None = None,
                          *, create_only: bool = False) -> None:
    """Write Markdown plus image data URLs without overwriting conflicting files.

    Assets use paths relative to the Markdown file's directory. Existing files
    are retained when byte-identical and rejected when they conflict.
    """
    target = Path(output)
    if not target.parent.is_dir():
        raise ValueError("The Markdown destination folder is unavailable")
    if target.is_symlink():
        raise ValueError("Refusing to write Markdown through a symlink")
    if create_only and target.exists():
        raise FileExistsError(f"Markdown output already exists: {target.name}")
    if not isinstance(content, str) or len(content.encode("utf-8")) > 20_000_000:
        raise ValueError("Markdown content must be under 20 MB")
    if not isinstance(assets, dict) or len(assets) > MAX_ASSETS:
        raise ValueError("Markdown export assets are invalid")
    prepared: list[tuple[Path, bytes]] = []
    total = 0
    for name, value in assets.items():
        if not isinstance(name, str) or not isinstance(value, str):
            raise ValueError("Markdown export assets are invalid")
        try:
            mime, payload = image_data(value)
        except (TypeError, ValueError) as error:
            raise ValueError("Markdown export assets must be valid image data URLs") from error
        if len(payload) > MAX_IMAGE:
            raise ValueError("Markdown asset exceeds 25 MB")
        if MIMES.get(PurePosixPath(name).suffix.lower().lstrip(".")) != mime:
            raise ValueError("Markdown asset MIME does not match its filename")
        total += len(payload)
        if total > MAX_ASSET_TOTAL:
            raise ValueError("Markdown export assets exceed the bounded total size")
        destination = _asset_destination(target.parent, name)
        prepared.append((destination, payload))

    # Validate all collisions before publishing any bytes. Identical existing
    # assets are safe to reuse; different content is never silently replaced.
    for destination, payload in prepared:
        if destination.exists():
            if not destination.is_file() or destination.read_bytes() != payload:
                raise FileExistsError(f"Markdown asset already exists with different contents: {destination.name}")

    created: list[Path] = []
    stage: Path | None = None
    try:
        for destination, payload in prepared:
            if destination.exists():
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            _asset_destination(target.parent, destination.relative_to(target.parent).as_posix())
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            created.append(destination)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
        if target.is_symlink():
            raise ValueError("Refusing to write Markdown through a symlink")
        descriptor, stage_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".stage", dir=target.parent)
        stage = Path(stage_name)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content.encode("utf-8"))
            stream.flush()
            if target.exists() and hasattr(os, "fchmod"):
                os.fchmod(stream.fileno(), stat.S_IMODE(target.stat().st_mode))
            os.fsync(stream.fileno())
        if create_only:
            os.link(stage, target)
        else:
            os.replace(stage, target)
    except Exception:
        for path in created:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        raise
    finally:
        if stage is not None:
            stage.unlink(missing_ok=True)


def write_markdown_zip(output: str | os.PathLike[str], content: str, assets: dict[str, str] | None = None,
                       *, create_only: bool = False, markdown_filename: str | None = None) -> None:
    """Write a single archive with Markdown at its root and safe relative media."""
    target = Path(output)
    if not target.parent.is_dir():
        raise ValueError("The ZIP destination folder is unavailable")
    if not isinstance(content, str) or len(content.encode("utf-8")) > 20_000_000:
        raise ValueError("Markdown content must be under 20 MB")
    if not isinstance(assets, dict) or len(assets) > MAX_ASSETS:
        raise ValueError("Markdown export assets are invalid")
    prepared: list[tuple[str, bytes]] = []
    total = 0
    for name, value in assets.items():
        if not isinstance(name, str) or not isinstance(value, str):
            raise ValueError("Markdown export assets are invalid")
        try:
            mime, payload = image_data(value)
        except (TypeError, ValueError) as error:
            raise ValueError("Markdown export assets must be valid image data URLs") from error
        if len(payload) > MAX_IMAGE:
            raise ValueError("Markdown asset exceeds 25 MB")
        if MIMES.get(PurePosixPath(name).suffix.lower().lstrip(".")) != mime:
            raise ValueError("Markdown asset MIME does not match its filename")
        total += len(payload)
        if total > MAX_ASSET_TOTAL:
            raise ValueError("Markdown export assets exceed the bounded total size")
        _asset_destination(target.parent, name)
        prepared.append((name, payload))
    if target.is_symlink():
        raise ValueError("Refusing to write a ZIP through a symlink")
    if create_only and target.exists():
        raise FileExistsError(f"ZIP output already exists: {target.name}")
    fd, stage_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".stage", dir=target.parent)
    os.close(fd)
    stage = Path(stage_name)
    try:
        with zipfile.ZipFile(stage, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.writestr(markdown_filename or Path(target.name).stem + ".md", content.encode("utf-8"))
            for name, payload in prepared:
                archive.writestr(name, payload)
        with stage.open("rb") as stream:
            os.fsync(stream.fileno())
        if create_only:
            os.link(stage, target)
        else:
            os.replace(stage, target)
    finally:
        stage.unlink(missing_ok=True)
