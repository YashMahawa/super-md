"""Shared headless CLI argument parser, JSON stdout emitter, and heading selector."""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

try:
    from ..agent_stdio import configure_stdio
except ImportError:
    from agent_stdio import configure_stdio

MAX_CLI_OUTPUT = 64_000


class JSONArgumentParser(argparse.ArgumentParser):
    """ArgumentParser base that raises structured errors without stderr noise."""

    _error_cls: type[Exception] = ValueError
    _emit_error: bool = False

    def error(self, message: str):
        if self._emit_error:
            sys.stdout.write(
                json.dumps({"ok": False, "error": {"type": "UsageError", "message": message[:1000]}},
                           separators=(",", ":")) + "\n"
            )
        raise self._error_cls(message)


def make_json_argument_parser(
    error_cls: type[Exception], *, emit_error: bool = False,
) -> type[JSONArgumentParser]:
    """Bind a JSONArgumentParser subclass so subparsers inherit error behavior."""
    return type(
        "_BoundJSONArgumentParser",
        (JSONArgumentParser,),
        {"_error_cls": error_cls, "_emit_error": emit_error},
    )


def emit_json(
    value: dict[str, Any], *, max_bytes: int = MAX_CLI_OUTPUT,
    error_cls: type[Exception] = ValueError,
    message: str = "Response exceeded the 64 KB output limit; request a smaller page",
) -> None:
    """Write one bounded UTF-8 JSON line to stdout after reconfiguring pipes."""
    configure_stdio(stdin=False, stderr=False)
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > max_bytes:
        raise error_cls(message)
    sys.stdout.write(encoded + "\n")


def heading_selector(value: str | None) -> int | str | None:
    """Parse an ASCII nonnegative decimal outline index or preserve string selector."""
    if value is None:
        return None
    if value.isascii() and value.isdecimal():
        return int(value)
    return value
