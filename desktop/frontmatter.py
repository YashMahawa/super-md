"""Unified top-of-file YAML frontmatter boundary and mapping validator."""
from __future__ import annotations

import re

_BLOCK_SCALAR_HEADER = re.compile(r"^([|>])(?:([+-])([1-9])?|([1-9])([+-])?)?[ \t]*(?:#.*)?$")
_CLOSER = re.compile(r"^(?:---|\.\.\.)[ \t]*$")


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
            if esc == "x":
                hex_part = text[i + 1:i + 3]
                if len(hex_part) != 2 or not all(c in "0123456789abcdefABCDEF" for c in hex_part):
                    return None
                i += 2
            elif esc == "u":
                hex_part = text[i + 1:i + 5]
                if len(hex_part) != 4 or not all(c in "0123456789abcdefABCDEF" for c in hex_part):
                    return None
                i += 4
            elif esc == "U":
                hex_part = text[i + 1:i + 9]
                if len(hex_part) != 8 or not all(c in "0123456789abcdefABCDEF" for c in hex_part):
                    return None
                if int(hex_part, 16) > 0x10FFFF:
                    return None
                i += 8
            out.append(esc)
            i += 1
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
        out.append(ch)
        i += 1
    return None


def _only_trailing_comment(rest: str) -> bool:
    trimmed = rest.lstrip(" \t")
    return trimmed == "" or trimmed.startswith("#")


def _split_key_value(trimmed: str, allow_compact: bool = False) -> tuple[str, str] | None:
    if not trimmed or trimmed.startswith("#"):
        return None
    if trimmed == "-" or trimmed.startswith(("- ", "-\t")):
        return None
    if trimmed.startswith('"'):
        parsed = _parse_double_quoted(trimmed)
        if not parsed:
            return None
        key, rest = parsed
        after = rest.lstrip(" \t")
        if not after.startswith(":"):
            return None
        post = after[1:]
        if not allow_compact and post and post[0] not in (" ", "\t"):
            return None
        return key, post.lstrip(" \t")
    if trimmed.startswith("'"):
        parsed = _parse_single_quoted(trimmed)
        if not parsed:
            return None
        key, rest = parsed
        after = rest.lstrip(" \t")
        if not after.startswith(":"):
            return None
        post = after[1:]
        if not allow_compact and post and post[0] not in (" ", "\t"):
            return None
        return key, post.lstrip(" \t")
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
            return key, after.lstrip(" \t")
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


def _is_valid_yaml_mapping(yaml_body: str) -> bool:
    if not yaml_body:
        return True
    lines: list[tuple[str, int, str]] = []
    for raw in yaml_body.splitlines():
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
            return trimmed[1:].lstrip(" \t")
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
                return idx + 1
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
    yaml_slice = re.sub(r"\r?\n$", "", markdown[yaml_start:yaml_end])
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


def _strip_inline_comment(value: str) -> str:
    for idx, ch in enumerate(value):
        if ch == "#" and (idx == 0 or value[idx - 1] in (" ", "\t")):
            return value[:idx].rstrip()
    return value.rstrip()


def _parse_plain_scalar(raw: str) -> object:
    cleaned = _strip_inline_comment(raw).strip()
    if cleaned in ("", "~") or cleaned.lower() == "null":
        return None
    if cleaned.lower() == "true":
        return True
    if cleaned.lower() == "false":
        return False
    return cleaned


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


