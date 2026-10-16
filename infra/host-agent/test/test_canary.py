"""Unprivileged canary tests; synthetic data only, no EC2 or real console access."""
import hashlib
import json
import subprocess
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))
from ezil_host import agent, canary, cli, config, desktop, guard  # noqa: E402
from ezil_host.fsops import Refused  # noqa: E402


class Canary(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        self.cfg.update(canaryConsole=True, runDir=str(self.root / "run"),
                        dataMount=str(self.root / "data"))
        self.home = Path(desktop.merged(self.cfg)) / "root"
        self.home.mkdir(parents=True)
        Path(self.cfg.dataMount).mkdir()
        writer = mock.patch.object(canary, "_write_console")
        self.writer = writer.start()
        self.addCleanup(writer.stop)

    def records(self):
        records = []
        for call in self.writer.call_args_list:
            line = call.args[0]
            self.assertLessEqual(len(line), 512)
            self.assertTrue(line.startswith(canary.PREFIX.encode()))
            self.assertEqual(line.count(b"\n"), 1)
            self.assertTrue(line.endswith(b"\n"))
            records.append(json.loads(line[len(canary.PREFIX):]))
        return records

    def document(self, name, value):
        (Path(self.cfg.dataMount) / name).write_text(json.dumps(value))

    def test_default_off_and_only_boolean_true_enables(self):
        self.assertIs(config.DEFAULTS["canaryConsole"], False)
        for value in (None, False, 0, 1, "true", "false"):
            with self.subTest(value=value):
                self.cfg["canaryConsole"] = value
                with mock.patch.object(canary.os, "open", side_effect=AssertionError("unexpected IO")), \
                     mock.patch.object(desktop, "runc", side_effect=AssertionError("unexpected runc")):
                    canary.guard_result(self.cfg, "ok")
                    canary.probe(self.cfg, "boot")
                    canary.desktop_started(self.cfg)
                    canary.stopped(self.cfg, "clean")
        self.writer.assert_not_called()

    def test_guard_uses_committed_marker_and_projects_last_stop(self):
        self.document(guard.MARKER, {"generation": 4, "leaseEpoch": 9})
        self.document(desktop.STOP_RECORD, {"outcome": "killed", "reason": "private",
                                           "at": 123, "generation": 3, "leaseEpoch": 8})
        with mock.patch.object(guard, "_run_guard", return_value="ok quarantined=private"):
            self.assertEqual(guard.run_guard(self.cfg, {}), "ok quarantined=private")
        self.assertEqual(self.records(), [{"v": 1, "event": "guard", "result": "ok",
                                          "generation": 4, "leaseEpoch": 9,
                                          "lastStop": {"outcome": "killed", "at": 123,
                                                       "generation": 3, "leaseEpoch": 8}}])

    def test_guard_failure_is_reported_without_reading_unmounted_data(self):
        for error, result in ((Refused("private", "private"), "refused"),
                              (OSError("private"), "error"), (SystemExit("private"), "error")):
            with self.subTest(result=result), \
                 mock.patch.object(guard, "_run_guard", side_effect=error), \
                 mock.patch.object(canary.os, "open", side_effect=AssertionError("unmounted data")):
                with self.assertRaises(type(error)):
                    guard.run_guard(self.cfg, {})
                self.assertEqual(self.records()[-1]["result"], result)
                self.assertIsNone(self.records()[-1]["generation"])

    def test_probe_round_trip_and_missing_files_are_not_repaired(self):
        canary.probe(self.cfg, "boot")
        missing = self.records()[-1]
        self.assertEqual(missing["sentinel"], "missing")
        self.assertIsNone(missing["sentinelSha256"])
        self.assertEqual(missing["history"], "missing")
        self.assertIsNone(missing["historyLines"])
        self.assertEqual(list(self.home.iterdir()), [])
        body = b"public persistence fixture\n"
        (self.home / canary.SENTINEL).write_bytes(body)
        (self.home / ".bash_history").write_bytes(b"echo public\n" + canary.HISTORY_MARKER + b"\nlast")
        canary.probe(self.cfg, "shutdown")
        # Fresh configuration, same persisted bytes; real EBS cold boot is an integration check.
        canary.probe(config.Config(dict(self.cfg)), "boot")
        before, after = self.records()[-2:]
        self.assertEqual(before["sentinelSha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(before["historyLines"], 3)
        self.assertIs(before["historyMarker"], True)
        before.pop("phase")
        after.pop("phase")
        self.assertEqual(before, after)

    def test_history_empty_trailing_newline_and_exact_marker(self):
        for raw, count, marker in ((b"", 0, False), (b"\n", 1, False),
                                    (canary.HISTORY_MARKER + b"\n", 1, True),
                                    (canary.HISTORY_MARKER + b"-suffix\n", 1, False)):
            with self.subTest(raw=raw):
                (self.home / ".bash_history").write_bytes(raw)
                canary.probe(self.cfg, "boot")
                self.assertEqual(self.records()[-1]["historyLines"], count)
                self.assertIs(self.records()[-1]["historyMarker"], marker)

    def test_hostile_files_are_unreadable_and_never_opened(self):
        target = self.root / "public-fixture"
        target.write_bytes(b"fixture")
        for kind in ("symlink", "fifo", "directory", "oversize"):
            path = self.home / canary.SENTINEL
            with self.subTest(kind=kind):
                if kind == "symlink":
                    path.symlink_to(target)
                elif kind == "fifo":
                    os.mkfifo(path)
                elif kind == "directory":
                    path.mkdir()
                else:
                    path.write_bytes(b"x" * (canary.SENTINEL_LIMIT + 1))
                with mock.patch.object(canary, "read_regular_at", side_effect=AssertionError("unsafe read")):
                    canary.probe(self.cfg, "boot")
                self.assertEqual(self.records()[-1]["sentinel"], "unreadable")
                path.rmdir() if kind == "directory" else path.unlink()
        self.home.rmdir()
        self.home.symlink_to(self.root, target_is_directory=True)
        canary.probe(self.cfg, "boot")
        self.assertEqual(self.records()[-1]["history"], "unreadable")

    def test_malformed_metadata_and_oversize_history(self):
        (Path(self.cfg.dataMount) / guard.MARKER).write_bytes(b"{")
        self.document(desktop.STOP_RECORD, ["invalid"])
        canary.guard_result(self.cfg, "ok")
        self.assertIsNone(self.records()[-1]["leaseEpoch"])
        self.assertEqual(self.records()[-1]["lastStop"]["outcome"], "unreadable")
        (self.home / ".bash_history").write_bytes(b"x" * (canary.HISTORY_LIMIT + 1))
        canary.probe(self.cfg, "shutdown")
        self.assertEqual(self.records()[-1]["history"], "unreadable")
        self.assertIsNone(self.records()[-1]["historyMarker"])

    def test_no_secret_ever_reaches_console_writer(self):
        secrets = {"nonce": "synthetic-nonce-DO-NOT-PRINT",
                   "tunnelToken": "synthetic-token-DO-NOT-PRINT",
                   "controlKey": "synthetic-control-DO-NOT-PRINT"}
        payload = "\n".join(secrets.values())
        self.cfg.update(secrets)
        self.document(guard.MARKER, {**secrets, "generation": payload, "leaseEpoch": True})
        self.document(desktop.STOP_RECORD, {**secrets, "reason": payload,
                                           "outcome": payload, "at": payload,
                                           "generation": 1 << 200, "leaseEpoch": payload})
        (self.home / canary.SENTINEL).write_text(payload)
        (self.home / ".bash_history").write_text(payload)
        canary.guard_result(self.cfg, "ok quarantined=" + payload)
        canary.guard_result(self.cfg, payload)
        canary.probe(self.cfg, "boot")
        canary.stopped(self.cfg, payload, source=payload, quiesce_ok=payload)
        with mock.patch.object(desktop, "runc", return_value=SimpleNamespace(
                returncode=0, stdout=json.dumps({"status": "running", **secrets}))):
            canary.desktop_started(self.cfg, wait_seconds=0)
        output = b"".join(c.args[0] for c in self.writer.call_args_list)
        for key, secret in secrets.items():
            self.assertNotIn(key.encode(), output)
            self.assertNotIn(secret.encode(), output)
        self.assertEqual(len(self.records()), 5)

    def test_console_failure_is_best_effort(self):
        self.writer.side_effect = OSError("synthetic secret must not be logged")
        with mock.patch("builtins.print") as log:
            canary.probe(self.cfg, "boot")
            canary.guard_result(self.cfg, "error")
            canary.stopped(self.cfg, "clean")
        log.assert_not_called()

    def test_desktop_requires_observed_running_state(self):
        for state, expected in (("created", "unconfirmed"), ("running", "started")):
            with mock.patch.object(desktop, "runc", return_value=SimpleNamespace(
                    returncode=0, stdout=json.dumps({"status": state}))):
                canary.desktop_started(self.cfg, wait_seconds=0)
            self.assertEqual(self.records()[-1]["result"], expected)

    def test_foreground_hook_needs_no_lease_or_enrollment(self):
        unit = (HERE.parent / "systemd" / "ezil-desktop.service").read_text()
        self.assertIn("ExecStartPost=/opt/ezil-host/bin/ezil-host-agent canary-desktop-started", unit)
        with mock.patch.object(config, "load", return_value=self.cfg), \
             mock.patch.object(cli, "_lease", side_effect=AssertionError("lease read")), \
             mock.patch.object(desktop, "runc", return_value=SimpleNamespace(
                 returncode=0, stdout='{"status":"running"}')):
            self.assertEqual(cli.main(["canary-desktop-started"]), 0)
        self.assertEqual(self.records()[-1]["result"], "started")

    def test_detached_start_reports_only_after_success(self):
        with mock.patch.object(desktop, "runc", side_effect=[
                SimpleNamespace(returncode=0),
                SimpleNamespace(returncode=0, stdout='{"status":"running"}')]):
            self.assertEqual(desktop.run(self.cfg, detach=True), 0)
        self.assertEqual(self.records()[-1]["result"], "started")
        self.writer.reset_mock()
        with mock.patch.object(desktop, "runc", return_value=SimpleNamespace(returncode=1)):
            self.assertEqual(desktop.run(self.cfg, detach=True), 1)
        self.writer.assert_not_called()

    def test_overlay_mount_reports_boot_probe(self):
        with mock.patch.object(desktop.os.path, "isdir", return_value=True), \
             mock.patch.object(desktop.subprocess, "run", side_effect=[
                 SimpleNamespace(returncode=1), SimpleNamespace(returncode=0)]):
            desktop.overlay_mount(self.cfg, lower="/fixture-lower")
        self.assertEqual(self.records()[-1]["phase"], "boot")

    def test_stop_samples_history_after_shells_finish(self):
        def finish(*args):
            (self.home / ".bash_history").write_bytes(canary.HISTORY_MARKER + b"\n")
            return "killed"
        with mock.patch.object(desktop, "_stop", side_effect=finish):
            self.assertEqual(desktop.stop(self.cfg), "killed")
        probe, stop = self.records()
        self.assertIs(probe["historyMarker"], True)
        self.assertEqual(stop["outcome"], "killed")
        self.writer.reset_mock()
        with mock.patch.object(desktop, "_stop", side_effect=OSError("private")):
            with self.assertRaises(OSError):
                desktop.stop(self.cfg)
        self.assertEqual(self.records()[-1]["outcome"], "error")

    def test_agent_shutdown_probes_before_unmount_and_keeps_worst_outcome(self):
        worker = agent.Agent.__new__(agent.Agent)  # no control key or enrollment needed by these hooks
        worker.cfg, worker.stop_outcome, worker.log = self.cfg, "killed", lambda _: None
        worker.sleep = lambda _: None              # power_off retries a failed poweroff
        order = []
        with mock.patch.object(agent.tunnel, "fence"), mock.patch.object(agent.time, "sleep"), \
             mock.patch.object(worker, "record_stop"), mock.patch.object(guard, "clear_stamp"), \
             mock.patch.object(desktop, "_stop", return_value="absent"), \
             mock.patch.object(canary, "probe", side_effect=lambda *_: order.append("probe")), \
             mock.patch.object(desktop, "overlay_umount", side_effect=lambda *_: order.append("unmount")), \
             mock.patch.object(desktop, "netns_down", side_effect=OSError("private")), \
             mock.patch.object(agent.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)):
            worker.shutdown("private")
        self.assertEqual(order, ["probe", "unmount"])
        final = self.records()[-1]
        self.assertEqual(final["source"], "agent")
        self.assertEqual(final["outcome"], "killed")
        self.assertIs(final["quiesceOk"], False)


class ConsoleWriter(unittest.TestCase):
    def test_serial_device_flags_and_single_write(self):
        line = b'EZIL-CANARY {"v":1}\n'
        with mock.patch.object(canary.os, "open", return_value=99) as opened, \
             mock.patch.object(canary.os, "fstat", return_value=SimpleNamespace(st_mode=stat.S_IFCHR)), \
             mock.patch.object(canary.os, "write") as write, mock.patch.object(canary.os, "close") as close:
            canary._write_console(line)
        self.assertEqual(opened.call_args.args[0], "/dev/ttyS0")
        flags = opened.call_args.args[1]
        self.assertTrue(flags & os.O_NONBLOCK)
        self.assertTrue(flags & os.O_NOCTTY)
        self.assertTrue(flags & os.O_NOFOLLOW)
        self.assertFalse(flags & os.O_CREAT)
        write.assert_called_once_with(99, line)
        close.assert_called_once_with(99)


class ToolProbe(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        self.cfg.update(canaryConsole=True, runDir=str(self.root / "run"))
        self.rootfs = Path(desktop.merged(self.cfg))
        self.home = self.rootfs / "root"
        self.home.mkdir(parents=True)
        self.link = self.rootfs / "usr/local/bin/ezil-canary-tool"
        self.link.parent.mkdir(parents=True)
        self.package = self.rootfs / "usr/local/lib/node_modules/canary-fixture"
        self.package.mkdir(parents=True)
        self.target = self.package / "tool"
        self.relative = "../lib/node_modules/canary-fixture/tool"
        writer = mock.patch.object(canary, "_write_console")
        self.writer = writer.start()
        self.addCleanup(writer.stop)

    def record(self, phase="boot"):
        self.writer.reset_mock()
        canary.probe(self.cfg, phase)
        self.writer.assert_called_once()  # A silently dropped oversize line is a failure.
        line = self.writer.call_args.args[0]
        self.assertLessEqual(len(line), 512)
        self.assertEqual(line.count(b"\n"), 1)
        record = json.loads(line[len(canary.PREFIX):])
        self.assertEqual(record["event"], "persistence")
        return record

    def assert_status(self, expected):
        record = self.record()
        self.assertEqual(record["toolStatus"], expected)
        self.assertIsNone(record["toolSha256"])

    def assert_no_file_read(self, expected):
        real_open = os.open

        def directories_only(path, flags, *args, **kwargs):
            self.assertTrue(flags & os.O_DIRECTORY, "probe tried to open a file")
            self.assertTrue(flags & os.O_NOFOLLOW)
            return real_open(path, flags, *args, **kwargs)

        with mock.patch.object(canary, "read_regular_at", side_effect=AssertionError("unsafe read")), \
             mock.patch.object(canary.os, "open", side_effect=directories_only):
            self.assert_status(expected)

    def test_relative_tool_hash_survives_shutdown_and_fresh_boot_probe(self):
        body = b"#!/bin/sh\necho synthetic-public-tool-fixture\n"
        self.target.write_bytes(body)
        self.link.symlink_to(self.relative)
        for phase in ("shutdown", "boot"):
            self.cfg = config.Config(dict(self.cfg))
            with mock.patch.object(canary, "read_regular_at", wraps=canary.read_regular_at) as read:
                record = self.record(phase)
            read.assert_called_once()
            self.assertEqual(record["phase"], phase)
            self.assertEqual(record["toolStatus"], "ok")
            self.assertEqual(record["toolSha256"], hashlib.sha256(body).hexdigest())
            self.assertNotIn(body, self.writer.call_args.args[0])
        self.assertEqual(os.readlink(self.link), self.relative)
        self.assertEqual(self.target.read_bytes(), body)

    def test_absent_tool_and_missing_bin_directory_are_not_created(self):
        self.assert_status("absent")
        self.assertFalse(self.link.exists())
        self.link.parent.rmdir()
        self.assert_status("absent")
        self.assertFalse(self.link.parent.exists())

    def test_absolute_shadow_target_is_refused_without_opening_any_file(self):
        self.link.symlink_to("/etc/shadow")
        self.assert_no_file_read("refused")

    def test_relative_escape_and_escape_then_reentry_are_refused(self):
        for target in ("../../../../etc/shadow", "../lib/node_modules/../../../etc/shadow",
                       "../lib/node_modules/../node_modules/canary-fixture/tool",
                       "../lib/node_modules-other/tool"):
            with self.subTest(target=target):
                self.link.symlink_to(target)
                self.assert_no_file_read("refused")
                self.link.unlink()

    def test_parent_within_node_modules_is_allowed(self):
        (self.package / "subdir").mkdir()
        body = b"public fixture"
        self.target.write_bytes(body)
        self.link.symlink_to("../lib/node_modules/canary-fixture/subdir/.././tool")
        record = self.record()
        self.assertEqual(record["toolStatus"], "ok")
        self.assertEqual(record["toolSha256"], hashlib.sha256(body).hexdigest())

    def test_loop_and_nested_symlink_targets_are_refused(self):
        self.link.symlink_to(self.link.name)
        self.assert_no_file_read("refused")
        self.link.unlink()
        self.link.symlink_to(self.relative)
        regular = self.package / "regular"
        regular.write_bytes(b"public fixture")
        for target in ("tool", "regular", "/etc/shadow"):
            with self.subTest(target=target):
                self.target.symlink_to(target)
                self.assert_no_file_read("refused")
                self.target.unlink()

    def test_symlinked_parent_components_are_refused(self):
        self.target.write_bytes(b"public fixture")
        self.link.symlink_to(self.relative)
        for rel in ("usr", "usr/local", "usr/local/bin", "usr/local/lib",
                    "usr/local/lib/node_modules", "usr/local/lib/node_modules/canary-fixture"):
            with self.subTest(parent=rel):
                path = self.rootfs / rel
                saved = self.root / "saved"
                path.rename(saved)
                path.symlink_to(saved, target_is_directory=True)
                try:
                    self.assert_no_file_read("refused")
                finally:
                    path.unlink()
                    saved.rename(path)

    def test_dotdot_does_not_hide_a_nested_symlink(self):
        self.target.write_bytes(b"public fixture")
        (self.package / "alias").symlink_to(".", target_is_directory=True)
        self.link.symlink_to("../lib/node_modules/canary-fixture/alias/../tool")
        self.assert_no_file_read("refused")

    def test_fifo_and_directory_targets_are_unreadable_without_opening(self):
        self.link.symlink_to(self.relative)
        os.mkfifo(self.target)
        self.assert_no_file_read("unreadable")
        self.target.unlink()
        self.target.mkdir()
        self.assert_no_file_read("unreadable")

    def test_dangling_and_oversized_targets_are_unreadable(self):
        self.link.symlink_to(self.relative)
        self.assert_no_file_read("unreadable")
        self.package.rmdir()
        self.assert_no_file_read("unreadable")
        self.package.mkdir()
        self.target.write_bytes(b"x" * (canary.SENTINEL_LIMIT + 1))
        self.assert_no_file_read("unreadable")

    def test_tool_entry_must_be_a_symlink(self):
        self.link.write_bytes(b"public fixture")
        self.assert_no_file_read("refused")

    def test_read_failure_is_unreadable(self):
        self.target.write_bytes(b"public fixture")
        self.link.symlink_to(self.relative)
        with mock.patch.object(canary, "read_regular_at", return_value=None):
            self.assert_status("unreadable")

    def test_symlink_swap_before_read_never_opens_its_target(self):
        self.target.write_bytes(b"public fixture")
        self.link.symlink_to(self.relative)
        read = canary.read_regular_at

        def replace_with_link(*args, **kwargs):
            self.target.unlink()
            self.target.symlink_to("/etc/shadow")
            return read(*args, **kwargs)

        with mock.patch.object(canary, "read_regular_at", side_effect=replace_with_link), \
             mock.patch.object(canary.os, "read", side_effect=AssertionError("host file read")):
            self.assert_status("unreadable")

    def test_largest_probe_values_emit_one_line_below_console_limit(self):
        self.target.write_bytes(b"t" * canary.SENTINEL_LIMIT)
        self.link.symlink_to(self.relative)
        (self.home / canary.SENTINEL).write_bytes(b"s" * canary.SENTINEL_LIMIT)
        (self.home / ".bash_history").write_bytes(b"\n" * canary.HISTORY_LIMIT)
        record = self.record("shutdown")
        self.assertEqual(record["historyLines"], canary.HISTORY_LIMIT)
        self.assertIs(record["historyMarker"], False)
        self.assertEqual(len(record["sentinelSha256"]), 64)
        self.assertEqual(len(record["toolSha256"]), 64)
        # Also bound every status with all longest measurements present (a conservative ceiling).
        for status in ("absent", "ok", "unreadable", "refused"):
            self.writer.reset_mock()
            fields = dict(record, sentinel="unreadable", history="unreadable", toolStatus=status,
                          historyLines=(1 << 63) - 1)
            fields.pop("v")
            fields.pop("event")
            canary._emit(self.cfg, "persistence", fields)
            self.writer.assert_called_once()
            self.assertLessEqual(len(self.writer.call_args.args[0]), 512)


if __name__ == "__main__":
    unittest.main()


class RealToolProbe(unittest.TestCase):
    """canaryTools: the real installed tool (e.g. opencode) after each boot/shutdown, never its bytes when large."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        self.cfg.update(canaryConsole=True, runDir=str(self.root / "run"), canaryTools=["opencode"])
        self.rootfs = Path(desktop.merged(self.cfg))
        (self.rootfs / "root").mkdir(parents=True)
        self.bin = self.rootfs / "usr/local/bin"
        self.bin.mkdir(parents=True)
        self.package = self.rootfs / "usr/local/lib/node_modules/opencode-ai"
        (self.package / "bin").mkdir(parents=True)
        writer = mock.patch.object(canary, "_write_console")
        self.writer = writer.start()
        self.addCleanup(writer.stop)

    def install(self, body, version="1.19.0", name="opencode"):
        (self.package / "bin" / name).write_bytes(body)
        (self.package / "package.json").write_text(json.dumps({"name": "opencode-ai", "version": version}))
        (self.bin / name).symlink_to(f"../lib/node_modules/opencode-ai/bin/{name}")

    def events(self, phase="boot"):
        self.writer.reset_mock()
        canary.probe(self.cfg, phase)
        lines = [call.args[0] for call in self.writer.call_args_list]
        for line in lines:
            self.assertLessEqual(len(line), 512)
        records = [json.loads(line[len(canary.PREFIX):]) for line in lines]
        self.assertEqual(records[0]["event"], "persistence")
        return [r for r in records if r["event"] == "tool"]

    def test_large_binary_reports_size_and_version_without_reading_it(self):
        self.install(b"\x7fELF" + b"x" * (canary.SENTINEL_LIMIT + 10))
        read = mock.patch.object(canary, "read_regular_at", wraps=canary.read_regular_at)
        with read as spy:
            [event] = self.events("shutdown")
        self.assertEqual(event, {"v": 1, "event": "tool", "phase": "shutdown", "name": "opencode", "status": "large",
                                 "sha256": None, "size": canary.SENTINEL_LIMIT + 14, "version": "1.19.0"})
        self.assertEqual([call.args[1] for call in spy.call_args_list], ["package.json"])

    def test_small_launcher_is_hashed(self):
        body = b"#!/usr/bin/env node\nrequire('../dist/cli.js')\n"
        self.install(body)
        [event] = self.events()
        self.assertEqual((event["status"], event["sha256"], event["size"], event["version"]),
                         ("ok", hashlib.sha256(body).hexdigest(), len(body), "1.19.0"))

    def test_absent_tool_is_reported_and_nothing_is_created(self):
        [event] = self.events()
        self.assertEqual((event["status"], event["size"], event["version"]), ("absent", None, None))
        self.assertFalse((self.bin / "opencode").exists())

    def test_off_by_default_and_invalid_names_are_ignored(self):
        self.install(b"tool")
        self.cfg["canaryTools"] = []
        self.assertEqual(self.events(), [])
        self.cfg["canaryTools"] = ["../opencode", "/usr/bin/env", "Opencode", "x" * 65, 7, "", "opencode"]
        self.assertEqual([e["name"] for e in self.events()], [])  # the valid name sits past MAX_TOOLS
        self.cfg["canaryTools"] = "opencode"
        self.assertEqual(self.events(), [])

    def test_hostile_or_malformed_package_json_gives_no_version(self):
        self.install(b"tool")
        manifest = self.package / "package.json"
        for body in (b"not json", b'["1.0.0"]', b'{"version": 1}', b'{"version": "1.0.0; rm -rf /"}',
                     b'{"version": "' + b"9" * 40 + b'"}', b"{" + b" " * (canary.PACKAGE_LIMIT + 1) + b"}"):
            manifest.write_bytes(body)
            [event] = self.events()
            self.assertEqual((event["status"], event["version"]), ("ok", None))
        manifest.unlink()
        manifest.symlink_to("/etc/hostname")
        [event] = self.events()
        self.assertIsNone(event["version"])

    def test_deeply_nested_package_json_cannot_disrupt_boot_or_shutdown_probe(self):
        self.install(b"tool")
        body = b'{"version":"1.19.0","nested":' + b"[" * 16384 + b"0" + b"]" * 16384 + b"}"
        self.assertLessEqual(len(body), canary.PACKAGE_LIMIT)
        with self.assertRaises(RecursionError):
            json.loads(body)
        (self.package / "package.json").write_bytes(body)
        for phase in ("boot", "shutdown"):
            with self.subTest(phase=phase):
                [event] = self.events(phase)
                self.assertEqual((event["status"], event["version"], event["phase"]), ("ok", None, phase))

    def test_bin_link_escaping_node_modules_is_refused_and_unread(self):
        (self.bin / "opencode").symlink_to("/etc/shadow")
        with mock.patch.object(canary, "read_regular_at", side_effect=AssertionError("unsafe read")):
            [event] = self.events()
        self.assertEqual((event["status"], event["version"]), ("refused", None))

    def test_scoped_package_version_and_worst_case_line_length(self):
        name = "a" * 64
        scoped = self.rootfs / "usr/local/lib/node_modules/@scope/pkg"
        (scoped / "bin").mkdir(parents=True)
        (scoped / "bin" / name).write_bytes(b"y" * 32)
        (scoped / "package.json").write_text(json.dumps({"version": "9" * 32}))
        (self.bin / name).symlink_to(f"../lib/node_modules/@scope/pkg/bin/{name}")
        self.cfg["canaryTools"] = [name]
        [event] = self.events("shutdown")
        self.assertEqual((event["status"], event["version"]), ("ok", "9" * 32))

    def test_oversized_or_special_package_json_is_never_opened(self):
        self.install(b"tool")
        manifest = self.package / "package.json"
        manifest.write_bytes(b'{"version": "1.0.0"}' + b" " * canary.PACKAGE_LIMIT)
        opened = []
        real = canary.read_regular_at
        with mock.patch.object(canary, "read_regular_at", side_effect=lambda *a, **k: opened.append(a[1]) or real(*a, **k)):
            [event] = self.events()
            manifest.unlink()
            os.mkfifo(manifest)
            [fifo] = self.events()
        self.assertEqual((event["version"], fifo["version"]), (None, None))
        self.assertNotIn("package.json", opened)
