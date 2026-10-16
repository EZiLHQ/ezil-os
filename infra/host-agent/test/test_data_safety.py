"""No devices or mounts: fail-closed guard tests using temporary data and stubbed probes."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from ezil_host import config, guard, zero_check  # noqa: E402
from ezil_host.fsops import Refused  # noqa: E402

DIGEST = "sha256:" + "a" * 64
LEASE = {"computerId": "computer-one", "volumeId": "vol-0123456789abcdef0",
         "fsUuid": "retained-fs", "generation": 3, "leaseEpoch": 5, "provision": False}


class FilesystemProbe(unittest.TestCase):
    def test_uuid_requires_a_successful_ext4_signature(self):
        with mock.patch.object(guard.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, "DEVNAME=/dev/fixture\nUUID=retained-fs\nTYPE=ext4\n", "")) as run:
            self.assertEqual(guard.fs_uuid("/dev/fixture"), "retained-fs")
        self.assertEqual(run.call_args.args[0], ["blkid", "-p", "-o", "export", "/dev/fixture"])

    def test_no_signature_requires_successful_independent_probe(self):
        with mock.patch.object(guard.subprocess, "run", side_effect=[
                subprocess.CompletedProcess([], 2, "", ""),
                subprocess.CompletedProcess([], 0, '{"signatures":[]}', "")]):
            self.assertIsNone(guard.fs_uuid("/dev/fixture"))

    def test_blkid_no_result_with_failed_wipefs_is_not_unformatted(self):
        with mock.patch.object(guard.subprocess, "run", side_effect=[
                subprocess.CompletedProcess([], 2, "", ""),
                subprocess.CompletedProcess([], 1, "", "missing or unreadable")]):
            with self.assertRaisesRegex(Refused, "volume_signature_unreadable"):
                guard.fs_uuid("/dev/fixture")

    def test_failed_ambiguous_partitioned_or_uuidless_probes_never_format(self):
        answers = [(1, "", ""), (2, "", "I/O error"), (8, "", "ambivalent result"),
                   (0, "PTTYPE=gpt\nPTUUID=old-data\n", ""),
                   (0, "TYPE=ext4\n", ""), (0, "TYPE=xfs\nUUID=retained-fs\n", ""),
                   (0, "TYPE=ext4\nUUID=retained-fs\nPTTYPE=dos\n", ""),
                   (0, "TYPE=ext4\nUUID=one\nUUID=two\n", ""), (0, "", "")]
        cfg = config.Config(dict(config.DEFAULTS))
        for code, out, err in answers:
            with self.subTest(code=code, out=out, err=err), \
                 mock.patch.object(guard, "wait_device_for_volume", return_value="/dev/fixture"), \
                 mock.patch.object(guard, "is_mounted", return_value=False), \
                 mock.patch.object(guard.subprocess, "run", return_value=subprocess.CompletedProcess([], code, out, err)) as run:
                with self.assertRaises(Refused):
                    guard.mount_data(cfg, {**LEASE, "provision": True})
                self.assertEqual(len(run.call_args_list), 1)
                self.assertEqual(run.call_args.args[0][0], "blkid")

    def test_timeout_and_io_error_never_format(self):
        for error in (OSError("fixture"), subprocess.TimeoutExpired("blkid", 10)):
            with self.subTest(error=error), mock.patch.object(guard.subprocess, "run", side_effect=error):
                with self.assertRaisesRegex(Refused, "volume_signature_unreadable"):
                    guard.fs_uuid("/dev/fixture")

    def test_wrong_device_uuid_is_never_formatted_even_with_provision(self):
        with mock.patch.object(guard, "wait_device_for_volume", return_value="/dev/fixture"), \
             mock.patch.object(guard, "is_mounted", return_value=False), \
             mock.patch.object(guard, "fs_uuid", return_value="other-computers-filesystem"), \
             mock.patch.object(guard.subprocess, "run") as run:
            with self.assertRaisesRegex(Refused, "fs_uuid_mismatch"):
                guard.mount_data(config.Config(dict(config.DEFAULTS)), {**LEASE, "provision": True})
            run.assert_not_called()

    def test_no_signature_without_provision_refuses_and_provision_rechecks_uuid(self):
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(guard, "wait_device_for_volume", return_value="/dev/fixture"), \
             mock.patch.object(guard, "is_mounted", return_value=False), \
             mock.patch.object(guard, "verify_blank_device"), \
             mock.patch.object(guard.subprocess, "run") as run:
            cfg = config.Config({**config.DEFAULTS, "dataMount": str(Path(tmp) / "data")})
            with mock.patch.object(guard, "fs_uuid", return_value=None):
                with self.assertRaisesRegex(Refused, "volume_has_no_filesystem"):
                    guard.mount_data(cfg, LEASE)
                run.assert_not_called()
            with mock.patch.object(guard, "fs_uuid", side_effect=[None, "wrong-after-format"]):
                with self.assertRaisesRegex(Refused, "fs_uuid_mismatch"):
                    guard.mount_data(cfg, {**LEASE, "provision": True})
                run.assert_called_once_with(["mkfs.ext4", "-q", "-F", "-U", LEASE["fsUuid"],
                                             "-L", "ezil-data", "/dev/fixture"], check=True)

    def test_mounted_data_refuses_before_signature_probe_or_format(self):
        with mock.patch.object(guard, "wait_device_for_volume", return_value="/dev/fixture"), \
             mock.patch.object(guard, "is_mounted", return_value=True), \
             mock.patch.object(guard, "fs_uuid") as probe, mock.patch.object(guard.subprocess, "run") as run:
            with self.assertRaisesRegex(Refused, "data_mount_busy"):
                guard.mount_data(config.Config(dict(config.DEFAULTS)), {**LEASE, "provision": True})
            probe.assert_not_called()
            run.assert_not_called()

    def test_formatted_retained_stop_start_replacement_never_scans_or_formats(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = config.Config({**config.DEFAULTS, "dataMount": str(Path(tmp) / "data")})
            for generation, epoch in [(3, 5), (3, 6), (4, 7)]:
                with self.subTest(generation=generation, epoch=epoch), \
                     mock.patch.object(guard, "wait_device_for_volume", return_value="/dev/fixture"), \
                     mock.patch.object(guard, "is_mounted", return_value=False), \
                     mock.patch.object(guard, "fs_uuid", return_value=LEASE["fsUuid"]), \
                     mock.patch.object(guard, "verify_blank_device") as scan, \
                     mock.patch.object(guard.subprocess, "run") as run:
                    guard.mount_data(cfg, {**LEASE, "generation": generation, "leaseEpoch": epoch})
                    scan.assert_not_called()
                    run.assert_called_once_with(["mount", "-o", "ro,nosuid,nodev", "/dev/fixture", cfg.dataMount], check=True)


class BlankDiskCheck(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.disk = Path(tmp.name) / "disk"
        self.disk.write_bytes(bytes(zero_check.CHUNK_BYTES + 33))

    def test_zero_bytes_are_required_through_the_end_of_the_device(self):
        self.assertIsNone(zero_check.verify(str(self.disk), 1))
        with self.disk.open("r+b") as f:
            f.seek(-1, 2)
            f.write(b"x")
        self.assertEqual(zero_check.verify(str(self.disk), 1), "volume_not_blank")

    def test_complete_zero_scan_succeeds_in_the_read_only_child(self):
        real_run = subprocess.run

        def run(argv, **kwargs):
            if argv[0] == "findmnt":
                return subprocess.CompletedProcess(argv, 1, "", "")
            return real_run(argv, **kwargs)
        with mock.patch.object(guard.subprocess, "run", side_effect=run):
            self.assertIsNone(guard.verify_blank_device({}, str(self.disk)))

    def test_early_eof_and_monotonic_deadline_refuse(self):
        with mock.patch.object(zero_check.os, "pread", return_value=b""):
            self.assertEqual(zero_check.verify(str(self.disk), 1), "volume_blank_unreadable")
        with mock.patch.object(zero_check.os, "pread", wraps=zero_check.os.pread) as read:
            clock = mock.Mock(side_effect=[0, 0, 0, 2])
            self.assertEqual(zero_check.verify(str(self.disk), 1, clock), "volume_blank_timeout")
            self.assertEqual(read.call_count, 1)
            self.assertLessEqual(read.call_args.args[1], zero_check.CHUNK_BYTES)

    def test_unknown_used_disk_refuses_before_mkfs_and_preserves_bytes(self):
        self.disk.write_bytes(b"unknown filesystem or corrupted prior data")
        original = self.disk.read_bytes()
        real_run = subprocess.run

        def run(argv, **kwargs):
            if argv[0] == "findmnt":
                return subprocess.CompletedProcess(argv, 1, "", "")
            self.assertEqual(argv[:2], [sys.executable, str(Path(guard.__file__).with_name("zero_check.py"))])
            return real_run(argv, **kwargs)  # only the read-only child; never mkfs/mount

        with mock.patch.object(guard, "wait_device_for_volume", return_value=str(self.disk)), \
             mock.patch.object(guard, "is_mounted", return_value=False), \
             mock.patch.object(guard, "fs_uuid", return_value=None), \
             mock.patch.object(guard.subprocess, "run", side_effect=run):
            with self.assertRaisesRegex(Refused, "volume_not_blank"):
                guard.mount_data(config.Config(dict(config.DEFAULTS)), {**LEASE, "provision": True})
        self.assertEqual(self.disk.read_bytes(), original)

    def test_device_mounted_elsewhere_and_unknown_mount_probe_refuse(self):
        for code, out, expected in [(0, "/dev/fixture /other", "volume_device_busy"),
                                    (2, "", "volume_mount_unknown")]:
            with self.subTest(code=code), mock.patch.object(guard.subprocess, "run",
                    return_value=subprocess.CompletedProcess([], code, out, "")) as run:
                with self.assertRaisesRegex(Refused, expected):
                    guard.verify_blank_device({}, str(self.disk))
                self.assertEqual(run.call_count, 1)

    def test_stalled_read_child_is_bounded_and_invalid_budgets_refuse(self):
        with mock.patch.object(guard.subprocess, "run", side_effect=[
                subprocess.CompletedProcess([], 1, "", ""), subprocess.TimeoutExpired("zero_check", 300)]) as run:
            with self.assertRaisesRegex(Refused, "volume_blank_timeout"):
                guard.verify_blank_device({}, str(self.disk))
            self.assertEqual(run.call_args.kwargs["timeout"], 300)
        for seconds in (0, -1, True, 301, float("inf"), float("nan"), "60"):
            with self.subTest(seconds=seconds), mock.patch.object(guard.subprocess, "run") as run:
                with self.assertRaisesRegex(Refused, "volume_blank_timeout_invalid"):
                    guard.verify_blank_device({"blankVerifySeconds": seconds}, str(self.disk))
                run.assert_not_called()

    def test_missing_or_symlinked_files_refuse_in_the_read_only_child(self):
        link = self.disk.with_name("link")
        link.symlink_to(self.disk)
        for path in (link, self.disk.with_name("missing")):
            child = subprocess.run([sys.executable, str(Path(guard.__file__).with_name("zero_check.py")), str(path), "1"],
                                   capture_output=True, text=True, check=False)
            self.assertEqual((child.returncode, child.stdout.strip()), (1, "volume_blank_unreadable"))


class RetainedDataGuard(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.cfg = config.Config(dict(config.DEFAULTS))
        self.cfg.update(dataMount=str(root / "data"), runDir=str(root / "run"))
        Path(self.cfg.dataMount).mkdir()
        Path(self.cfg.runDir).mkdir()
        self.marker = Path(self.cfg.dataMount) / guard.MARKER
        self.saved = Path(self.cfg.dataMount) / "user-data"
        self.saved.write_bytes(b"retained tools and files\x00\xff")
        self.stamp = Path(self.cfg.runDir) / "guard-ok"
        self.stamp.write_text(json.dumps({"generation": 3, "leaseEpoch": 4}))

    def test_wrong_identity_stale_epoch_and_image_refuse_before_writes(self):
        cases = [({"computerId": "someone-else"}, "computer_id_mismatch"),
                 ({"volumeId": "vol-other"}, "volume_id_mismatch"),
                 ({"fsUuid": "wrong-fs"}, "fs_uuid_mismatch"),
                 ({"generation": 4}, "generation_ahead"),
                 ({"leaseEpoch": 5, "instanceId": "i-0def"}, "epoch_not_increasing"),
                 ({"leaseEpoch": 6}, "epoch_not_increasing"),
                 ({"lowerImageDigest": "sha256:" + "b" * 64}, "lower_digest_mismatch")]
        for changes, code in cases:
            marker = {**guard.new_marker({**LEASE, "leaseEpoch": 4}, DIGEST, "i-0abc"), **changes}
            self.marker.write_text(json.dumps(marker))
            before = self.marker.read_bytes()
            with self.subTest(code=code), mock.patch.object(guard.cfgmod, "host_digest", return_value=DIGEST), \
                 mock.patch.object(guard, "current_instance_id", return_value="i-0abc"), \
                 mock.patch.object(guard, "mount_data"), mock.patch.object(guard, "mount_opts", return_value="ro,nosuid,nodev"), \
                 mock.patch.object(guard, "remount") as remount, \
                 mock.patch.object(guard, "write_file_durable_at") as write, \
                 mock.patch.object(guard.subprocess, "run") as command:
                with self.assertRaisesRegex(Refused, code):
                    guard._run_guard(self.cfg, LEASE)
                remount.assert_not_called()
                write.assert_not_called()
                command.assert_called_once_with(["umount", self.cfg.dataMount])
            self.assertEqual(self.marker.read_bytes(), before)
            self.assertEqual(self.saved.read_bytes(), b"retained tools and files\x00\xff")
            self.assertFalse(self.stamp.exists())

    def test_provision_cannot_initialize_nonempty_markerless_volume(self):
        with mock.patch.object(guard.cfgmod, "host_digest", return_value=DIGEST), \
             mock.patch.object(guard, "mount_data"), mock.patch.object(guard, "mount_opts", return_value="ro"), \
             mock.patch.object(guard, "remount") as remount, mock.patch.object(guard.subprocess, "run"):
            with self.assertRaisesRegex(Refused, "marker_missing"):
                guard._run_guard(self.cfg, {**LEASE, "provision": True})
            remount.assert_not_called()
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.saved.read_bytes(), b"retained tools and files\x00\xff")

    def test_wrong_mounted_volume_and_upper_refuse_despite_current_stamp(self):
        self.stamp.write_text(json.dumps({"generation": 3, "leaseEpoch": 5}))
        for sources, code in [(["/dev/other"], "data_mount_wrong_device"),
                              (["/dev/fixture", "/dev/root"], "upper_not_on_data_volume")]:
            with self.subTest(code=code), mock.patch.object(guard, "device_for_volume", return_value="/dev/fixture"), \
                 mock.patch.object(guard, "is_mounted", return_value=True), \
                 mock.patch.object(guard, "fs_uuid", return_value=LEASE["fsUuid"]), \
                 mock.patch.object(guard.subprocess, "run", side_effect=[
                     subprocess.CompletedProcess([], 0, source, "") for source in sources]):
                with self.assertRaisesRegex(Refused, code):
                    guard.require_stamp(self.cfg, LEASE)

    def test_stale_stamp_refuses_before_mount_probe(self):
        with mock.patch.object(guard, "assert_data_mounted") as mounted:
            with self.assertRaisesRegex(Refused, "guard_stamp_stale"):
                guard.require_stamp(self.cfg, LEASE)
            mounted.assert_not_called()


if __name__ == "__main__":
    unittest.main()
