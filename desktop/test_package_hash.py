import hashlib
import io
import unittest

from package import CHECKSUM_CHUNK_SIZE, sha256_stream


class TrackingStream(io.BytesIO):
    def __init__(self, content):
        super().__init__(content)
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        return super().read(size)


class PackageHashTests(unittest.TestCase):
    def test_installer_hash_is_correct_and_reads_in_bounded_chunks(self):
        content = b"super-md-installer" * ((CHECKSUM_CHUNK_SIZE // 8) + 20_000)
        stream = TrackingStream(content)

        self.assertEqual(sha256_stream(stream), hashlib.sha256(content).hexdigest())
        self.assertGreater(len(stream.read_sizes), 2)
        self.assertTrue(all(0 < size <= CHECKSUM_CHUNK_SIZE for size in stream.read_sizes))


if __name__ == "__main__":
    unittest.main()
