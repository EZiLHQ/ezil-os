#!/usr/bin/env python3
"""The host's copy of the Worker snapshot codec, and its `export-capture` op
(REVERSE-MOVE-CONTRACT §2.6, §2.7 "codec parity; exit 3 from export-capture").

Parity: lib/ezil_host/workspace-snapshot-script.py is byte-identical to the String.raw body
of worker/src/workspace-snapshot-script.ts (evaluated by node when present, else extracted
the same way ami/sync-codec.py does). The bake archives only infra/host-agent, so this copy is
what an AWS host runs. The codec tests run the COPY with this interpreter, as the export
container does (`python3 -I -c`), on scratch workspaces; `work` is a real
/tmp/ezil-snapshot-<uuid> (the codec asserts that shape) and is removed by exact path.
Run: python3 -B -m unittest -v test_codec_parity   (from infra/host-agent/test)."""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
SOURCE = os.path.join(ROOT, "worker", "src", "workspace-snapshot-script.ts")
COPY = os.path.join(HERE, "..", "lib", "ezil_host", "workspace-snapshot-script.py")
SYNC = os.path.join(HERE, "..", "ami", "sync-codec.py")


def load_sync():
    spec = importlib.util.spec_from_file_location("sync_codec", SYNC)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


class Parity(unittest.TestCase):
    def test_copy_is_the_worker_codec_byte_for_byte(self):
        text = read(SOURCE)
        expected = load_sync().codec_from_source(text)
        if shutil.which("node"):
            # Evaluates this repository's own source literal (as test_restore does), never input.
            js = ("const fs=require('fs');const s=fs.readFileSync(process.argv[1],'utf8');"
                  "process.stdout.write(eval(s.slice(s.indexOf('String.raw`'),s.indexOf('`;')+1)));")
            evaluated = subprocess.check_output(["node", "-e", js, SOURCE], text=True)
            self.assertEqual(evaluated, expected, "the extraction must equal what JavaScript evaluates")
        self.assertEqual(read(COPY), expected,
                         "lib/ezil_host/workspace-snapshot-script.py drifted: run infra/host-agent/ami/sync-codec.py")
        self.assertEqual(subprocess.run([sys.executable, "-B", SYNC, "--check"], capture_output=True).returncode, 0)

    def test_extraction_refuses_a_template_it_cannot_copy_verbatim(self):
        sync = load_sync()
        for bad in ("export const SNAPSHOT_SCRIPT = String.raw`a ${b} c`;\n",
                    "export const SNAPSHOT_SCRIPT = String.raw`a `;\nexport const SNAPSHOT_SCRIPT = String.raw`b`;\n",
                    "const OTHER = 1;\n"):
            with self.subTest(bad=bad[:40]):
                with self.assertRaises(ValueError):
                    sync.codec_from_source(bad)

    def test_export_capture_is_additive(self):
        codec = read(COPY)
        # The Worker's existing ops are unchanged: capture still checks the marker, exit 4
        # (hydration incomplete) is still capture/check only, and the injection point the
        # Worker tests use (workspace-persist.test.ts) is unchanged.
        self.assertIn("elif op in ('capture', 'export-capture'):", codec)
        self.assertIn("result = capture(os.path.join(work, 'archive.tar'), op == 'capture')", codec)
        self.assertIn("if op in ('capture', 'check') and str(e) == 'hydration incomplete':", codec)
        self.assertIn("result = capture(os.path.join(work, 'verify.tar'))", codec)
        self.assertIn("try:\n    op = p['op']", codec)


class Codec(unittest.TestCase):
    """Runs the copied codec exactly as the export container does: python3 -I -c <script> <json>."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="ezil-codec-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = os.path.join(self.tmp, "workspace")
        os.mkdir(self.root)
        self.work = "/tmp/ezil-snapshot-" + str(uuid.uuid4())
        self.addCleanup(shutil.rmtree, self.work, True)      # this exact path only (shared /tmp)
        self.codec = read(COPY)

    def run_codec(self, op, codec=None, **params):
        return subprocess.run([sys.executable, "-I", "-c", codec or self.codec,
                               json.dumps({"op": op, "root": self.root, "work": self.work, **params})],
                              capture_output=True, text=True, timeout=120)

    def write(self, rel, data=b"x"):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)

    def test_export_capture_needs_no_marker_and_stages_chunks_like_capture(self):
        self.write("src/main.py", b"print('hi')\n" * 100000)      # 1.2 MB: two chunks
        self.write("README.md", b"hello\n")
        os.symlink("src/main.py", os.path.join(self.root, "link"))
        r = self.run_codec("export-capture")
        self.assertEqual(r.returncode, 0, r.stderr)
        result = json.loads(r.stdout)
        self.assertEqual(set(result), {"sha256", "chunks", "entries", "skipped"})
        self.assertEqual((result["entries"], result["skipped"]), (4, 0))     # src, src/main.py, README.md, link
        with open(os.path.join(self.work, "archive.tar"), "rb") as f:
            archive = f.read()
        self.assertEqual(hashlib.sha256(archive).hexdigest(), result["sha256"])
        self.assertEqual(len(result["chunks"]), 2)
        joined = b""
        for i, c in enumerate(result["chunks"]):
            with open(os.path.join(self.work, str(i)), "rb") as f:
                data = f.read()
            self.assertEqual((len(data), hashlib.sha256(data).hexdigest()), (c["size"], c["sha256"]))
            joined += data
        self.assertEqual(joined, archive)
        self.assertEqual(result["chunks"][0]["size"], 1024 * 1024)

    def test_capture_still_refuses_an_unhydrated_workspace_with_exit_4(self):
        self.write("a.txt")
        r = self.run_codec("capture", prefix="p", expected=None)
        self.assertEqual(r.returncode, 4, r.stderr)

    def test_export_capture_counts_what_it_skips_and_drops_caches_uncounted(self):
        self.write("keep.txt")
        self.write("node_modules/pkg/index.js")          # untracked cache: dropped, not counted
        self.write("dist/out.js")
        self.write(".ezil-hydrated.json", b"{}")         # codec-internal: dropped, not counted
        os.symlink("/etc/passwd", os.path.join(self.root, "abs"))      # absolute link: skipped, counted
        os.symlink("../outside", os.path.join(self.root, "escape"))   # escaping link: skipped, counted
        os.mkfifo(os.path.join(self.root, "pipe"))                    # FIFO: skipped, counted
        r = self.run_codec("export-capture")
        self.assertEqual(r.returncode, 0, r.stderr)
        result = json.loads(r.stdout)
        self.assertEqual((result["entries"], result["skipped"]), (1, 3))

    def test_export_capture_limits_exit_3(self):
        for i in range(3):
            self.write(f"f{i}")
        limited = self.codec.replace("MAX_ENTRIES = 100000", "MAX_ENTRIES = 2", 1)
        self.assertNotEqual(limited, self.codec)
        r = self.run_codec("export-capture", codec=limited)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn("too large", r.stderr)

    def test_export_capture_never_exits_4_and_other_failures_exit_1(self):
        os.makedirs(os.path.join(self.root, ".git"))
        self.write(".git/index.lock")                      # Git operation in progress: not a limit
        r = self.run_codec("export-capture")
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertNotIn("not hydrated", r.stderr)


if __name__ == "__main__":
    unittest.main()
