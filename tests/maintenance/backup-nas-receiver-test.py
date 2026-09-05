"""Run with Python 3 on Linux; all writes stay in exclusive temporary roots."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest


if 'receiver' not in globals():
    spec = importlib.util.spec_from_file_location(
        'receiver', Path(__file__).resolve().parents[2] / 'scripts/receive_full_managed_backup_nas.py')
    receiver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(receiver)


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='shein-backup-receiver-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name
        self.name = 'shein-fm-weekly-20260905T102755Z.dump'
        self.body = b'PGDMP synthetic receiver test only\x00' * 1000

    def packet(self, **changes):
        meta = {'version': 1, 'name': self.name, 'bytes': len(self.body),
                'sha256': hashlib.sha256(self.body).hexdigest()}
        meta.update(changes)
        return json.dumps(meta).encode() + b'\n' + self.body

    def run_receive(self, packet=None):
        return receiver.receive(io.BytesIO(packet if packet is not None else self.packet()), self.root)

    def assert_no_partial(self):
        self.assertFalse(any(n.endswith('.partial') for n in os.listdir(self.root)))

    def test_copy_and_idempotency(self):
        self.assertEqual(self.run_receive()['state'], 'copied')
        self.assertEqual(self.run_receive()['state'], 'already_present')
        path = Path(self.root, self.name)
        self.assertEqual(path.read_bytes(), self.body)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assert_no_partial()

    def test_deploy_copy_and_idempotency(self):
        deploy_name = 'shein-fm-deploy-20260905T120000Z.dump'
        packet = self.packet(name=deploy_name)
        self.assertEqual(self.run_receive(packet)['state'], 'copied')
        self.assertEqual(self.run_receive(packet)['state'], 'already_present')
        path = Path(self.root, deploy_name)
        self.assertEqual(path.read_bytes(), self.body)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assert_no_partial()

    def test_path_escape(self):
        for name in [
            '../evil.dump', '/tmp/evil.dump', 'x;touch bad', self.name + '/a',
            'shein-fm-daily-20260905T102755Z.dump',
            'shein-fm-deploy-20260905T102755Z.dump.partial',
            'shein-fm-other-20260905T102755Z.dump',
            'shein-fm-deploy-bad.dump',
        ]:
            with self.subTest(name=name), self.assertRaises(receiver.Refused):
                self.run_receive(self.packet(name=name))

    def test_hash_failure(self):
        with self.assertRaisesRegex(receiver.Refused, 'HASH_MISMATCH'):
            self.run_receive(self.packet(sha256='0' * 64))
        self.assert_no_partial()
        self.assertFalse(Path(self.root, self.name).exists())

    def test_short_and_long_transfer(self):
        for packet, error in [(self.packet()[:-10], 'TRANSFER_TRUNCATED'),
                              (self.packet() + b'extra', 'TRANSFER_OVERSIZED')]:
            with self.assertRaisesRegex(receiver.Refused, error):
                self.run_receive(packet)
            self.assert_no_partial()

    def test_conflict_preserves_existing(self):
        target = Path(self.root, self.name)
        target.write_bytes(b'existing backup')
        target.chmod(0o600)
        with self.assertRaisesRegex(receiver.Refused, 'DESTINATION_CONFLICT'):
            self.run_receive()
        self.assertEqual(target.read_bytes(), b'existing backup')
        self.assert_no_partial()

    def test_symlink_destination_not_followed(self):
        original = Path(self.root, 'original')
        original.write_bytes(b'do not touch')
        Path(self.root, self.name).symlink_to(original)
        with self.assertRaises(OSError):
            self.run_receive()
        self.assertEqual(original.read_bytes(), b'do not touch')
        self.assert_no_partial()

    def test_busy_lock(self):
        fd = os.open(Path(self.root, '.backup-receive.lock'), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            receiver.fcntl.flock(fd, receiver.fcntl.LOCK_EX | receiver.fcntl.LOCK_NB)
            with self.assertRaisesRegex(receiver.Refused, 'RECEIVER_BUSY'):
                self.run_receive()
        finally:
            os.close(fd)

    def test_fifo_destination_refused_without_blocking(self):
        os.mkfifo(Path(self.root, self.name), 0o600)
        with self.assertRaisesRegex(receiver.Refused, 'DESTINATION_INVALID'):
            self.run_receive()
        self.assert_no_partial()


if __name__ == '__main__':
    unittest.main()
