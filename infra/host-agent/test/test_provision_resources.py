#!/usr/bin/env python3
"""Unprivileged tests: synthetic NVMe/lsblk replies and temporary OCI inputs.
Run from repo root:
python3 -m unittest discover -s infra/host-agent/test -p test_provision_resources.py -v
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from ezil_host import config, desktop, enroll, guard, lease  # noqa: E402
from ezil_host.fsops import Refused  # noqa: E402

ROOT_ID, DATA_ID, EXTRA_ID = ("vol-" + c * 17 for c in ("a", "b", "c"))


def userdata(**over):
    d = {"v": 1, "computerId": "11111111-1111-4111-8111-111111111111",
         "fsUuid": "22222222-2222-4222-8222-222222222222",
         "generation": 1, "leaseEpoch": 1, "provision": True}
    return json.dumps({**d, **over})


def controller(volume_id, name):
    data = bytearray(4096)
    data[4:24] = volume_id.replace("-", "").encode().ljust(20, b" ")
    data[3072:3104] = name.encode().ljust(32, b"\0")
    return bytes(data)


class LeaseParsing(unittest.TestCase):
    def test_provision_accepts_missing_or_null_volume(self):
        for over in ({}, {"volumeId": None}):
            self.assertIsNone(lease.parse(userdata(**over)).get("volumeId"))

    def test_other_operations_and_rebase_require_volume(self):
        for over in ({"provision": False}, {"provision": False, "volumeId": None},
                     {"provision": "true"}, {"provision": 1}, {"rebase": {}}):
            with self.subTest(over=over), self.assertRaises(lease.LeaseError):
                lease.parse(userdata(**over))
        d = json.loads(userdata())
        d.pop("provision")
        with self.assertRaises(lease.LeaseError):
            lease.parse(json.dumps(d))

    def test_supplied_ids_are_validated_in_every_mode(self):
        for provision in (True, False):
            for volume in ("", "vol-XYZ", "vol-" + "b" * 17 + "\n", 123):
                with self.subTest(provision=provision, volume=volume), self.assertRaises(lease.LeaseError):
                    lease.parse(userdata(provision=provision, volumeId=volume))
            self.assertEqual(lease.parse(userdata(provision=provision, volumeId=DATA_ID))["volumeId"], DATA_ID)

    def test_rebase_and_marker_still_check_identity(self):
        receipt = {"snapshotId": "snap-" + "a" * 17, "volumeId": EXTRA_ID,
                   "fromDigest": "sha256:" + "a" * 64, "toDigest": "sha256:" + "b" * 64}
        with self.assertRaisesRegex(lease.LeaseError, "rebase"):
            lease.parse(userdata(volumeId=DATA_ID, rebase=receipt))
        current = lease.parse(userdata(provision=False, volumeId=DATA_ID))
        marker = guard.new_marker({**current, "volumeId": EXTRA_ID}, receipt["fromDigest"])
        with self.assertRaisesRegex(Refused, "volume_id_mismatch"):
            guard.check_marker(marker, current, receipt["fromDigest"])


class ProvisionVolume(unittest.TestCase):
    def setUp(self):
        self.cfg = config.Config(dict(config.DEFAULTS))
        self.cfg["volumeWaitSeconds"] = 0     # the bounded attach wait is test_boot_retries'
        self.links, self.targets, self.stats, self.controllers = [], {}, {}, {}
        self.stats["/"] = SimpleNamespace(st_dev=os.makedev(259, 1))
        self.root_devices = "259:1\n259:0\n"
        self.add_volume(ROOT_ID, "/dev/nvme7n1", 0, "/dev/xvda")
        self.add_volume(DATA_ID, "/dev/nvme0n1", 2, "sdf")
        patches = (
            mock.patch.object(guard.glob, "glob", side_effect=lambda pattern: list(self.links)),
            mock.patch.object(guard.os.path, "realpath", side_effect=lambda p, **kw: self.targets.get(p, p)),
            mock.patch.object(guard.os, "stat", side_effect=lambda p: self.stats[p]),
            mock.patch.object(guard.subprocess, "run", side_effect=self.run_command),
        )
        for patch in patches:
            value = patch.start()
            self.addCleanup(patch.stop)
        self.commands = value

    def add_volume(self, volume_id, dev, minor, name):
        link = os.path.join(self.cfg.deviceByIdDir, "nvme-Amazon_Elastic_Block_Store_" + volume_id.replace("-", ""))
        self.links.append(link)
        self.targets[link] = dev
        self.stats[dev] = SimpleNamespace(st_mode=stat.S_IFBLK, st_rdev=os.makedev(259, minor))
        self.controllers[dev] = controller(volume_id, name)

    def run_command(self, argv, **kw):
        if argv[0] == "lsblk":
            self.assertEqual(argv, ["lsblk", "--inverse", "--noheadings", "--raw",
                                    "--output", "MAJ:MIN", "/dev/block/259:1"])
            return subprocess.CompletedProcess(argv, 0, self.root_devices, "")
        self.assertEqual(argv[:2], ["nvme", "id-ctrl"])
        self.assertEqual(argv[3:], ["--raw-binary"])
        return subprocess.CompletedProcess(argv, 0, self.controllers[argv[2]], b"")

    def test_nitro_serial_and_partition_aliases(self):
        self.links.append(self.links[1] + "-part1")
        self.assertEqual(guard.provision_volume(self.cfg), DATA_ID)
        self.assertEqual(guard.device_for_volume(self.cfg, DATA_ID), "/dev/nvme0n1")
        self.assertEqual([c.args[0][2] for c in self.commands.call_args_list if c.args[0][0] == "nvme"],
                         ["/dev/nvme0n1"])

    def test_attachment_name_is_configurable_with_or_without_dev_prefix(self):
        self.cfg["dataDeviceName"] = "/dev/sdg"
        for name in ("sdg", "/dev/sdg"):
            self.controllers["/dev/nvme0n1"] = controller(DATA_ID, name)
            self.assertEqual(guard.provision_volume(self.cfg), DATA_ID)
        with self.assertRaisesRegex(Refused, "data_device_name_mismatch"):
            self.cfg["dataDeviceName"] = "/dev/sdf"
            guard.provision_volume(self.cfg)

    def test_zero_or_multiple_nonroot_disks_refuse_before_identify(self):
        self.links = self.links[:1]
        with self.assertRaisesRegex(Refused, "found 0"):
            guard.provision_volume(self.cfg)
        self.add_volume(DATA_ID, "/dev/nvme0n1", 2, "sdf")
        self.add_volume(EXTRA_ID, "/dev/nvme1n1", 3, "sdg")
        with self.assertRaisesRegex(Refused, "found 2"):
            guard.provision_volume(self.cfg)
        self.assertTrue(all(c.args[0][0] == "lsblk" for c in self.commands.call_args_list))

    def test_root_partition_and_all_backing_disks_are_excluded(self):
        for roots in ("259:1\n259:0\n259:2\n", "259:1\n259:0\n253:0\n259:2\n"):
            self.root_devices = roots
            with self.assertRaisesRegex(Refused, "found 0"):
                guard.provision_volume(self.cfg)
        with self.assertRaisesRegex(Refused, "volume_is_root_device"):
            guard.device_for_volume(self.cfg, ROOT_ID)

    def test_unknown_root_fails_closed(self):
        for roots in ("", "259:0\n", "259:1\ninvalid\n"):
            self.root_devices = roots
            with self.assertRaisesRegex(Refused, "root_device_unknown"):
                guard.provision_volume(self.cfg)
        self.commands.side_effect = subprocess.CalledProcessError(1, ["lsblk"])
        with self.assertRaisesRegex(Refused, "root_device_unknown"):
            guard.device_for_volume(self.cfg, DATA_ID)

    def test_regular_files_and_mismatched_controller_identity_refuse(self):
        self.stats["/dev/nvme0n1"].st_mode = stat.S_IFREG
        with self.assertRaisesRegex(Refused, "volume_device_not_block"):
            guard.provision_volume(self.cfg)
        self.stats["/dev/nvme0n1"].st_mode = stat.S_IFBLK
        self.controllers["/dev/nvme0n1"] = controller(EXTRA_ID, "sdf")
        with self.assertRaisesRegex(Refused, "volume_id_mismatch"):
            guard.provision_volume(self.cfg)
        for data in (b"", b"\xff" * 4096):
            self.controllers["/dev/nvme0n1"] = data
            with self.assertRaisesRegex(Refused, "volume_identity_unreadable"):
                guard.provision_volume(self.cfg)

    def test_invalid_config_and_failed_identify_refuse(self):
        self.cfg["dataDeviceName"] = None
        with self.assertRaisesRegex(Refused, "data_device_name_invalid"):
            guard.provision_volume(self.cfg)
        self.cfg["dataDeviceName"] = "/dev/sdf"
        run = self.run_command

        def fail_identify(argv, **kw):
            if argv[0] == "nvme":
                raise subprocess.CalledProcessError(1, argv)
            return run(argv, **kw)

        self.commands.side_effect = fail_identify
        with self.assertRaisesRegex(Refused, "volume_identity_unreadable"):
            guard.provision_volume(self.cfg)

    def test_fetch_saves_resolved_id_and_preserves_explicit_ids(self):
        for over, expected in (({}, DATA_ID), ({"volumeId": None}, DATA_ID),
                               ({"provision": False, "volumeId": EXTRA_ID}, EXTRA_ID)):
            self.commands.reset_mock()
            with mock.patch.object(lease.Imds, "lease_and_identity", return_value=(userdata(**over), "doc", "sig")), \
                    mock.patch.object(enroll, "_write_private") as write:
                resolved = enroll.fetch_lease(self.cfg)
            self.assertEqual(resolved["volumeId"], expected)
            self.assertEqual(json.loads(write.call_args_list[0].args[1])["volumeId"], expected)
            if over.get("provision") is False:
                self.commands.assert_not_called()

    def test_failed_resolution_never_persists_partial_lease(self):
        self.links.clear()
        with mock.patch.object(lease.Imds, "lease_and_identity", return_value=(userdata(), "doc", "sig")), \
                mock.patch.object(enroll, "_write_private") as write:
            with self.assertRaisesRegex(Refused, "found 0"):
                enroll.fetch_lease(self.cfg)
            write.assert_not_called()


class HostResources(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="ezil-resources-unit-")
        self.addCleanup(tmp.cleanup)
        self.cfg = config.Config(dict(config.DEFAULTS))
        self.cfg.update(runDir=os.path.join(tmp.name, "run"), dataMount=os.path.join(tmp.name, "data"),
                        meminfoFile=os.path.join(tmp.name, "meminfo"),
                        imageConfigFile=os.path.join(tmp.name, "image.json"),
                        seccompProfile=os.path.join(tmp.name, "seccomp.json"))
        for path, data in ((self.cfg.imageConfigFile, {"Env": [], "WorkingDir": "/"}),
                           (self.cfg.seccompProfile, {"defaultAction": "SCMP_ACT_ERRNO", "syscalls": []})):
            with open(path, "w") as f:
                json.dump(data, f)
        self.meminfo("MemTotal: 4194304 kB\nMemAvailable: 1 kB\n")
        patch = mock.patch.object(desktop.os, "sysconf", return_value=2)
        self.cpus = patch.start()
        self.addCleanup(patch.stop)

    def meminfo(self, contents):
        with open(self.cfg.meminfoFile, "w") as f:
            f.write(contents)

    def resources(self):
        bundle = desktop.build_spec(self.cfg, {"generation": 1, "leaseEpoch": 1})
        with open(os.path.join(bundle, "config.json")) as f:
            return json.load(f)["linux"]["resources"]

    def test_four_gib_host_reserves_512_mib_and_uses_online_cpus(self):
        resources = self.resources()
        self.assertEqual(resources["memory"]["limit"], 3584 * 1024**2)
        self.assertEqual(resources["cpu"], {"quota": 200000, "period": 100000})
        self.cpus.assert_called_once_with("SC_NPROCESSORS_ONLN")

    def test_custom_reserve_and_larger_host(self):
        self.cfg["hostMemoryReserveMiB"] = 1024
        self.meminfo("MemTotal: 16777216 kB\n")
        self.cpus.return_value = 8
        resources = self.resources()
        self.assertEqual(resources["memory"]["limit"], 15 * 1024**3)
        self.assertEqual(resources["cpu"]["quota"], 800000)

    def test_one_gib_boundary_and_refusal_before_spec_write(self):
        self.meminfo("MemTotal: 1572863 kB\n")
        with self.assertRaisesRegex(Refused, "host_memory_insufficient"):
            self.resources()
        self.assertFalse(os.path.exists(self.cfg.runDir))
        self.meminfo("MemTotal: 1572864 kB\n")
        self.assertEqual(self.resources()["memory"]["limit"], 1024**3)

    def test_invalid_reserve_and_unreadable_memory(self):
        for reserve in (-1, True, "512", 1.5):
            self.cfg["hostMemoryReserveMiB"] = reserve
            with self.assertRaisesRegex(Refused, "host_memory_reserve_invalid"):
                desktop.host_limits(self.cfg)
        self.cfg["hostMemoryReserveMiB"] = 512
        for contents in ("", "MemFree: 4194304 kB\n", "MemTotal: -1 kB\n",
                         "MemTotal: 4 GiB\n", "MemTotal: 0 kB\n"):
            self.meminfo(contents)
            with self.assertRaisesRegex(Refused, "host_memory_unreadable"):
                desktop.host_limits(self.cfg)
        os.unlink(self.cfg.meminfoFile)
        with self.assertRaisesRegex(Refused, "host_memory_unreadable"):
            desktop.host_limits(self.cfg)

    def test_invalid_or_unavailable_online_cpu_count(self):
        for cpus in (0, -1, None, True):
            self.cpus.return_value = cpus
            with self.assertRaisesRegex(Refused, "host_cpu_unreadable"):
                desktop.host_limits(self.cfg)
        self.cpus.side_effect = OSError("unavailable")
        with self.assertRaisesRegex(Refused, "host_cpu_unreadable"):
            desktop.host_limits(self.cfg)


if __name__ == "__main__":
    unittest.main()
