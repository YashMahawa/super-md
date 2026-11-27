"""UTF-8 stdio setup for the headless agent commands."""
from __future__ import annotations

import sys


def configure_stream(stream) -> None:
    """Use UTF-8 when the stream supports reconfiguration; keep StringIO intact."""
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8")


def configure_stdio(*, stdin: bool = True, stdout: bool = True, stderr: bool = True) -> None:
    """Set the CLI streams to UTF-8 before they are read from or written to."""
    if stdin:
        configure_stream(sys.stdin)
    if stdout:
        configure_stream(sys.stdout)
    if stderr:
        configure_stream(sys.stderr)
