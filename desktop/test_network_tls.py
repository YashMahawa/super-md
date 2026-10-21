"""TLS trust-store regression coverage for packaged Python builds."""
import os
import ssl
import unittest
from unittest.mock import patch

import certifi
import network_tls


class NetworkTlsTests(unittest.TestCase):
    def test_bundled_roots_work_without_compiled_system_ca_paths(self):
        with patch.dict(os.environ, {
            "SSL_CERT_FILE": os.path.join(os.path.abspath(os.sep), "no-system-ca-file"),
            "SSL_CERT_DIR": os.path.join(os.path.abspath(os.sep), "no-system-ca-dir"),
        }):
            context = network_tls.client_context()
        self.assertGreater(len(context.get_ca_certs()), 0)
        self.assertTrue(any(entry.get("issuer") for entry in context.get_ca_certs()))
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_system_or_custom_context_is_augmented_not_replaced(self):
        class ExistingTrustContext:
            check_hostname = True
            verify_mode = ssl.CERT_REQUIRED

            def __init__(self):
                self.loaded = []

            def load_verify_locations(self, **kwargs):
                self.loaded.append(kwargs)

        existing = ExistingTrustContext()
        with patch("network_tls.ssl.create_default_context", return_value=existing) as create:
            context = network_tls.client_context()
        create.assert_called_once_with(purpose=ssl.Purpose.SERVER_AUTH)
        self.assertIs(context, existing)
        self.assertEqual(existing.loaded, [{"cafile": certifi.where()}])
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)


if __name__ == "__main__":
    unittest.main()
