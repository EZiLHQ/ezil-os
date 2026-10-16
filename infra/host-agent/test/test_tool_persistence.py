#!/usr/bin/env python3
"""Unprivileged tool persistence checks; no mounts, runc, Docker or network."""
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))
from ezil_host import config, desktop, rebase  # noqa: E402


class ToolSpec(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.image_path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        image = self.root / "image.json"
        image.write_text(json.dumps({"Env": ["PATH=" + self.image_path], "WorkingDir": "/"}))
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        self.cfg.update(runDir=str(self.root / "run"), dataMount=str(self.root / "retained-data"),
                        imageConfigFile=str(image),
                        seccompProfile=str(HERE.parent / "security" / "seccomp.json"))
        with mock.patch.object(desktop, "host_limits", return_value=(200000, 3584 * 1024**2)):
            bundle = desktop.build_spec(self.cfg, {"generation": 1, "leaseEpoch": 1})
        self.spec = json.loads((Path(bundle) / "config.json").read_text())

    def test_image_path_keeps_global_npm_bin(self):
        paths = [entry[5:] for entry in self.spec["process"]["env"] if entry.startswith("PATH=")]
        self.assertEqual(paths, [self.image_path])
        self.assertIn("/usr/local/bin", paths[0].split(":"))

    def test_home_is_on_the_writable_overlay(self):
        env = dict(entry.split("=", 1) for entry in self.spec["process"]["env"])
        self.assertEqual(env["HOME"], "/root")
        self.assertEqual(self.spec["root"], {"path": desktop.merged(self.cfg), "readonly": False})

    def test_no_mount_hides_installed_tools_or_home(self):
        for mount in self.spec["mounts"]:
            destination = PurePosixPath(mount["destination"])
            for protected in ("/usr", "/usr/local", "/opt", "/root"):
                with self.subTest(destination=str(destination), protected=protected):
                    self.assertNotEqual(destination, PurePosixPath(protected))
                    self.assertNotIn(PurePosixPath(protected), destination.parents)
            self.assertNotEqual(destination, PurePosixPath("/"))

    def test_overlay_upper_and_work_use_configured_retained_volume(self):
        lower = self.root / "lower"
        (lower / "usr").mkdir(parents=True)
        for mounted in (False, True):
            with self.subTest(already_mounted=mounted), \
                 mock.patch.object(desktop.subprocess, "run", side_effect=[
                     subprocess.CompletedProcess([], 0 if mounted else 1),
                     *([subprocess.CompletedProcess([], 0)] if mounted else []),
                     subprocess.CompletedProcess([], 0)]) as run:
                self.assertEqual(desktop.overlay_mount(self.cfg, lower=str(lower)), self.spec["root"]["path"])
            command = run.call_args.args[0]
            self.assertEqual(command[:4], ["mount", "-t", "overlay", "ezil-rootfs"])
            options = dict(option.split("=", 1) for option in command[command.index("-o") + 1].split(",")
                           if "=" in option)
            for option, name in (("upperdir", "upper"), ("workdir", "work")):
                path = Path(options[option])
                self.assertEqual(path, Path(self.cfg.dataMount) / "root" / name)
                self.assertIn(Path(self.cfg.dataMount), path.parents)


class ToolRebase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.upper, self.old, self.new = (root / name for name in ("upper", "old", "new"))
        self.upper.mkdir()
        for lower in (self.old, self.new):
            (lower / "var/lib/dpkg/info").mkdir(parents=True)
            (lower / rebase.DPKG_STATUS).write_bytes(b"Package: base\nArchitecture: amd64\n\n")
        self.files = {
            "usr/local/lib/node_modules/opencode-ai/package.json": b'{"name":"opencode-ai"}\n',
            "usr/local/lib/node_modules/opencode-ai/bin/opencode": b"#!/usr/bin/env node\n// fixture\n",
            "usr/local/lib/node_modules/opencode-ai/node_modules/dependency/data": bytes(range(256)),
        }
        for rel, body in self.files.items():
            path = self.upper / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        self.link = "usr/local/bin/opencode"
        self.target = "../lib/node_modules/opencode-ai/bin/opencode"
        (self.upper / self.link).parent.mkdir(parents=True)
        (self.upper / self.link).symlink_to(self.target)

    def run_rebase(self):
        # Production exits its subprocess after rebasing; close its lower lookup fds here.
        lookups = []
        lookup = rebase.Lookup

        def track(path):
            result = lookup(path)
            lookups.append(result)
            return result

        try:
            with mock.patch.object(rebase, "Lookup", side_effect=track), \
                 mock.patch.object(rebase.os, "sync"):
                return rebase.rebase(str(self.upper), str(self.old), str(self.new))
        finally:
            for item in lookups:
                os.close(item.root)

    def assert_package_unchanged(self):
        for rel, body in self.files.items():
            self.assertEqual((self.upper / rel).read_bytes(), body)

    def test_unowned_npm_package_and_relative_bin_symlink_are_kept(self):
        report = self.run_rebase()
        self.assert_package_unchanged()
        self.assertTrue((self.upper / self.link).is_symlink())
        self.assertEqual(os.readlink(self.upper / self.link), self.target)
        self.assertEqual((self.upper / self.link).read_bytes(), self.files[
            "usr/local/lib/node_modules/opencode-ai/bin/opencode"])
        self.assertEqual(report["moved_aside"], [])
        self.assertEqual(report["removed_identical"], [])
        self.assertIsNone(report["preserved_dir"])

    def test_image_owned_bin_collision_moves_user_symlink_without_deleting_it(self):
        image_bin = self.new / self.link
        image_bin.parent.mkdir(parents=True)
        image_bin.write_bytes(b"new image tool\n")
        original = (self.upper / self.link).lstat()
        report = self.run_rebase()
        self.assertEqual(report["moved_aside"], ["/" + self.link])
        self.assertEqual(report["removed_identical"], [])
        preserved = PurePosixPath(report["preserved_dir"])
        self.assertEqual(preserved.parts[:2], ("/", rebase.PRESERVE))
        saved = self.upper / str(preserved).lstrip("/") / self.link
        self.assertTrue(saved.is_symlink())
        self.assertEqual(os.readlink(saved), self.target)
        self.assertEqual((saved.lstat().st_dev, saved.lstat().st_ino), (original.st_dev, original.st_ino))
        self.assertFalse(os.path.lexists(self.upper / self.link))
        self.assert_package_unchanged()
        self.assertEqual(image_bin.read_bytes(), b"new image tool\n")


@unittest.skipUnless(shutil.which("tmux"), "tmux required for isolated new-session fixture")
class NewTmuxToolFixture(unittest.TestCase):
    """Exercise a retained npm layout in two real fresh tmux servers, without installing
    opencode or claiming an EBS/container lifecycle happened. The executable is a fixture
    which requires retained package metadata and a dependency to answer --version.
    """

    def test_command_runs_without_reinstall_in_each_new_server(self):
        with tempfile.TemporaryDirectory(prefix="ezil-tmux-tool-") as tmp:
            root = Path(tmp)
            upper = root / "data/root/upper"
            home = upper / "root"
            home.mkdir(parents=True)
            bin_dir = upper / "usr/local/bin"
            bin_dir.mkdir(parents=True)
            package = upper / "usr/local/lib/node_modules/opencode-ai"
            (package / "bin").mkdir(parents=True)
            dependency = package / "node_modules/runtime/version"
            dependency.parent.mkdir(parents=True)
            dependency.write_text("fixture-opencode-1.0\n")
            (package / "package.json").write_text('{"name":"opencode-ai","version":"fixture-1.0"}\n')
            executable = package / "bin/opencode"
            executable.write_text('#!/bin/bash\nset -e\n[[ $1 == --version ]]\n'
                                  'package=$(dirname "$(dirname "$(readlink -f "$0")")")\n'
                                  'test -r "$package/package.json"\n'
                                  'cat "$package/node_modules/runtime/version"\n')
            executable.chmod(0o755)
            (bin_dir / "opencode").symlink_to("../lib/node_modules/opencode-ai/bin/opencode")
            script = root / "probe.sh"
            script.write_text('set -e\ntest -n "$TMUX"\ncommand -v opencode\n'
                              'readlink -f "$(command -v opencode)"\n'
                              'sha256sum "$(command -v opencode)"\nopencode --version\nprintf "%s\\n" "$HOME"\n')
            env = {"HOME": str(home), "PATH": f"{bin_dir}:/usr/bin:/bin", "TERM": "dumb"}
            observations, pids = [], []
            for index in range(2):
                socket = str(root / f"tmux-{index}.sock")
                result, done = root / f"result-{index}", root / f"done-{index}"
                command = ["tmux", "-S", socket, "-f", "/dev/null"]
                try:
                    subprocess.run([*command, "new-session", "-d", "-s", "fixture", "/bin/bash", "--noprofile", "--norc", "-c",
                                    '/bin/bash --noprofile --norc "$1" > "$2" 2>&1; printf "%s" "$?" > "$3"; exec sleep 30',
                                    "fixture", str(script), str(result), str(done)], env=env, check=True, capture_output=True)
                    deadline = time.monotonic() + 5
                    while not done.exists() and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertTrue(done.exists(), "new tmux session must finish its tool probe")
                    self.assertEqual(done.read_text(), "0", result.read_text())
                    pids.append(subprocess.run([*command, "display-message", "-p", "#{pid}"],
                                               env=env, check=True, capture_output=True, text=True).stdout.strip())
                    observations.append(result.read_text().splitlines())
                finally:
                    subprocess.run([*command, "kill-server"], env=env, capture_output=True, check=False)
            self.assertNotEqual(*pids)
            self.assertEqual(observations[0], observations[1])
            self.assertEqual(observations[0][0], str(bin_dir / "opencode"))
            self.assertEqual(observations[0][1], str(executable))
            self.assertEqual(observations[0][3:], ["fixture-opencode-1.0", str(home)])
            # Keeping the executable alone does not satisfy tool persistence.
            dependency.unlink()
            broken = subprocess.run([str(bin_dir / "opencode"), "--version"], env=env, capture_output=True)
            self.assertNotEqual(broken.returncode, 0)


if __name__ == "__main__":
    unittest.main()