def _decode_double_quoted_value(text: str) -> tuple[str, str] | None:
    if not text.startswith('"'):
        return None
    i = 1
    n = len(text)
    out: list[str] = []
    escapes = {'"': '"', "\\": "\\", "/": "/", "n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "0": "\0", " ": " "}
    while i < n:
        ch = text[i]
        if ch == '"':
            return "".join(out), text[i + 1:]
        if ch == "\\":
            i += 1
            if i >= n:
                return None
            esc = text[i]
            if esc in escapes:
                out.append(escapes[esc])
            elif esc == "\n":
                while i + 1 < n and text[i + 1] in (" ", "\t"):
                    i += 1
            elif esc == "x":
                hex_part = text[i + 1:i + 3]
                if len(hex_part) != 2 or not all(c in "0123456789abcdefABCDEF" for c in hex_part):
                    return None
                out.append(chr(int(hex_part, 16)))
                i += 2
            elif esc == "u":
                hex_part = text[i + 1:i + 5]
                if len(hex_part) != 4 or not all(c in "0123456789abcdefABCDEF" for c in hex_part):
                    return None
                out.append(chr(int(hex_part, 16)))
                i += 4
            elif esc == "U":
                hex_part = text[i + 1:i + 9]
                if len(hex_part) != 8 or not all(c in "0123456789abcdefABCDEF" for c in hex_part):
                    return None
                cp = int(hex_part, 16)
                if cp > 0x10FFFF:
                    return None
                out.append(chr(cp))
                i += 8
            else:
                out.append(esc)
            i += 1
            continue
        if ch == "\n":
            while out and out[-1] in (" ", "\t"):
                out.pop()
            while i + 1 < n and text[i + 1] in (" ", "\t"):
                i += 1
            out.append(" ")
            i += 1
            continue
        out.append(ch)
        i += 1
    return None


def _parse_flow_value(raw: str) -> tuple[bool, object]:
    trimmed = raw.strip()
    if not trimmed:
        return True, None
    if trimmed.startswith('"'):
        parsed = _decode_double_quoted_value(trimmed)
        if parsed is None or not _only_trailing_comment(parsed[1]):
            return False, None
        return True, parsed[0]
    if trimmed.startswith("'"):
        parsed = _parse_single_quoted(trimmed)
        if parsed is None or not _only_trailing_comment(parsed[1]):
            return False, None
        return True, re.sub(r"[ \t]*\n[ \t]*", " ", parsed[0])
    if trimmed.startswith("["):
        if not trimmed.endswith("]"):
            return False, None
        inner = trimmed[1:-1].strip()
        if not inner:
            return True, []
        items = _split_top_level_commas(inner)
        if items is None:
            return False, None
        out: list[object] = []
        for item in items:
            if not item.strip():
                continue
            ok, val = _parse_flow_value(item)
            if not ok:
                return False, None
            out.append(val)
        return True, out
    if trimmed.startswith("{"):
        if not trimmed.endswith("}"):
            return False, None
        inner = trimmed[1:-1].strip()
        if not inner:
            return True, {}
        pairs = _split_top_level_commas(inner)
        if pairs is None:
            return False, None
        out_map: dict[str, object] = {}
        for pair in pairs:
            if not pair.strip():
                continue
            kv = _split_key_value(pair.strip(), allow_compact=True)
            if kv is None:
                return False, None
            ok, val = _parse_flow_value(kv[1])
            if not ok:
                return False, None
            out_map[kv[0]] = val
        return True, out_map
    return True, _parse_plain_scalar(trimmed)


def _parse_yaml_mapping(yaml_body: str) -> dict[str, object] | None:
    if not yaml_body:
        return {}
    lines: list[tuple[str, int, str]] = []
    for raw in yaml_body.splitlines():
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
            return None
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
            return trimmed[1:].lstrip(" \t")
        return None

    def collect_quoted(idx: int, initial: str, min_indent: int) -> tuple[str, int] | None:
        comb = initial
        is_double = initial.startswith('"')
        while True:
            parsed = _decode_double_quoted_value(comb) if is_double else _parse_single_quoted(comb)
            if parsed is not None:
                if not _only_trailing_comment(parsed[1]):
                    return None
                val = parsed[0] if is_double else re.sub(r"[ \t]*\n[ \t]*", " ", parsed[0])
                return val, idx + 1
            idx += 1
            if idx >= len(lines):
                return None
            if lines[idx][2] == "":
                comb += "\n"
                continue
            if lines[idx][1] < min_indent:
                return None
            comb += "\n" + lines[idx][2]

    def collect_flow(idx: int, initial: str, min_indent: int) -> tuple[str, int] | None:
        comb = _strip_flow_comment(initial)
        while True:
            state = _flow_state(comb)
            if state == "error":
                return None
            if state == "balanced":
                return comb, idx + 1
            idx += 1
            if idx >= len(lines):
                return None
            if is_blank(idx):
                continue
            if lines[idx][1] < min_indent:
                return None
            comb += " " + _strip_flow_comment(lines[idx][2])

    def collect_block_scalar(idx: int, header: str, parent_indent: int) -> tuple[str, int] | None:
        m = _BLOCK_SCALAR_HEADER.match(header)
        if not m:
            return None
        style = m.group(1)
        chomp = m.group(2) or m.group(5) or "clip"
        indent_digit = m.group(3) or m.group(4)
        raw_content: list[str] = []
        cur = idx + 1
        while cur < len(lines):
            if lines[cur][2] == "":
                raw_content.append("")
                cur += 1
                continue
            if lines[cur][1] <= parent_indent:
                break
            raw_content.append(lines[cur][0])
            cur += 1
        while raw_content and raw_content[-1] == "" and chomp == "-":
            raw_content.pop()
        block_indent = (parent_indent + int(indent_digit)) if indent_digit else None
        if block_indent is None:
            non_empty = [len(line) - len(line.lstrip(" ")) for line in raw_content if line != ""]
            if not non_empty:
                return "", cur
            block_indent = min(non_empty)
        dedented = ["" if line == "" else line[min(len(line), block_indent):] for line in raw_content]
        if style == "|":
            out = "\n".join(dedented)
        else:
            folded: list[str] = []
            for i, curr in enumerate(dedented):
                if i == 0:
                    folded.append(curr)
                    continue
                prev = dedented[i - 1]
                more_indented = curr.startswith((" ", "\t")) or prev.startswith((" ", "\t"))
                if curr == "" or prev == "" or more_indented:
                    folded.append("\n" + curr)
                else:
                    folded.append(" " + curr)
            out = "".join(folded)
        if chomp in ("-", "clip"):
            out = out.rstrip("\n")
        return out, cur

    def parse_value(idx: int, rest: str, key_indent: int) -> tuple[object, int] | None:
        if rest == "" or rest.startswith("#"):
            nxt = next_meaningful(idx + 1)
            if nxt >= len(lines):
                return None, len(lines)
            _, n_indent, n_trimmed = lines[nxt]
            if n_indent >= key_indent and seq_item(n_trimmed) is not None:
                return parse_seq(nxt, n_indent)
            if n_indent > key_indent:
                if _split_key_value(n_trimmed) is not None:
                    return parse_map(nxt, n_indent)
                parts: list[str] = []
                cur = nxt
                while cur < len(lines):
                    if is_blank(cur):
                        cur += 1
                        continue
                    if lines[cur][1] <= key_indent:
                        break
                    if _split_key_value(lines[cur][2]) is not None or seq_item(lines[cur][2]) is not None:
                        break
                    parts.append(_strip_inline_comment(lines[cur][2]))
                    cur += 1
                return _parse_plain_scalar(" ".join(parts)), cur
            return None, nxt
        if rest[0] in "|>":
            return collect_block_scalar(idx, rest, key_indent)
        if rest[0] in "\"'":
            return collect_quoted(idx, rest, key_indent + 1)
        if rest[0] in "[{":
            collected = collect_flow(idx, rest, key_indent)
            if collected is None:
                return None
            ok, val = _parse_flow_value(collected[0])
            return (val, collected[1]) if ok else None
        parts = [_strip_inline_comment(rest)]
        cur = idx + 1
        while cur < len(lines):
            if is_blank(cur) or lines[cur][1] <= key_indent:
                break
            if _split_key_value(lines[cur][2]) is not None or seq_item(lines[cur][2]) is not None:
                break
            parts.append(_strip_inline_comment(lines[cur][2]))
            cur += 1
        return _parse_plain_scalar(" ".join(parts)), cur

    def parse_seq(idx: int, seq_indent: int) -> tuple[list[object], int] | None:
        items: list[object] = []
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
                        sub = parse_seq(nxt, lines[nxt][1])
                        if sub is None:
                            return None
                        items.append(sub[0])
                        idx = sub[1]
                        continue
                    if _split_key_value(lines[nxt][2]) is not None:
                        sub_map = parse_map(nxt, lines[nxt][1])
                        if sub_map is None:
                            return None
                        items.append(sub_map[0])
                        idx = sub_map[1]
                        continue
                items.append(None)
                idx = nxt
                continue
            kv = _split_key_value(item)
            if kv is not None:
                first_val = parse_value(idx, kv[1], seq_indent + 1)
                if first_val is None:
                    return None
                obj: dict[str, object] = {kv[0]: first_val[0]}
                next_idx = first_val[1]
                peek = next_meaningful(next_idx)
                if peek < len(lines) and lines[peek][1] >= seq_indent + 2 and seq_item(lines[peek][2]) is None:
                    rest_map = parse_map(peek, lines[peek][1])
                    if rest_map is None:
                        return None
                    obj.update(rest_map[0])
                    next_idx = rest_map[1]
                items.append(obj)
                idx = next_idx
                continue
            if item[0] in "|>":
                parsed = collect_block_scalar(idx, item, seq_indent)
            elif item[0] in "\"'":
                parsed = collect_quoted(idx, item, seq_indent + 1)
            elif item[0] in "[{":
                collected = collect_flow(idx, item, seq_indent + 1)
                if collected is None:
                    return None
                ok, val = _parse_flow_value(collected[0])
                parsed = (val, collected[1]) if ok else None
            else:
                parsed = (_parse_plain_scalar(item), idx + 1)
            if parsed is None:
                return None
            items.append(parsed[0])
            idx = parsed[1]
        return items, idx

    def parse_map(idx: int, map_indent: int) -> tuple[dict[str, object], int] | None:
        result: dict[str, object] = {}
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
            parsed = parse_value(idx, kv[1], map_indent)
            if parsed is None:
                return None
            result[kv[0]] = parsed[0]
            idx = parsed[1]
        return result, idx

    first = next_meaningful(0)
    if first >= len(lines):
        return {}
    if lines[first][1] != 0:
        return None
    parsed_root = parse_map(first, 0)
    if parsed_root is None or next_meaningful(parsed_root[1]) < len(lines):
        return None
    return parsed_root[0]


def _scalar_to_str(value: object) -> str | None:
    if isinstance(value, str):
        trimmed = value.strip()
        return trimmed or None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return None


def _lookup_ci(entries: dict[str, object], target: str) -> object:
    if target in entries:
        return entries[target]
    lower = target.lower()
    for key, val in entries.items():
        if key.lower() == lower:
            return val
    return None


def _extract_author_name(value: object) -> str | None:
    direct = _scalar_to_str(value)
    if direct:
        return direct
    if isinstance(value, dict):
        name = value.get("name", value.get("literal"))
        direct_name = _scalar_to_str(name)
        if direct_name:
            return direct_name
        if isinstance(name, dict):
            lit = _scalar_to_str(name.get("literal"))
            if lit:
                return lit
            parts = [p for p in (_scalar_to_str(name.get("given")), _scalar_to_str(name.get("family"))) if p]
            if parts:
                return " ".join(parts)
        parts = [p for p in (_scalar_to_str(value.get("given")), _scalar_to_str(value.get("family"))) if p]
        if parts:
            return " ".join(parts)
    return None


def extract_visible_metadata(markdown: str) -> dict[str, object] | None:
    """Return bounded displayed metadata (`title`, `author`, `authors`, `tags`) or None."""
    fm_end = frontmatter_end(markdown)
    if not fm_end:
        return None
    cursor = 1 if markdown.startswith("\ufeff") else 0
    cursor += 3
    while cursor < fm_end and markdown[cursor] in (" ", "\t"):
        cursor += 1
    if markdown[cursor:cursor + 2] == "\r\n":
        cursor += 2
    elif markdown[cursor:cursor + 1] == "\n":
        cursor += 1
    raw_fm = markdown[cursor:fm_end]
    lines = raw_fm.splitlines()
    if not lines:
        return None
    yaml_body = "\n".join(lines[:-1]) if _CLOSER.match(lines[-1]) else raw_fm
    entries = _parse_yaml_mapping(yaml_body)
    if not entries:
        return None

    title = _scalar_to_str(_lookup_ci(entries, "title"))
    authors: list[str] = []
    seen_authors: set[str] = set()
    for key in ("author", "authors", "creator"):
        val = _lookup_ci(entries, key)
        if val is None:
            continue
        seq = val if isinstance(val, list) else [val]
        for item in seq:
            author_name = _extract_author_name(item)
            if author_name and author_name not in seen_authors:
                seen_authors.add(author_name)
                authors.append(author_name[:200])
                if len(authors) >= 20:
                    break
        if len(authors) >= 20:
            break

    tags: list[str] = []
    seen_tags: set[str] = set()

    def add_tag(raw_tag: str | None) -> None:
        if not raw_tag or len(tags) >= 50:
            return
        cleaned = raw_tag.strip()
        if cleaned and cleaned not in seen_tags:
            seen_tags.add(cleaned)
            tags.append(cleaned[:100])

    for key in ("tags", "tag", "keywords"):
        val = _lookup_ci(entries, key)
        if val is None:
            continue
        if isinstance(val, list):
            for item in val:
                add_tag(_scalar_to_str(item))
        else:
            scalar = _scalar_to_str(val)
            if scalar:
                if "," in scalar:
                    for part in scalar.split(","):
                        add_tag(part)
                else:
                    add_tag(scalar)

    out: dict[str, object] = {}
    if title:
        out["title"] = title[:300]
    if authors:
        out["author"] = ", ".join(authors)[:500]
        out["authors"] = authors
    if tags:
        out["tags"] = tags
    return out or None
