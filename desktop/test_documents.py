import base64
import json
import os
import stat
import tempfile
import unittest
import zlib
from pathlib import Path
from documents import atomic_write, atomic_json, bundle, compressed_bundle, materialize_assets, open_note, validate, write_portable

class DocumentsTest(unittest.TestCase):
    def test_windows_sharing_lock_retries_atomic_replace_without_touching_old_note(self):
        import documents
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/"existing.smd"
            target.write_bytes(b"old note")
            actual_replace=os.replace
            calls=[]
            def temporarily_locked(source, destination):
                calls.append((source,destination))
                if len(calls)<=2:
                    error=PermissionError("sharing violation")
                    error.winerror=32
                    raise error
                actual_replace(source,destination)
            with patch.object(documents.os,"name","nt"), patch.object(documents.os,"replace",side_effect=temporarily_locked):
                write_portable(target,"# safe",{})
            self.assertEqual(len(calls),3)
            self.assertEqual(open_note(target),("# safe",{},True))

    def test_portable_envelopes_are_detected_independently_of_filename(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ("shared", "note.txt", "note.json", "note.md", "note.SMD", "note.FMD"):
                path=Path(directory)/name
                for kind in ("supermd-smd", "supermd-fmd"):
                    value=bundle("# Actual Markdown",{});value["format"]=kind
                    path.write_text("\ufeff  "+json.dumps(value),encoding="utf-8")
                    self.assertEqual(open_note(path),("# Actual Markdown",{},True))
            ordinary=Path(directory)/"data.json"
            ordinary.write_text('{"format":"csv","markdown":"not a bundle"}')
            self.assertEqual(open_note(ordinary),(ordinary.read_text(),{},False))

    def test_gzip_portable_is_deterministic_and_round_trips_source_and_asset_bytes(self):
        import base64
        svg="<svg xmlns='http://www.w3.org/2000/svg'><text>α &amp; β</text></svg>".encode()
        source="# α\n\n![Exact](assets/plot.svg)\n"
        assets={"assets/plot.svg":"data:image/svg+xml;base64,"+base64.b64encode(svg).decode("ascii")}
        first=compressed_bundle(source,assets)
        self.assertEqual(first[:2],b"\x1f\x8b")
        self.assertEqual(first,compressed_bundle(source,assets))
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"opaque.bin"
            path.write_bytes(first)
            self.assertEqual(open_note(path),(source,assets,True))
            decoded=base64.b64decode(open_note(path)[1]["assets/plot.svg"].split(",",1)[1])
            self.assertEqual(decoded,svg)
            write_portable(path,source,assets)
            self.assertEqual(open_note(path),(source,assets,True))

    def test_gzip_portable_rejects_corruption_truncation_and_extra_members(self):
        import gzip
        from documents import _gzip_json_input
        data=compressed_bundle("# source",{})
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"renamed.txt"
            for invalid in (data[:-2],data+data,data+b"trailing",bytes([data[0]^255])+data[1:]):
                path.write_bytes(invalid)
                with self.assertRaises((ValueError,OSError,zlib.error)):
                    _gzip_json_input(path)
                with self.assertRaises((ValueError,OSError)):
                    open_note(path)
            bomb=gzip.compress(b"x"*4096,mtime=0)
            path.write_bytes(bomb)
            from unittest.mock import patch
            with patch("documents.MAX_FILE",1024):
                with self.assertRaises(ValueError): _gzip_json_input(path)

    def test_failed_compressed_write_preserves_existing_destination(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"note.smd"
            path.write_bytes(b"existing note")
            with patch("documents.MAX_FILE",32):
                with self.assertRaises(ValueError): write_portable(path,"# too large for bound",{})
            self.assertEqual(path.read_bytes(),b"existing note")
    def test_streamed_recovery_round_trip_and_failed_serialization_are_atomic(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"recovery.json"
            value=[{"content":'Quoted "λ" and \\math\n'*10000,"saved":"original"}]
            atomic_json(path,value)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")),value)
            before=path.read_bytes()
            with self.assertRaises(TypeError):atomic_json(path,{"unsupported":object()})
            self.assertEqual(path.read_bytes(),before)
            self.assertEqual(list(Path(directory).iterdir()),[path])
    def test_legacy_and_new_formats(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"note.smd"
            atomic_write(path,b"# Old plain-text SMD")
            self.assertEqual(open_note(path),("# Old plain-text SMD",{},False))
            asset = "data:image/svg+xml;base64,"+base64.b64encode(b"<svg/>").decode()
            for format in ("supermd-smd","supermd-fmd"):
                data = bundle("![plot](assets/plot.svg)",{"assets/plot.svg":asset})
                data["format"] = format
                atomic_write(path,json.dumps(data).encode())
                text, images, portable = open_note(path)
                self.assertTrue(portable)
                self.assertNotIn("base64",text)
                self.assertEqual(images["assets/plot.svg"],asset)
    def test_rejects_unsafe_assets(self):
        with self.assertRaises(ValueError):
            bundle("text",{"assets/../secret.svg":"data:image/svg+xml;base64,eA=="})
    def test_failure_preserves_original(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"note.md"
            atomic_write(path,b"original")
            with self.assertRaises(OSError):
                atomic_write(path/"missing",b"bad")
            self.assertEqual(path.read_text(),"original")
    def test_recovery_preserves_transient_utf16_surrogates_without_invalid_utf8(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"recovery.json"
            value={"content":"Draft 😀\ud800 unfinished"}
            atomic_json(path,value)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")),value)
            self.assertIn(b"\\ud800",path.read_bytes())

    def test_markdown_conversion_keeps_images_without_overwriting_other_notes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = "data:image/svg+xml;base64,"+base64.b64encode(b"<svg/>").decode()
            materialize_assets(root,{"assets/plot.svg":data})
            self.assertEqual((root/"assets/plot.svg").read_bytes(),b"<svg/>")
            materialize_assets(root,{"assets/plot.svg":data})
            changed = "data:image/svg+xml;base64,"+base64.b64encode(b"<svg>other</svg>").decode()
            with self.assertRaises(ValueError): materialize_assets(root,{"assets/plot.svg":changed})
            self.assertEqual((root/"assets/plot.svg").read_bytes(),b"<svg/>")
    @unittest.skipUnless(os.name == "posix" and hasattr(os,"fchmod"),"Unix permission bits do not apply to Windows ACLs")
    def test_atomic_save_preserves_file_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"note.md"
            atomic_write(path,b"old")
            path.chmod(0o640)
            atomic_write(path,b"new")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o640)

    def test_structural_envelope_validation_defers_base64_decode_and_enforces_limits(self):
        import documents
        import gzip
        from unittest.mock import patch
        from documents import decode_note_bytes, validate_envelope

        png = b"\x89PNG\r\n\x1a\n" + b"p" * 128
        assets = {"assets/pic.png": "data:image/png;base64," + base64.b64encode(png).decode("ascii")}
        packed = gzip.compress(
            json.dumps({"format": "supermd-smd", "version": 1, "markdown": "# Heading\n\n![pic](assets/pic.png)\n", "assets": assets}).encode("utf-8")
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            smd = root / "note.smd"
            smd.write_bytes(packed)
            json_smd = root / "plain-json.smd"
            json_smd.write_text(
                json.dumps({"format": "supermd-smd", "version": 1, "markdown": "# JSON note\n", "assets": assets}),
                encoding="utf-8",
            )

            with patch("documents.base64.b64decode", wraps=base64.b64decode) as spy:
                text, loaded_assets, portable = open_note(smd, decode_assets=False)
                self.assertTrue(portable)
                self.assertEqual(loaded_assets, assets)
                self.assertEqual(decode_note_bytes(packed, smd, decode_assets=False), (text, assets, True))
                self.assertEqual(open_note(json_smd, decode_assets=False), ("# JSON note\n", assets, True))
                self.assertEqual(spy.call_count, 0)

                # Structurally checked assets are NOT yet payload-validated, so first save validates once,
                # and subsequent saves/opens skip re-decoding.
                write_portable(smd, "# Updated\n", loaded_assets, validated_assets=loaded_assets)
                self.assertEqual(spy.call_count, 1)
                write_portable(smd, "# Updated again\n", loaded_assets, validated_assets=loaded_assets)
                self.assertEqual(open_note(smd)[0], "# Updated again\n")
                self.assertEqual(spy.call_count, 1)

                spy.reset_mock()
                # Exact 25 MB encoded bound passes structural validation; 25 MB + 1 byte fails.
                exact_25mb_len = (documents.MAX_IMAGE // 3) * 4 + 4  # 33,333,336 chars -> 25,000,000 bytes with '=='
                exact_25mb = "A" * (exact_25mb_len - 2) + "=="
                over_25mb = "A" * (exact_25mb_len - 1) + "="  # 25,000,001 bytes
                validate_envelope({
                    "format": "supermd-smd", "version": 1, "markdown": "ok",
                    "assets": {"assets/max.png": "data:image/png;base64," + exact_25mb},
                })
                for invalid_envelope in (
                    {"format": "other", "version": 1, "markdown": "", "assets": {}},
                    {"format": "supermd-smd", "version": True, "markdown": "", "assets": {}},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {}, "extra": 1},
                    {"format": "supermd-smd", "version": 1, "markdown": "x" * (documents.MAX_MARKDOWN + 1), "assets": {}},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {
                        f"assets/a{i}.png": "data:image/png;base64,eA==" for i in range(documents.MAX_ASSETS + 1)
                    }},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {
                        "assets/../escape.png": "data:image/png;base64,eA=="
                    }},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {
                        "assets/mismatch.png": "data:image/jpeg;base64,eA=="
                    }},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {
                        "assets/unaligned.png": "data:image/png;base64,ABC"
                    }},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {
                        "assets/triplepad.png": "data:image/png;base64,A==="
                    }},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {
                        "assets/huge.png": "data:image/png;base64," + over_25mb
                    }},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {
                        f"assets/part{i}.png": "data:image/png;base64," + exact_25mb for i in range(4)
                    }},
                ):
                    with self.assertRaises(ValueError):
                        validate_envelope(invalid_envelope)
                self.assertEqual(spy.call_count, 0)

    def test_corrupted_portable_note_rejected_on_open_and_cannot_be_rewritten(self):
        import gzip
        from documents import decode_note_bytes, validate_envelope

        png = b"\x89PNG\r\n\x1a\n" + b"v" * 64
        valid_assets = {"assets/ok.png": "data:image/png;base64," + base64.b64encode(png).decode("ascii")}
        bundle("# Prime valid asset\n", valid_assets)

        malformed = {"assets/bad.png": "data:image/png;base64,@@@@"}
        corrupted_envelope = {
            "format": "supermd-smd",
            "version": 1,
            "markdown": "# Damaged archive\n\n![bad](assets/bad.png)\n",
            "assets": malformed,
        }
        # Framing check passes (4-char aligned, valid header), but payload is invalid base64.
        validate_envelope(corrupted_envelope)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bad_gzip_bytes = gzip.compress(json.dumps(corrupted_envelope).encode("utf-8"))
            bad_smd = root / "corrupt-b64.smd"
            bad_smd.write_bytes(bad_gzip_bytes)

            bad_json_bytes = json.dumps(corrupted_envelope).encode("utf-8")
            bad_json_smd = root / "corrupt-json.smd"
            bad_json_smd.write_bytes(bad_json_bytes)

            # Normal open_note and decode_note_bytes reject damaged archives just like main.
            with self.assertRaises(ValueError):
                open_note(bad_smd)
            with self.assertRaises(ValueError):
                decode_note_bytes(bad_gzip_bytes, bad_smd)
            with self.assertRaises(ValueError):
                open_note(bad_json_smd)
            with self.assertRaises(ValueError):
                decode_note_bytes(bad_json_bytes, bad_json_smd)

            # Structural-only open returns saved_assets for conflict checks without tainting normal opens or saves.
            md, struct_assets, is_portable = open_note(bad_smd, decode_assets=False)
            self.assertEqual(md, corrupted_envelope["markdown"])
            self.assertTrue(is_portable)
            with self.assertRaises(ValueError):
                open_note(bad_smd)

            # Passing structurally checked assets via validated_assets must NEVER bypass payload validation.
            with self.assertRaises(ValueError):
                validate(corrupted_envelope)
            with self.assertRaises(ValueError):
                bundle("# Edited\n", struct_assets, validated_assets=struct_assets)
            with self.assertRaises(ValueError):
                compressed_bundle("# Edited\n", struct_assets, validated_assets=struct_assets)
            with self.assertRaises(ValueError):
                write_portable(bad_smd, "# Edited\n", struct_assets, validated_assets=struct_assets)
            with self.assertRaises(ValueError):
                write_portable(root / "mixed.smd", "# Mixed\n", {**valid_assets, **struct_assets}, validated_assets={**valid_assets, **struct_assets})
            with self.assertRaises(ValueError):
                materialize_assets(root / "out", struct_assets)
            self.assertEqual(bad_smd.read_bytes(), bad_gzip_bytes)

    def test_repeat_portable_saves_skip_repeat_base64_decoding_and_preserve_caps(self):
        import documents
        from unittest.mock import patch

        png = (
            b"\x89PNG\r\n\x1a\n"
            + b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"
            + b"\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0\x00\x00\x03\x01\x01\x00\xc9\xfe\x92\xef"
            + b"\x00\x00\x00\x00IEND\xaeB`\x82"
        )
        svg = b"<svg xmlns='http://www.w3.org/2000/svg'><rect width='10' height='10'/></svg>"
        # Construct fresh string instances not yet in _VALIDATED_ASSETS.
        png_url = "".join(["data:image/png;base64,", base64.b64encode(png).decode("ascii")])
        svg_url = "".join(["data:image/svg+xml;base64,", base64.b64encode(svg).decode("ascii")])
        assets = {"assets/one.png": png_url, "assets/two.svg": svg_url}

        real_b64decode = base64.b64decode
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "repeat.smd"
            with patch("documents.base64.b64decode", wraps=real_b64decode) as spy:
                write_portable(path, "# First save\n", assets)
                self.assertEqual(spy.call_count, 2)

                spy.reset_mock()
                write_portable(path, "# Second save with unchanged images\n", assets)
                compressed_bundle("# Third save in memory\n", assets)
                self.assertEqual(spy.call_count, 0)

                extra_svg = "".join(["data:image/svg+xml;base64,", base64.b64encode(b"<svg><circle r='4'/></svg>").decode("ascii")])
                updated = {**assets, "assets/three.svg": extra_svg}
                spy.reset_mock()
                write_portable(path, "# Fourth save adding one image\n", updated)
                self.assertEqual(spy.call_count, 1)

            # Extension mismatch and 75 MB aggregate limit must still fail on cached payloads.
            with self.assertRaisesRegex(ValueError, "MIME does not match"):
                bundle("# Bad ext", {"assets/wrong.jpg": png_url})

            chunk_20mb = b"\x89PNG\r\n\x1a\n" + (b"\xab\xcd\xef\x01" * 5_000_000)
            cached_20mb = "data:image/png;base64," + base64.b64encode(chunk_20mb).decode("ascii")
            bundle("# Single 20 MB ok", {"assets/a.png": cached_20mb})
            with self.assertRaisesRegex(ValueError, "Assets exceed 75 MB"):
                bundle("# Four 20 MB copies exceed 75 MB", {f"assets/{i}.png": cached_20mb for i in range(4)})

    def test_balanced_gzip_opens_across_desktop_and_cli_readers_and_speeds_up_repeat_saves(self):
        import gzip
        import time
        import agent_documents
        from documents import decode_note_bytes

        # Structured diagram payload representative of embedded SVG/PNG figures (~6 MB).
        pattern = (b"<svg xmlns='http://www.w3.org/2000/svg'>" + b"<rect x='1' y='2' width='30' height='40'/>" * 12_000 + b"</svg>")
        assets = {
            f"assets/diagram-{idx}.svg": "data:image/svg+xml;base64," + base64.b64encode(pattern + f"<!--{idx}-->".encode()).decode("ascii")
            for idx in range(10)
        }
        markdown = "# Portable Archive Compatibility\n\n" + "\n".join(f"![Diagram {i}](assets/diagram-{i}.svg)" for i in range(10)) + "\n"

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy_path = root / "legacy-lvl9.smd"
            fast_path = root / "balanced.smd"

            # Warm OS directory page cache, then time legacy level-9 + uncached decode save.
            envelope = {"format": "supermd-smd", "version": 1, "markdown": markdown, "assets": assets}
            t0 = time.perf_counter()
            for raw_url in assets.values():
                base64.b64decode(raw_url.split(",", 1)[1], validate=True)
            class _LegacyWriter:
                def write(self, text):
                    stream.write(text.encode("utf-8"))
                    return len(text)

            with legacy_path.open("wb") as handle:
                with gzip.GzipFile(fileobj=handle, mode="wb", filename="", mtime=0, compresslevel=9) as stream:
                    json.dump(envelope, _LegacyWriter(), ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            legacy_ms = (time.perf_counter() - t0) * 1000

            # Prime validation once (as happens when opening or first saving the note), then time repeat save.
            write_portable(fast_path, markdown, assets)
            t1 = time.perf_counter()
            write_portable(fast_path, markdown + "\nUpdated paragraph.\n", assets)
            fast_ms = (time.perf_counter() - t1) * 1000

            self.assertLess(fast_ms, legacy_ms * 0.60,
                            f"Expected >=40% save-time reduction vs compresslevel=9 (got {fast_ms:.1f} ms vs {legacy_ms:.1f} ms)")

            raw_bytes = fast_path.read_bytes()
            self.assertEqual(raw_bytes[:2], b"\x1f\x8b")
            # mtime bytes [4:8] in RFC 1952 header must be 0 for deterministic output.
            self.assertEqual(raw_bytes[4:8], b"\x00\x00\x00\x00")

            expected_md = markdown + "\nUpdated paragraph.\n"
            self.assertEqual(open_note(fast_path), (expected_md, assets, True))
            self.assertEqual(decode_note_bytes(raw_bytes, fast_path), (expected_md, assets, True))

            # Verify CLI / offline DocumentStore readers read identical Markdown and image bytes.
            workspace = agent_documents.DocumentStore([root])
            inspected = workspace.inspect(str(fast_path))
            self.assertEqual(inspected["format"], "smd")
            self.assertEqual(inspected["asset_count"], 10)
            read_back = workspace.read(str(fast_path), view="source", limit=12_000)
            self.assertEqual(read_back["text"], expected_md)
            listed = workspace.assets(str(fast_path))
            self.assertEqual(listed["total"], 10)
            extracted = workspace.read_asset(str(fast_path), "assets/diagram-0.svg", expected_revision=inspected["revision"])
            self.assertEqual(extracted["data"], pattern + b"<!--0-->")

if __name__ == "__main__": unittest.main()
