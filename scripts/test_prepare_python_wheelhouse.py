import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("prepare_python_wheelhouse.py")
SPEC = importlib.util.spec_from_file_location("prepare_python_wheelhouse", MODULE_PATH)
wheelhouse = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wheelhouse)


class WheelhouseManifestTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="supermd-wheelhouse-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cache = self.root / "wheelhouse"
        self.requirements = self.root / "requirements.txt"
        self.requirements.write_text("example==1.0\n", encoding="utf-8")
        self.runtime = {
            "pythonTag": "cpython-313", "soabi": "cpython-313-x86_64-linux-gnu",
            "wheelPlatform": "linux-x86_64", "cxxCompiler": {"command": "g++", "version": "g++ 14.2"},
            "buildFlags": {"CXXFLAGS": "-O2"},
        }
        self.runtime_patch = patch.object(wheelhouse, "runtime_identity", return_value=self.runtime)
        self.runtime_patch.start()
        self.addCleanup(lambda: self.runtime_patch.stop() if self.runtime_patch else None)

    def _wheel(self, directory, data=b"wheel payload"):
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "example-1.0-py3-none-any.whl"
        path.write_bytes(data)
        return path

    def _wheel_command(self, data=b"rebuilt wheel"):
        def run(args, **kwargs):
            self.assertEqual(args[1:4], ["-m", "pip", "wheel"])
            wheel_dir = Path(args[args.index("--wheel-dir") + 1])
            self.assertNotEqual(wheel_dir, self.cache)
            self.assertEqual(list(wheel_dir.iterdir()), [], "staging must be fresh")
            self._wheel(wheel_dir, data)
            return subprocess.CompletedProcess(args, 0)
        return run

    def test_manifest_checks_requirements_runtime_and_streamed_wheel_hashes(self):
        self._wheel(self.cache)
        wheelhouse.write_manifest(self.cache, [self.requirements])
        self.assertTrue(wheelhouse.manifest_is_complete(self.cache, [self.requirements]))

        (self.cache / "example-1.0-py3-none-any.whl").write_bytes(b"corrupted")
        self.assertFalse(wheelhouse.manifest_is_complete(self.cache, [self.requirements]))
        self._wheel(self.cache)
        self.requirements.write_text("example==2.0\n", encoding="utf-8")
        self.assertFalse(wheelhouse.manifest_is_complete(self.cache, [self.requirements]))

    def test_manifest_identity_covers_python_abi_and_compiler_changes(self):
        self._wheel(self.cache)
        base_runtime = self.runtime
        wheelhouse.write_manifest(self.cache, [self.requirements])
        original_key = wheelhouse.cache_identity([self.requirements])
        self.assertTrue(wheelhouse.manifest_is_complete(self.cache, [self.requirements]))

        for changed in (
            {**base_runtime, "soabi": "cpython-313-x86_64-linux-musl"},
            {**base_runtime, "cxxCompiler": {"command": "g++", "version": "g++ 15.1"}},
            {**base_runtime, "buildFlags": {"CXXFLAGS": "-O3"}},
            {**base_runtime, "nativeBuildInputs": {"opensslDir": "/usr/local/opt/openssl@3", "opensslVersion": "OpenSSL 3.6.0"}},
        ):
            with patch.object(wheelhouse, "runtime_identity", return_value=changed):
                self.assertFalse(wheelhouse.manifest_is_complete(self.cache, [self.requirements]))
                self.assertNotEqual(wheelhouse.cache_identity([self.requirements]), original_key)

    def test_intel_macos_uses_verified_brew_openssl_static_build_inputs(self):
        with tempfile.TemporaryDirectory(prefix="supermd-openssl-test-") as temporary:
            prefix = Path(temporary) / "openssl@3"
            for relative in ("include/openssl/ssl.h", "lib/libssl.a", "lib/libcrypto.a", "bin/openssl"):
                path = prefix / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"test")

            def run(arguments, **kwargs):
                if arguments[-2:] == ["--prefix", "openssl@3"]:
                    return subprocess.CompletedProcess(arguments, 0, stdout=f"{prefix}\n", stderr="")
                self.assertEqual(arguments, [str(prefix / "bin/openssl"), "version"])
                return subprocess.CompletedProcess(arguments, 0, stdout="OpenSSL 3.6.0\n", stderr="")

            with patch.object(wheelhouse.sys, "platform", "darwin"), \
                    patch.object(wheelhouse.platform, "machine", return_value="x86_64"), \
                    patch.object(wheelhouse.shutil, "which", return_value="/opt/homebrew/bin/brew"), \
                    patch.object(wheelhouse.subprocess, "run", side_effect=run), \
                    patch.dict(wheelhouse.os.environ, {"OPENSSL_DIR": "", "OPENSSL_STATIC": "0"}):
                inputs = wheelhouse.native_build_inputs()
                environment = wheelhouse.wheel_build_environment()

            self.assertEqual(inputs["opensslDir"], str(prefix))
            self.assertEqual(inputs["opensslVersion"], "OpenSSL 3.6.0")
            self.assertEqual(inputs["environment"], {"OPENSSL_DIR": str(prefix), "OPENSSL_STATIC": "1"})
            self.assertEqual(environment["OPENSSL_DIR"], str(prefix))
            self.assertEqual(environment["OPENSSL_STATIC"], "1")

    def test_static_openssl_inputs_are_absent_outside_intel_macos(self):
        with patch.object(wheelhouse.sys, "platform", "linux"), \
                patch.object(wheelhouse.platform, "machine", return_value="x86_64"):
            self.assertEqual(wheelhouse.native_build_inputs(), {})
            self.assertNotIn("nativeBuildInputs", wheelhouse.runtime_identity())

    def test_intel_macos_rejects_dynamic_only_or_incomplete_openssl_prefix(self):
        with tempfile.TemporaryDirectory(prefix="supermd-openssl-incomplete-") as temporary, \
                patch.object(wheelhouse.sys, "platform", "darwin"), \
                patch.object(wheelhouse.platform, "machine", return_value="x86_64"), \
                patch.dict(wheelhouse.os.environ, {"OPENSSL_DIR": temporary}):
            with self.assertRaisesRegex(RuntimeError, "Static cryptography build needs OpenSSL headers and archives"):
                wheelhouse.native_build_inputs()

    def test_static_openssl_build_disables_pips_unkeyed_wheel_cache(self):
        inputs = {"environment": {"OPENSSL_DIR": "/usr/local/opt/openssl@3", "OPENSSL_STATIC": "1"},
                  "opensslDir": "/usr/local/opt/openssl@3", "opensslVersion": "OpenSSL 3.6.0"}
        with patch.object(wheelhouse, "native_build_inputs", return_value=inputs), \
                patch.object(wheelhouse.subprocess, "run", side_effect=self._wheel_command()) as run, \
                patch.object(wheelhouse, "install_offline", return_value=True), \
                patch.object(wheelhouse, "verify_static_cryptography_openssl"):
            self.assertEqual(wheelhouse.prepare(self.cache, self.requirements, [self.requirements]), "rebuilt")

        command = run.call_args.args[0]
        self.assertIn("--no-cache-dir", command)
        self.assertEqual(run.call_args.kwargs["env"]["OPENSSL_STATIC"], "1")
        self.assertEqual(run.call_args.kwargs["env"]["OPENSSL_DIR"], "/usr/local/opt/openssl@3")

    def test_static_cryptography_linkage_verifier_accepts_archive_and_rejects_dylibs(self):
        inputs = {"environment": {"OPENSSL_DIR": "/usr/local/opt/openssl@3", "OPENSSL_STATIC": "1"}}
        with tempfile.TemporaryDirectory(prefix="supermd-cryptography-linkage-") as temporary:
            extension = Path(temporary) / "_rust.abi3.so"
            extension.write_bytes(b"mock extension")

            def responses(linked_libraries):
                def run(arguments, **kwargs):
                    if len(arguments) >= 3 and arguments[1] == "-c":
                        return subprocess.CompletedProcess(arguments, 0, stdout=f"{extension}\n", stderr="")
                    self.assertEqual(arguments, ["/usr/bin/otool", "-L", str(extension)])
                    return subprocess.CompletedProcess(arguments, 0,
                        stdout=f"{extension}:\n" + "".join(f"\t{name} (compatibility version 1.0.0)\n" for name in linked_libraries), stderr="")
                return run

            with patch.object(wheelhouse.shutil, "which", return_value="/usr/bin/otool"), \
                    patch.object(wheelhouse.subprocess, "run", side_effect=responses([])):
                wheelhouse.verify_static_cryptography_openssl(inputs)

            with patch.object(wheelhouse.shutil, "which", return_value="/usr/bin/otool"), \
                    patch.object(wheelhouse.subprocess, "run", side_effect=responses([
                        "/usr/local/opt/openssl@3/lib/libssl.3.dylib",
                        "/usr/local/opt/openssl@3/lib/libcrypto.3.dylib",
                    ])):
                with self.assertRaisesRegex(RuntimeError, "dynamically linked to libcrypto.3.dylib, libssl.3.dylib"):
                    wheelhouse.verify_static_cryptography_openssl(inputs)

    def test_static_linkage_verification_is_noop_without_native_build_inputs(self):
        with patch.object(wheelhouse, "native_build_inputs", return_value={}), \
                patch.object(wheelhouse.subprocess, "run", side_effect=AssertionError("no verification outside Intel macOS")):
            wheelhouse.verify_static_cryptography_openssl()

    def test_intel_macos_offline_install_forces_only_the_validated_cryptography_wheel(self):
        self.cache.mkdir(parents=True)
        cryptography = self.cache / "cryptography-50.0.2-cp313-abi3-macosx_10_12_x86_64.whl"
        cryptography.write_bytes(b"validated static wheel")
        build_inputs = {"environment": {"OPENSSL_DIR": "/usr/local/opt/openssl@3", "OPENSSL_STATIC": "1"}}
        completed = subprocess.CompletedProcess([], 0)
        with patch.object(wheelhouse, "native_build_inputs", return_value=build_inputs), \
                patch.object(wheelhouse.subprocess, "run", side_effect=[completed, completed]) as run:
            self.assertTrue(wheelhouse.install_offline(self.cache, self.requirements))

        self.assertEqual(run.call_count, 2)
        replacement = run.call_args_list[1].args[0]
        self.assertEqual(replacement, [wheelhouse.sys.executable, "-m", "pip", "install", "--no-index",
                                       "--no-deps", "--force-reinstall", str(cryptography)])

    def test_intel_macos_offline_install_requires_exactly_one_cryptography_wheel(self):
        self.cache.mkdir(parents=True)
        (self.cache / "cryptography-50.0.2-cp313-abi3-macosx_10_12_x86_64.whl").write_bytes(b"one")
        (self.cache / "cryptography-50.0.2-cp313-abi3-macosx_11_0_x86_64.whl").write_bytes(b"two")
        build_inputs = {"environment": {"OPENSSL_DIR": "/usr/local/opt/openssl@3", "OPENSSL_STATIC": "1"}}
        with patch.object(wheelhouse, "native_build_inputs", return_value=build_inputs), \
                patch.object(wheelhouse.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "exactly one cryptography-\\*.whl"):
                wheelhouse.install_offline(self.cache, self.requirements)
        run.assert_not_called()

    def test_identity_exposes_stable_runtime_and_compiler_fields(self):
        # This one intentionally exercises current host detection, including
        # compiler-version probing; other tests use a deterministic identity.
        self.runtime_patch.stop()
        self.runtime_patch = None
        runtime = wheelhouse.runtime_identity()
        self.assertTrue(runtime["pythonTag"])
        self.assertTrue(runtime["soabi"])
        self.assertTrue(runtime["wheelPlatform"])
        self.assertIn("version", runtime["cCompiler"])
        self.assertIn("version", runtime["cxxCompiler"])
        self.assertEqual(len(wheelhouse.cache_identity([self.requirements])), 64)

    def test_valid_warm_cache_installs_without_fetch_or_rebuild(self):
        self._wheel(self.cache)
        wheelhouse.write_manifest(self.cache, [self.requirements])
        with patch.object(wheelhouse, "native_build_inputs", return_value={}), \
                patch.object(wheelhouse, "install_offline", return_value=True) as install, \
                patch.object(wheelhouse.subprocess, "run", side_effect=AssertionError("warm cache must not rebuild")):
            outcome = wheelhouse.prepare(self.cache, self.requirements, [self.requirements])
        self.assertEqual(outcome, "cache-validated")
        install.assert_called_once_with(self.cache.resolve(), self.requirements.resolve())
        self.assertFalse(self.cache.with_name("wheelhouse.quarantine").exists())

    def test_partial_corrupt_cache_rebuilds_in_fresh_stage_and_preserves_old_files(self):
        self._wheel(self.cache, b"same filename, corrupt contents")
        with patch.object(wheelhouse, "native_build_inputs", return_value={}), \
                patch.object(wheelhouse.subprocess, "run", side_effect=self._wheel_command()), \
                patch.object(wheelhouse, "install_offline", return_value=True) as install:
            outcome = wheelhouse.prepare(self.cache, self.requirements, [self.requirements])

        self.assertEqual(outcome, "rebuilt")
        self.assertEqual(install.call_args.args[0].parent, self.cache.resolve().parent)
        self.assertEqual((self.cache / "example-1.0-py3-none-any.whl").read_bytes(), b"rebuilt wheel")
        quarantine = self.cache.with_name("wheelhouse.quarantine")
        self.assertEqual((quarantine / "example-1.0-py3-none-any.whl").read_bytes(), b"same filename, corrupt contents")
        self.assertTrue(wheelhouse.manifest_is_complete(self.cache, [self.requirements]))

    def test_failed_offline_retry_does_not_promote_or_mutate_existing_cache(self):
        old_wheel = self._wheel(self.cache, b"old wheel")
        old_manifest = wheelhouse.write_manifest(self.cache, [self.requirements])
        old_manifest_bytes = (self.cache / wheelhouse.MANIFEST).read_bytes()
        with patch.object(wheelhouse, "native_build_inputs", return_value={}), \
                patch.object(wheelhouse.subprocess, "run", side_effect=self._wheel_command()), \
                patch.object(wheelhouse, "install_offline", side_effect=[False, False]) as install:
            with self.assertRaisesRegex(RuntimeError, "Offline install failed"):
                wheelhouse.prepare(self.cache, self.requirements, [self.requirements])

        self.assertEqual(install.call_count, 2)
        self.assertEqual(old_wheel.read_bytes(), b"old wheel")
        self.assertEqual((self.cache / wheelhouse.MANIFEST).read_bytes(), old_manifest_bytes)
        self.assertEqual(wheelhouse.manifest_data(self.cache, [self.requirements]), old_manifest)
        self.assertFalse(self.cache.with_name("wheelhouse.quarantine").exists())

    def test_pip_build_failure_preserves_old_manifest_and_cache(self):
        old_wheel = self._wheel(self.cache, b"old wheel")
        wheelhouse.write_manifest(self.cache, [self.requirements])
        old_manifest = (self.cache / wheelhouse.MANIFEST).read_bytes()
        with patch.object(wheelhouse, "native_build_inputs", return_value={}), \
                patch.object(wheelhouse, "install_offline", return_value=False), \
                patch.object(wheelhouse.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["pip", "wheel"])) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                wheelhouse.prepare(self.cache, self.requirements, [self.requirements])

        run.assert_called_once()
        self.assertEqual(old_wheel.read_bytes(), b"old wheel")
        self.assertEqual((self.cache / wheelhouse.MANIFEST).read_bytes(), old_manifest)
        self.assertFalse(self.cache.with_name("wheelhouse.quarantine").exists())

    def test_existing_quarantine_is_never_overwritten(self):
        self._wheel(self.cache, b"current corrupt cache")
        quarantine = self.cache.with_name("wheelhouse.quarantine")
        self._wheel(quarantine, b"older preserved quarantine")
        with patch.object(wheelhouse, "native_build_inputs", return_value={}), \
                patch.object(wheelhouse.subprocess, "run", side_effect=self._wheel_command()), \
                patch.object(wheelhouse, "install_offline", return_value=True):
            outcome = wheelhouse.prepare(self.cache, self.requirements, [self.requirements])
        self.assertEqual(outcome, "rebuilt-uncached")
        self.assertEqual((self.cache / "example-1.0-py3-none-any.whl").read_bytes(), b"current corrupt cache")
        self.assertEqual((quarantine / "example-1.0-py3-none-any.whl").read_bytes(), b"older preserved quarantine")


if __name__ == "__main__":
    unittest.main()
