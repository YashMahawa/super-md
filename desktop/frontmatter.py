"""Unified top-of-file YAML frontmatter boundary and mapping validator."""
from __future__ import annotations

import re

_BLOCK_SCALAR_HEADER = re.compile(r"^([|>])(?:([+-])([1-9])?|([1-9])([+-])?)?[ \t]*(?:#.*)?$")
_CLOSER = re.compile(r"^(?:---|\.\.\.)[ \t]*$")
_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")
_SIMPLE_ESCAPES = {'"': '"', "\\": "\\", "/": "/", "n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "0": "\0", " ": " "}


def _parse_double_quoted(text: str) -> tuple[str, str] | None:
    if not text.startswith('"'):
        return None
    i = 1
    out: list[str] = []
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '"':
            return "".join(out), text[i + 1:]
        if ch == "\\":
            i += 1
            if i >= n:
                return None
            esc = text[i]
            if esc in _SIMPLE_ESCAPES:
                out.append(_SIMPLE_ESCAPES[esc])
                i += 1
                continue
            if esc == "\n":
                i += 1
                while i < n and text[i] in (" ", "\t"):
                    i += 1
                continue
            if esc in ("x", "u", "U"):
                width = 2 if esc == "x" else (4 if esc == "u" else 8)
                hex_part = text[i + 1:i + 1 + width]
                if len(hex_part) != width or not all(c in _HEX_DIGITS for c in hex_part):
                    return None
                cp = int(hex_part, 16)
                if cp > 0x10FFFF or 0xD800 <= cp <= 0xDFFF:
                    return None
                out.append(chr(cp))
                i += 1 + width
                continue
            out.append(esc)
            i += 1
            continue
        if ch == "\n":
            while out and out[-1] in (" ", "\t"):
                out.pop()
            i += 1
            while i < n and text[i] in (" ", "\t"):
                i += 1
            out.append(" ")
            continue
        out.append(ch)
        i += 1
    return None


def _parse_single_quoted(text: str) -> tuple[str, str] | None:
    if not text.startswith("'"):
        return None
    i = 1
    n = len(text)
    out: list[str] = []
    while i < n:
        ch = text[i]
        if ch == "'":
            if i + 1 < n and text[i + 1] == "'":
                out.append("'")
                i += 2
                continue
            return "".join(out), text[i + 1:]
        if ch == "\n":
            while out and out[-1] in (" ", "\t"):
                out.pop()
            i += 1
            while i < n and text[i] in (" ", "\t"):
                i += 1
            out.append(" ")
            continue
        out.append(ch)
        i += 1
    return None


def _only_trailing_comment(rest: str) -> bool:
    trimmed = rest.lstrip()
    return trimmed == "" or trimmed.startswith("#")


def _split_key_value(trimmed: str, allow_compact: bool = False) -> tuple[str, str] | None:
    if not trimmed or trimmed.startswith("#"):
        return None
    if trimmed == "-" or trimmed.startswith(("- ", "-\t")):
        return None
    if trimmed[0] in "\"'":
        parsed = _parse_double_quoted(trimmed) if trimmed[0] == '"' else _parse_single_quoted(trimmed)
        if not parsed:
            return None
        key, rest = parsed
        after = rest.lstrip()
        if not after.startswith(":"):
            return None
        post = after[1:]
        if not allow_compact and post and post[0] not in (" ", "\t"):
            return None
        return key, post.lstrip()
    if trimmed[0] in "[]{}|>*&!%@":
        return None
    for idx, ch in enumerate(trimmed):
        if ch != ":":
            continue
        after = trimmed[idx + 1:]
        if allow_compact or not after or after[0] in (" ", "\t"):
            key = trimmed[:idx].strip()
            if not key or any(c in key for c in "[]{}\"'"):
                return None
            return key, after.lstrip()
    return None


def _strip_flow_comment(line: str) -> str:
    in_single = False
    in_double = False
    i = 0
    n = len(line)
    while i < n:
        ch = line[i]
        if in_double:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_double = False
            i += 1
            continue
        if in_single:
            if ch == "'":
                if i + 1 < n and line[i + 1] == "'":
                    i += 2
                    continue
                in_single = False
            i += 1
            continue
        if ch == '"':
            in_double = True
        elif ch == "'":
            in_single = True
        elif ch == "#" and (i == 0 or line[i - 1] in (" ", "\t")):
            return line[:i].rstrip()
        i += 1
    return line


def _flow_state(text: str) -> str:
    depth_bracket = 0
    depth_brace = 0
    in_single = False
    in_double = False
    closed_top = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if in_double:
            if ch == "\\":
                if i + 1 >= n:
                    return "incomplete"
                i += 2
                continue
            if ch == '"':
                in_double = False
            i += 1
            continue
        if in_single:
            if ch == "'":
                if i + 1 < n and text[i + 1] == "'":
                    i += 2
                    continue
                in_single = False
            i += 1
            continue
        if closed_top:
            if ch in (" ", "\t"):
                i += 1
                continue
            if ch == "#":
                break
            return "error"
        if ch == '"':
            in_double = True
        elif ch == "'":
            in_single = True
        elif ch == "[":
            depth_bracket += 1
        elif ch == "]":
            depth_bracket -= 1
            if depth_bracket < 0:
                return "error"
            if depth_bracket == 0 and depth_brace == 0:
                closed_top = True
        elif ch == "{":
            depth_brace += 1
        elif ch == "}":
            depth_brace -= 1
            if depth_brace < 0:
                return "error"
            if depth_bracket == 0 and depth_brace == 0:
                closed_top = True
        i += 1
    if in_single or in_double or depth_bracket > 0 or depth_brace > 0:
        return "incomplete"
    return "balanced" if closed_top else "incomplete"


def _split_top_level_commas(inner: str) -> list[str] | None:
    parts: list[str] = []
    start = 0
    depth_bracket = 0
    depth_brace = 0
    i = 0
    n = len(inner)
    while i < n:
        ch = inner[i]
        if ch == '"':
            parsed = _parse_double_quoted(inner[i:])
            if parsed is None:
                return None
            i = n - len(parsed[1])
            continue
        if ch == "'":
            parsed = _parse_single_quoted(inner[i:])
            if parsed is None:
                return None
            i = n - len(parsed[1])
            continue
        if ch == "[":
            depth_bracket += 1
        elif ch == "]":
            depth_bracket -= 1
            if depth_bracket < 0:
                return None
        elif ch == "{":
            depth_brace += 1
        elif ch == "}":
            depth_brace -= 1
            if depth_brace < 0:
                return None
        elif ch == "," and depth_bracket == 0 and depth_brace == 0:
            parts.append(inner[start:i])
            start = i + 1
        i += 1
    if depth_bracket != 0 or depth_brace != 0:
        return None
    parts.append(inner[start:])
    return parts


def _is_valid_flow_value(raw: str) -> bool:
    trimmed = raw.strip()
    if not trimmed:
        return True
    if trimmed.startswith('"'):
        parsed = _parse_double_quoted(trimmed)
        return parsed is not None and _only_trailing_comment(parsed[1])
    if trimmed.startswith("'"):
        parsed = _parse_single_quoted(trimmed)
        return parsed is not None and _only_trailing_comment(parsed[1])
    if trimmed.startswith("["):
        if not trimmed.endswith("]"):
            return False
        inner = trimmed[1:-1].strip()
        if not inner:
            return True
        items = _split_top_level_commas(inner)
        return items is not None and all(not item.strip() or _is_valid_flow_value(item) for item in items)
    if trimmed.startswith("{"):
        if not trimmed.endswith("}"):
            return False
        inner = trimmed[1:-1].strip()
        if not inner:
            return True
        pairs = _split_top_level_commas(inner)
        if pairs is None:
            return False
        for pair in pairs:
            if not pair.strip():
                continue
            kv = _split_key_value(pair.strip(), True)
            if kv is None or not _is_valid_flow_value(kv[1]):
                return False
        return True
    if any(c in trimmed for c in "[]{}") and _split_top_level_commas(trimmed) is None:
        return False
    return True


def _is_valid_yaml_mapping(yaml_body: str) -> bool:
    if not yaml_body:
        return True
    lines: list[tuple[str, int, str]] = []
    for raw_line in yaml_body.split("\n"):
        raw = raw_line.removesuffix("\r")
        indent = 0
        leading_tab = False
        for ch in raw:
            if ch == " ":
                indent += 1
            elif ch == "\t":
                leading_tab = True
                break
            else:
                break
        trimmed = raw.strip()
        if leading_tab and trimmed and not trimmed.startswith("#"):
            return False
        lines.append((raw, indent, trimmed))

    def is_blank(idx: int) -> bool:
        return lines[idx][2] == "" or lines[idx][2].startswith("#")

    def next_meaningful(idx: int) -> int:
        while idx < len(lines) and is_blank(idx):
            idx += 1
        return idx

    def seq_item(trimmed: str) -> str | None:
        if trimmed == "-":
            return ""
        if trimmed.startswith(("- ", "-\t")):
            return trimmed[1:].lstrip()
        return None

    def consume_quoted(idx: int, initial: str, min_indent: int) -> int | None:
        comb = initial
        is_double = initial.startswith('"')
        while True:
            parsed = _parse_double_quoted(comb) if is_double else _parse_single_quoted(comb)
            if parsed is not None:
                return idx + 1 if _only_trailing_comment(parsed[1]) else None
            idx += 1
            if idx >= len(lines):
                return None
            if lines[idx][2] == "":
                comb += "\n"
                continue
            if lines[idx][1] < min_indent:
                return None
            comb += "\n" + lines[idx][2]

    def consume_flow(idx: int, initial: str, min_indent: int) -> int | None:
        comb = _strip_flow_comment(initial)
        while True:
            state = _flow_state(comb)
            if state == "error":
                return None
            if state == "balanced":
                return idx + 1 if _is_valid_flow_value(comb) else None
            idx += 1
            if idx >= len(lines):
                return None
            if is_blank(idx):
                continue
            if lines[idx][1] < min_indent:
                return None
            comb += " " + _strip_flow_comment(lines[idx][2])

    def consume_block_scalar(idx: int, header: str, parent_indent: int) -> int | None:
        if not _BLOCK_SCALAR_HEADER.match(header):
            return None
        idx += 1
        while idx < len(lines):
            if lines[idx][2] == "":
                idx += 1
                continue
            if lines[idx][1] <= parent_indent:
                break
            idx += 1
        return idx

    def consume_value(idx: int, rest: str, key_indent: int) -> int | None:
        if rest == "" or rest.startswith("#"):
            nxt = next_meaningful(idx + 1)
            if nxt >= len(lines):
                return len(lines)
            _, n_indent, n_trimmed = lines[nxt]
            if n_indent >= key_indent and seq_item(n_trimmed) is not None:
                return consume_seq(nxt, n_indent)
            if n_indent > key_indent:
                if _split_key_value(n_trimmed) is not None:
                    return consume_map(nxt, n_indent)
                cur = nxt
                while cur < len(lines):
                    if is_blank(cur):
                        cur += 1
                        continue
                    if lines[cur][1] <= key_indent:
                        break
                    if _split_key_value(lines[cur][2]) is not None or seq_item(lines[cur][2]) is not None:
                        break
                    cur += 1
                return cur
            return nxt
        if rest[0] in "|>":
            return consume_block_scalar(idx, rest, key_indent)
        if rest[0] in "\"'":
            return consume_quoted(idx, rest, key_indent + 1)
        if rest[0] in "[{":
            return consume_flow(idx, rest, key_indent)
        cur = idx + 1
        while cur < len(lines):
            if is_blank(cur) or lines[cur][1] <= key_indent:
                break
            if _split_key_value(lines[cur][2]) is not None or seq_item(lines[cur][2]) is not None:
                break
            cur += 1
        return cur

    def consume_seq(idx: int, seq_indent: int) -> int | None:
        while idx < len(lines):
            if is_blank(idx):
                idx += 1
                continue
            _, ind, trimmed = lines[idx]
            if ind < seq_indent:
                break
            if ind > seq_indent:
                return None
            item = seq_item(trimmed)
            if item is None:
                break
            if item == "" or item.startswith("#"):
                nxt = next_meaningful(idx + 1)
                if nxt < len(lines) and lines[nxt][1] > seq_indent:
                    if seq_item(lines[nxt][2]) is not None:
                        after = consume_seq(nxt, lines[nxt][1])
                        if after is None:
                            return None
                        idx = after
                        continue
                    if _split_key_value(lines[nxt][2]) is not None:
                        after = consume_map(nxt, lines[nxt][1])
                        if after is None:
                            return None
                        idx = after
                        continue
                idx = nxt
                continue
            kv = _split_key_value(item)
            if kv is not None:
                after_val = consume_value(idx, kv[1], seq_indent + 1)
                if after_val is None:
                    return None
                peek = next_meaningful(after_val)
                if peek < len(lines) and lines[peek][1] >= seq_indent + 2 and seq_item(lines[peek][2]) is None:
                    after_map = consume_map(peek, lines[peek][1])
                    if after_map is None:
                        return None
                    after_val = after_map
                idx = after_val
                continue
            if item[0] in "|>":
                after = consume_block_scalar(idx, item, seq_indent)
            elif item[0] in "\"'":
                after = consume_quoted(idx, item, seq_indent + 1)
            elif item[0] in "[{":
                after = consume_flow(idx, item, seq_indent + 1)
            else:
                after = idx + 1
            if after is None:
                return None
            idx = after
        return idx

    def consume_map(idx: int, map_indent: int) -> int | None:
        while idx < len(lines):
            if is_blank(idx):
                idx += 1
                continue
            _, ind, trimmed = lines[idx]
            if ind < map_indent:
                break
            if ind > map_indent:
                return None
            kv = _split_key_value(trimmed)
            if kv is None:
                return None
            after = consume_value(idx, kv[1], map_indent)
            if after is None:
                return None
            idx = after
        return idx

    first = next_meaningful(0)
    if first >= len(lines):
        return True
    if lines[first][1] != 0:
        return False
    end = consume_map(first, 0)
    return end is not None and next_meaningful(end) >= len(lines)


def frontmatter_end(markdown: str) -> int:
    """Return the character offset after valid top-of-file YAML frontmatter, or 0."""
    cursor = 1 if markdown.startswith("\ufeff") else 0
    if not markdown.startswith("---", cursor):
        return 0
    cursor += 3
    n = len(markdown)
    while cursor < n and markdown[cursor] in (" ", "\t"):
        cursor += 1
    if cursor + 1 < n and markdown[cursor:cursor + 2] == "\r\n":
        cursor += 2
    elif cursor < n and markdown[cursor] == "\n":
        cursor += 1
    else:
        return 0

    yaml_start = cursor
    line_start = cursor
    yaml_end = -1
    fm_end = -1
    while line_start <= n:
        nl = markdown.find("\n", line_start)
        if nl < 0:
            content_end = n
            next_start = n + 1
            full_end = n
        else:
            content_end = nl - 1 if nl > line_start and markdown[nl - 1] == "\r" else nl
            next_start = nl + 1
            full_end = nl + 1
        line = markdown[line_start:content_end]
        if _CLOSER.match(line):
            yaml_end = line_start
            fm_end = full_end
            break
        if nl < 0:
            break
        line_start = next_start

    if yaml_end < 0 or fm_end < 0:
        return 0
    yaml_slice = markdown[yaml_start:yaml_end]
    if yaml_slice.endswith("\n"):
        yaml_slice = yaml_slice[:-1].removesuffix("\r")
    if not _is_valid_yaml_mapping(yaml_slice):
        return 0
    return fm_end


def mask_frontmatter(markdown: str) -> str:
    """Replace valid YAML frontmatter characters with spaces, preserving line breaks."""
    end = frontmatter_end(markdown)
    if not end:
        return markdown
    prefix = re.sub(r"[^\r\n]", " ", markdown[:end])
    return prefix + markdown[end:]


def strip_frontmatter(markdown: str) -> str:
    end = frontmatter_end(markdown)
    return markdown[end:] if end else markdown
