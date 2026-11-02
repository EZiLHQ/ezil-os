#!/usr/bin/env python3
"""Per-tab Code folder continuity: the host edge's `folder` op (edge.py FOLDER_RE, fsops.classify_dir_below).

Walk: the SHARED vectors (docs/contracts/code-folder-v1.vectors.json `walk`, `plainFolderPath`) on a scratch
tree, plus a symlinked workspace root, a missing root, a bad path and a component swapped for a link between
the lstat and the open (ELOOP), with nothing created.
FolderE2E: the real Edge on loopback (the test_edge.EdgeE2E rig) with a scratch dataMount: the signed digest,
framing, method, query and body refusals, each answer code, and `rel` never echoed or logged.
Run: python3 -m unittest -v test_folder   (from infra/host-agent/test)."""
import errno
import hashlib
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
sys.path.insert(0, HERE)
from ezil_host import fsops  # noqa: E402
import test_edge  # noqa: E402

VECTORS = os.path.join(HERE, "..", "..", "..", "docs", "contracts", "code-folder-v1.vectors.json")
with open(VECTORS, encoding="utf-8") as f:
    V = json.load(f)
GENERATED = {
    "SEGMENT_256_BYTES": "/workspace/" + "a" * 256,
    "PATH_2049_BYTES": "/" + ("b" * 200 + "/") * 10 + "c" * 38,
    "SEGMENTS_65": "/" + "/".join(["d"] * 65),
}


def make_tree(base):
    """The `walk` vectors' tree under base/workspace (and a sibling outside it)."""
    root = os.path.join(base, "workspace")
    os.makedirs(os.path.join(root, "sports", "sports-web"))
    with open(os.path.join(root, "sports", "next.config.ts"), "w") as f:
        f.write("x")
    os.makedirs(os.path.join(root, "real", "child"))
    os.makedirs(os.path.join(root, "My Project", "日本"))
    os.symlink("/etc", os.path.join(root, "link-out"))
    os.symlink(os.path.join(root, "real"), os.path.join(root, "link-in"))
    os.symlink(os.path.join(root, "real"), os.path.join(root, "via-link"))
    return root


def listing(base):
    out = []
    for d, dirs, files in os.walk(base):
        out += [os.path.join(d, n) for n in dirs + files]
    return sorted(out)


class Walk(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = make_tree(self.tmp.name)

    def test_shared_walk_vectors(self):
        before = listing(self.tmp.name)
        for c in V["walk"]:
            want = "ok" if c["expect"] == "restored" else c["expect"]
            self.assertEqual(fsops.classify_dir_below(self.root, c["rel"]), want, c["tree"])
        self.assertEqual(listing(self.tmp.name), before, "nothing created or removed")

    def test_symlinked_or_missing_root_and_bad_paths(self):
        linked = os.path.join(self.tmp.name, "linked-workspace")
        os.symlink(self.root, linked)
        self.assertEqual(fsops.classify_dir_below(linked, "sports"), "symlink")
        self.assertEqual(fsops.classify_dir_below(os.path.join(self.tmp.name, "absent"), ""), "missing")
        for rel in ("a/../b", "../etc", "/etc", "a//b", "a/./b", "a\\b", "a\nb", "a\x7fb", "\ud800", "x" * 256):
            self.assertEqual(fsops.classify_dir_below(self.root, rel), "bad_path", repr(rel))

    def test_a_component_swapped_for_a_link_after_the_lstat_is_refused(self):
        real_open = os.open

        def racing_open(path, flags, *a, dir_fd=None, **k):
            if dir_fd is not None and path == "sports":
                raise OSError(errno.ELOOP, "raced")
            return real_open(path, flags, *a, dir_fd=dir_fd, **k) if dir_fd is not None else real_open(path, flags, *a, **k)
        with mock.patch.object(fsops.os, "open", side_effect=racing_open):
            self.assertEqual(fsops.classify_dir_below(self.root, "sports/sports-web"), "symlink")

    def test_a_real_swap_to_a_link_between_lstat_and_open_names_the_link(self):
        real_open = os.open
        swapped = []

        def swapping_open(path, flags, *a, dir_fd=None, **k):
            if dir_fd is not None and path == "sports" and not swapped:
                swapped.append(1)
                os.rename(os.path.join(self.root, "sports"), os.path.join(self.root, "sports-was"))
                os.symlink(os.path.join(self.root, "sports-was"), os.path.join(self.root, "sports"))
            return real_open(path, flags, *a, dir_fd=dir_fd, **k) if dir_fd is not None else real_open(path, flags, *a, **k)
        with mock.patch.object(fsops.os, "open", side_effect=swapping_open):
            self.assertEqual(fsops.classify_dir_below(self.root, "sports/sports-web"), "symlink")

    def test_plain_rel_is_the_shared_grammar_below_the_root(self):
        # Every accepted absolute path below /workspace becomes an accepted rel; every rejected one that IS below
        # /workspace lexically (prefix) is a refused rel.
        for path, _ in V["plainFolderPath"]["accept"]:
            norm = path.rstrip("/") if path != "/" else path
            if norm == "/workspace" or norm.startswith("/workspace/"):
                self.assertTrue(fsops.plain_rel(norm[len("/workspace/"):] if norm != "/workspace" else ""), path)
        for raw in V["plainFolderPath"]["reject"]:
            path = GENERATED.get(raw, raw)
            if path.startswith("/workspace/") and raw != "PATH_2049_BYTES":
                self.assertFalse(fsops.plain_rel(path[len("/workspace/"):]), repr(raw))
        self.assertFalse(fsops.plain_rel(None))
        self.assertFalse(fsops.plain_rel("/".join(["d"] * 65)))
        self.assertFalse(fsops.plain_rel("e" * 2049))


class FolderE2E(unittest.TestCase):
    setUp = test_edge.EdgeE2E.setUp
    tearDown = test_edge.EdgeE2E.tearDown
    req = test_edge.EdgeE2E.req

    def tree(self):
        data = os.path.join(self.tmp, "data")
        make_tree(data)
        self.cfg.update(dataMount=data)
        return data

    def folder(self, rel=None, body=None, digest=None, headers=None, method="POST", query="", gw=True):
        raw = body if body is not None else json.dumps({"v": 1, "rel": rel}, ensure_ascii=False, separators=(",", ":")).encode()
        d = digest or hashlib.sha256(raw).hexdigest()
        hs = headers if headers is not None else [f"Content-Length: {len(raw)}"]
        return test_edge.raw(self.port, self.req(method, f"/__ezil/control/folder/{d}{query}", headers=hs, body=raw, gw=gw))

    def result(self, out):
        self.assertTrue(out.startswith(b"HTTP/1.1 200"), out[:120])
        return json.loads(out.split(b"\r\n\r\n", 1)[1])

    def test_each_answer_is_a_code_and_never_the_path(self):
        self.tree()
        for c in V["walk"]:
            want = "ok" if c["expect"] == "restored" else c["expect"]
            out = self.folder(c["rel"])
            self.assertEqual(self.result(out), {"ok": True, "result": want}, c["tree"])
            if c["rel"]:
                self.assertNotIn(c["rel"].encode(), out)
                self.assertNotIn(c["rel"], "\n".join(self.logs))

    def test_a_workspace_that_is_a_link_or_absent(self):
        data = os.path.join(self.tmp, "data")
        os.makedirs(data)
        self.cfg.update(dataMount=data)
        self.assertEqual(self.result(self.folder("")), {"ok": True, "result": "missing"})
        os.symlink("/etc", os.path.join(data, "workspace"))
        self.assertEqual(self.result(self.folder("")), {"ok": True, "result": "symlink"})

    def test_refusals(self):
        self.tree()
        good = json.dumps({"v": 1, "rel": "sports"}).encode()
        d = hashlib.sha256(good).hexdigest()
        cases = [
            (self.folder("sports", gw=False), b"401"),
            (self.folder(body=good, digest=hashlib.sha256(good + b" ").hexdigest()), b"400"),
            (self.folder(body=good, headers=["Content-Length: 99999"]), b"400"),
            (self.folder(body=good, headers=[f"Content-Length: {len(good)}"] * 2), b"400"),
            (self.folder(body=good, headers=["Transfer-Encoding: chunked"]), b"400"),
            (self.folder(body=b"", headers=["Content-Length: 0"]), b"400"),
            (self.folder(body=good, method="GET"), b"404"),
            (self.folder(body=good, query="?rel=x"), b"404"),
        ]
        for rel_body in ({"v": 2, "rel": "sports"}, {"v": True, "rel": "sports"}, {"v": 1, "rel": "../etc"},
                         {"v": 1, "rel": "/etc"}, {"v": 1, "rel": "sports", "x": 1}, {"v": 1}, ["sports"], "sports"):
            cases.append((self.folder(body=json.dumps(rel_body).encode()), b"400"))
        cases.append((self.folder(body=b'{"v":1,"rel":"\\ud800"}'), b"400"))
        cases.append((self.folder(body=b"\xff\xfe"), b"400"))
        for out, code in cases:
            self.assertTrue(out.startswith(b"HTTP/1.1 " + code), (code, out[:120]))
            self.assertNotIn(b"sports", out.split(b"\r\n\r\n", 1)[-1])
        self.assertEqual(d, hashlib.sha256(good).hexdigest())


if __name__ == "__main__":
    unittest.main()
