#!/usr/bin/env python3
"""Repo-open on an AWS host (contract universe-repo-open-v1 §13, lane A2h; wire pinned in
lib/ezil_host/repo_open.py; worker/src/aws-repo-open.ts is the Worker side).

Vectors: host constants, regexes, body rules, refusal statuses and the timeout chain against
docs/contracts/universe-repo-open-v1.vectors.json.
Assets: the pinned kernel and helper are byte-equal to worker/src/repo-open-assets.
Job: admission (single-use job ids, one slot, persisted replay guard) and the host steps. The
desktop is reached ONLY through the bounded_runc_exec seam (a recorder here): argv lists, data on
stdin, the host check before every exec, release on every outcome, the sanitizer.
BoundedExec: real cgroup v2 semantics with a stub runc that runs harmless argv only.
RepoOpenEdge: the real Edge + agent on loopback: digest, framing, gw1, status route.
RealKernel: the real kernel through the host job, inside a throwaway Docker container (no host
/run/ezil or /workspace is touched); skipped without root, Docker or the desktop image.
Run: python3 -m unittest -v test_repo_open_op   (from infra/host-agent/test)."""
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from ezil_host import agent as agentmod, desktop, edge as edge_mod, repo_open as ro, tunnel  # noqa: E402
from test_ice import scratch  # noqa: E402
import test_edge  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
VECTORS_PATH = os.path.join(REPO, "docs", "contracts", "universe-repo-open-v1.vectors.json")
WORKER_ASSETS = os.path.join(REPO, "worker", "src", "repo-open-assets")
REPEAT_RE = re.compile(r"\$\{repeat:(.):(\d+)\}")


def expand(value):
    if isinstance(value, str):
        return REPEAT_RE.sub(lambda m: m.group(1) * int(m.group(2)), value)
    if isinstance(value, list):
        return [expand(v) for v in value]
    if isinstance(value, dict):
        return {k: expand(v) for k, v in value.items()}
    return value


with open(VECTORS_PATH, encoding="utf-8") as _f:
    V = json.load(_f)

TOKEN = "egg_" + "0123456789abcdef" * 4
OTHER_GRANT = "egg_" + "f" * 64
JOB = "a" * 64
LEASE = {"generation": 1, "leaseEpoch": 2}
FOLDER = "/workspace/repos/acme/site"
OPEN_OK = {"ok": True, "state": "cloned", "folder": FOLDER, "openFolder": FOLDER, "pathNotFound": False,
           "branch": "main", "empty": False}


def iso(seconds):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def body(**over):
    """vectors workerRequest.base with a real expiry and this file's token, plus overrides."""
    b = expand(json.loads(json.dumps(V["workerRequest"]["base"])))
    b["grant"]["expiresAt"] = iso(900)
    b["grant"]["token"] = TOKEN
    grant = over.pop("grant", None)
    b.update(over)
    if grant:
        b["grant"].update(grant)
    return b


def relayed(job=JOB, **over):
    return {"jobId": job, **body(**over)}


def apply_mutation(base, mutation):
    b = json.loads(json.dumps(base))
    for k, v in mutation.get("set", {}).items():
        b[k] = v
    for k, v in mutation.get("setGrant", {}).items():
        b["grant"][k] = v
    if isinstance(b["grant"].get("expiresAt"), dict):
        b["grant"]["expiresAt"] = iso(b["grant"]["expiresAt"]["relativeSeconds"])
    return expand(b)


def line(obj):
    return (json.dumps(obj) + "\n").encode()


# ─────────────────────────────────────────────────────────────────────────── vectors
class Vectors(unittest.TestCase):
    def test_host_constants_equal_the_vectors(self):
        c, t = V["constants"], V["timeouts"]
        self.assertEqual(V["contractVersion"], "1.0.2")
        self.assertEqual(list(ro.RUN_DIRS), c["RUN_DIRS"])
        self.assertEqual(ro.KERNEL_PATH, c["KERNEL_PATH"])
        self.assertEqual(ro.HELPER_MODULE_PATH, c["HELPER_MODULE_PATH"])
        self.assertEqual(ro.STAGING_ROOT_NAME, c["STAGING_ROOT_NAME"])
        self.assertEqual(ro.WORKSPACE_ROOT, c["WORKSPACE_ROOT_DEFAULT"])
        self.assertEqual(ro.SNAPSHOT_LIMIT_BYTES, c["SNAPSHOT_LIMIT_BYTES"])
        self.assertEqual(ro.SNAPSHOT_MAX_ENTRIES, c["SNAPSHOT_MAX_ENTRIES"])
        self.assertEqual(ro.REPO_BUDGET_FRACTION, c["REPO_BUDGET_FRACTION"])
        self.assertEqual(ro.WORKER_REQUEST_MAX_BYTES, c["BODY_LIMITS_BYTES"]["workerRequest"])
        self.assertEqual(list(ro.REPO_OPEN_GIT_HOSTS), V["workerRequest"]["gitHostAllowList"])
        self.assertEqual(list(ro.BODY_KEYS), V["workerRequest"]["keys"])
        self.assertEqual(list(ro.GRANT_KEYS), V["workerRequest"]["grantKeys"])
        for name in ("WORKER_DEADLINE_MS", "PREPARE_WINDOW_MS", "PREPARE_RESERVE_MS", "COMMIT_EXEC_MAX_MS",
                     "COMMIT_MIN_REMAINING_MS", "WORKER_ACCEPT_EXPIRY_MAX_MS", "AWS_RELAY_POLL_MS"):
            self.assertEqual(getattr(ro, name), t[name], name)
        self.assertEqual(list(ro.KERNEL_ERROR_CODES), V["kernel"]["errorCodes"])
        self.assertEqual(list(ro.OPEN_KEYS), V["kernel"]["resultOpenKeys"])
        self.assertEqual(ro.DOWN_MARKERS, agentmod.DESKTOP_DOWN_MARKERS)
        self.assertEqual(ro.GRANT_SHAPE.pattern.decode(), V["regex"]["GRANT_RE"]["source"][1:-1])

    def test_the_host_budget_lands_inside_the_worker_deadline(self):
        t = V["timeouts"]
        self.assertLessEqual(ro.HOST_DEADLINE_MS + ro.RELEASE_GRACE_MS + t["AWS_RELAY_POLL_MS"] + ro.RELAY_SLACK_MS,
                             t["WORKER_DEADLINE_MS"])
        self.assertGreater(ro.HOST_DEADLINE_MS - t["PREPARE_RESERVE_MS"], 0)
        self.assertLessEqual(t["COMMIT_EXEC_MAX_MS"], t["COMMIT_MIN_REMAINING_MS"])
        self.assertGreaterEqual(ro.USED_ID_TTL, edge_mod.SKEW_PAST + edge_mod.SKEW_FUTURE + 1,
                                "a used job id outlives every gw1 header that could replay it")

    def test_regex_cases(self):
        checks = {"UUID_RE": lambda s: bool(ro.UUID_RE.match(s)), "HANDLE_RE": lambda s: bool(ro.HANDLE_RE.match(s)),
                  "NAME_RE": ro.valid_name, "BRANCH_RE": ro.valid_branch, "GRANT_RE": lambda s: bool(ro.GRANT_RE.match(s)),
                  "PATH_SEGMENT_RE": lambda s: bool(ro.PATH_SEGMENT_RE.match(s))}
        for name, ok in checks.items():
            cases = expand(V["regexCases"][name])
            for s in cases["valid"]:
                self.assertTrue(ok(s), (name, s))
            for s in cases["invalid"]:
                self.assertFalse(ok(s), (name, s))

    def test_link_path_cases(self):
        cases = expand(V["link"]["path"])
        for s in cases["valid"]:
            self.assertIsNone(ro.path_problem(s), s)
        for decoded, _raw, why in cases["invalid"]:
            if why == "encoded_separator":
                continue            # a URL-decoding rule: the relay carries JSON strings, already decoded
            self.assertEqual(ro.path_problem(decoded), why, decoded)

    def test_refusal_statuses_equal_the_worker_table(self):
        table = {code: row["status"] for row in V["errorTable"]["workerResponses"]["refusals"] for code in row["error"]}
        for code, status in ro.REPO_OPEN_STATUS.items():
            self.assertEqual(table[code], status, code)
        self.assertEqual(set(ro.KERNEL_ERROR_CODES) | {"runtime_not_running", "workspace_not_ready"},
                         set(ro.REPO_OPEN_STATUS))

    def test_worker_ok_cases_through_the_host_validators(self):
        for case in V["errorTable"]["workerResponses"]["okCases"]:
            b = case["body"]
            if case["op"] == "open":
                ans = ro.open_answer(dict(b), b.get("folder", FOLDER))
            else:
                ans = ro.refresh_answer(dict(b))
            self.assertEqual(ans["status"] == 200, case["valid"], case)
            if case["valid"]:
                self.assertEqual(ans["body"], b)

    def test_body_mutations(self):
        base = V["workerRequest"]["base"]
        for mutation in V["workerRequest"]["validMutations"]:
            raw = {"jobId": JOB, **apply_mutation(base, mutation)}
            job, parsed = ro.parse_relay(raw, int(time.time() * 1000))    # "now" read after the expiry
            self.assertEqual(job, JOB)
            self.assertEqual(set(parsed), set(ro.BODY_KEYS))
        for mutation in V["workerRequest"]["invalidMutations"]:
            raw = {"jobId": JOB, **apply_mutation(base, mutation)}
            with self.assertRaises(ValueError, msg=mutation["why"]):
                ro.parse_relay(raw, int(time.time() * 1000))

    def test_relay_shape_refusals(self):
        now = int(time.time() * 1000)
        ok = relayed()
        ro.parse_relay(ok, now)
        bad = [{**ok, "jobId": "A" * 64}, {**ok, "jobId": "a" * 63}, {k: v for k, v in ok.items() if k != "jobId"},
               {**ok, "extra": 1}, {**ok, "v": True}, {**ok, "v": 1.0}, {**ok, "grant": {**ok["grant"], "extra": 1}},
               {**ok, "grant": {**ok["grant"], "expiresAt": "2026-02-30T00:00:00Z"}},
               {**ok, "grant": {**ok["grant"], "expiresAt": iso(900).replace("Z", "+00:00")}},
               {**ok, "handle": "acme\n"}, {**ok, "path": "a\nb"}, "not a dict", None, []]
        for raw in bad:
            with self.assertRaises(ValueError, msg=repr(raw)[:80]):
                ro.parse_relay(raw, now)

    def test_a_worst_case_relay_body_fits_the_edge_limit(self):
        worst = relayed(handle="h" * 39, name="n" * 100, defaultBranch="b" * 244, path="p" * 255)
        data = json.dumps(worst, separators=(",", ":")).encode()
        ro.parse_relay(worst, int(time.time() * 1000))
        self.assertLessEqual(len(data), ro.WORKER_REQUEST_MAX_BYTES + len(',"jobId":""') + 64)
        self.assertLess(len(data), edge_mod.MAX_REPO_OPEN_BODY)
        self.assertEqual(edge_mod.MAX_REPO_OPEN_BODY, ro.RELAY_MAX_BYTES)


# ─────────────────────────────────────────────────────────────────────────── assets
class Assets(unittest.TestCase):
    def test_the_pinned_assets_are_byte_equal_to_the_worker_assets(self):
        loaded = ro.load_assets()
        self.assertEqual(set(loaded), {"ezil-repo-open.mjs", "ezil-git-grant.mjs"})
        for name, data in loaded.items():
            with open(os.path.join(WORKER_ASSETS, name), "rb") as f:
                self.assertEqual(data, f.read(), name)
            self.assertEqual(hashlib.sha256(data).hexdigest(), ro.REPO_OPEN_ASSETS[name])
        self.assertEqual(sorted(os.listdir(ro.ASSET_DIR)), sorted(ro.REPO_OPEN_ASSETS))

    def test_the_kernel_has_all_four_phases_and_the_host_uses_each(self):
        kernel = ro.load_assets()["ezil-repo-open.mjs"].decode()
        self.assertIn("export const PHASES = ['prepare', 'commit', 'refresh', 'release'];", kernel)
        self.assertEqual(sorted(V["kernel"]["phases"]), ["commit", "prepare", "refresh", "release"])
        with open(ro.__file__, encoding="utf-8") as f:
            src = f.read()
        for phase in ("prepare", "commit", "refresh", "release"):
            self.assertIn(f'self.kernel("{phase}"', src)

    def test_a_tampered_or_missing_asset_is_refused(self):
        d, _ = scratch(self)
        assets = os.path.join(d, "assets")
        os.mkdir(assets)
        for name in ro.REPO_OPEN_ASSETS:
            with open(os.path.join(ro.ASSET_DIR, name), "rb") as src, open(os.path.join(assets, name), "wb") as dst:
                dst.write(src.read())
        ro.load_assets(assets)
        with open(os.path.join(assets, "ezil-git-grant.mjs"), "ab") as f:
            f.write(b"\n")
        with self.assertRaises(ro.AssetError):
            ro.load_assets(assets)
        os.unlink(os.path.join(assets, "ezil-git-grant.mjs"))
        os.symlink(os.path.join(ro.ASSET_DIR, "ezil-git-grant.mjs"), os.path.join(assets, "ezil-git-grant.mjs"))
        with self.assertRaises(ro.AssetError):
            ro.load_assets(assets)          # a symlink is not the pinned regular file
        with self.assertRaises(ro.AssetError):
            ro.load_assets(os.path.join(d, "nowhere"))


# ─────────────────────────────────────────────────────────────────────────── sanitizer
class DesktopSpec(unittest.TestCase):
    def test_the_desktop_gives_the_kernel_an_exec_tmpfs_run_and_the_workspace_root(self):
        """Contract §13: /run is the desktop's own tmpfs (desktop.py:585) and must allow the helper
        wrapper to execute; /workspace (never /workspaces) is the data volume (desktop.py:586)."""
        _, cfg = scratch(self)
        bundle = desktop.build_spec(cfg, {"generation": 1, "leaseEpoch": 2})
        with open(os.path.join(bundle, "config.json")) as f:
            spec = json.load(f)
        mounts = {m["destination"]: m for m in spec["mounts"]}
        self.assertEqual(mounts["/run"]["type"], "tmpfs")
        self.assertNotIn("noexec", mounts["/run"]["options"])
        self.assertEqual(mounts["/workspace"]["source"], os.path.join(cfg.dataMount, "workspace"))
        self.assertNotIn("/workspaces", mounts)
        self.assertIn("EZIL_WORKSPACE_ROOT=/workspace", spec["process"]["env"])


class Sanitizer(unittest.TestCase):
    def test_kernel_answers_reduce_to_the_contract(self):
        self.assertEqual(ro.open_answer(dict(OPEN_OK), FOLDER), {"status": 200, "body": OPEN_OK})
        self.assertEqual(ro.open_answer({"ok": False, "errorCode": "folder_conflict"}, FOLDER),
                         {"status": 409, "body": {"ok": False, "error": "folder_conflict"}})
        failed = ro.refusal("workspace_failed")
        self.assertEqual(failed, {"status": 500, "body": {"ok": False, "error": "workspace_failed"}})
        for bad in ({**OPEN_OK, "extra": 1}, {**OPEN_OK, "folder": "/workspace/repos/other/x"},
                    {**OPEN_OK, "openFolder": FOLDER + "x"}, {**OPEN_OK, "openFolder": FOLDER + "/a\nb"},
                    {**OPEN_OK, "branch": "a..b"}, {**OPEN_OK, "empty": 0}, {**OPEN_OK, "state": "refreshed"},
                    {"ok": False, "errorCode": "runtime_not_running"}, {"ok": False, "errorCode": "x", "detail": 1}, None):
            self.assertEqual(ro.open_answer(bad, FOLDER), failed, str(bad)[:60])
        self.assertEqual(ro.refresh_answer({"ok": True, "state": "refreshed", "x": 1}), failed)

    def test_last_json_line(self):
        self.assertEqual(ro.last_json_line(b"noise\n" + line(OPEN_OK) + b"\n\n"), OPEN_OK)
        for bad in (b"", b"\xff\xfe", b"[1]\n", b'{"a":1,"a":2}\n', b'{"a":NaN}\n'):
            self.assertIsNone(ro.last_json_line(bad), bad)

    def test_leak_detection(self):
        self.assertTrue(ro.leaked([b"x", OTHER_GRANT.encode()], TOKEN))
        self.assertTrue(ro.leaked([TOKEN.encode()], TOKEN))
        self.assertFalse(ro.leaked([line({**OPEN_OK, "folder": "/workspace/repos/acme/egg_tart"})], TOKEN),
                         "a repository named egg_x is not a credential")


# ─────────────────────────────────────────────────────────────────────────── the job
class FakeDesktop:
    """Stands in for bounded_runc_exec: records every exec (argv, stdin) and answers kernel
    phases from `outputs`. `before(argv)` runs ahead of an exec (e.g. a fence landing)."""

    def __init__(self, outputs=None, fail=None, before=None):
        self.outputs = {"prepare": line(OPEN_OK), "commit": line(OPEN_OK),
                        "refresh": line({"ok": True, "state": "refreshed"}), "release": line({"ok": True})}
        self.outputs.update(outputs or {})
        self.fail, self.before = fail, before
        self.calls, self.deadlines, self.tags = [], [], set()

    def exec_(self, cfg, argv, deadline, data=None, limit=ro.STDOUT_MAX, tag=None, cgroup_root=None, clock=None):
        assert isinstance(argv, list) and ro.TAG_RE.match(tag) and cgroup_root == "/fake/cgroup"
        if self.before:
            self.before(argv)
        self.calls.append((list(argv), data))
        self.deadlines.append(deadline)
        self.tags.add(tag)
        if self.fail:
            out = self.fail(argv)
            if isinstance(out, Exception):
                raise out
            if out is not None:
                return out
        if argv[:2] == ["node", ro.KERNEL_PATH]:
            out = self.outputs[argv[2]]
            if isinstance(out, Exception):
                raise out
            return (0 if b'"ok": true' in out else 2), out
        return 0, b""

    def argvs(self):
        return [argv for argv, _ in self.calls]

    def phases(self):
        return [argv[2] for argv in self.argvs() if argv[:2] == ["node", ro.KERNEL_PATH]]

    def writes(self):
        return {argv[4]: data for argv, data in self.calls if argv[:3] == ["/bin/sh", "-c", ro.WRITE_PROGRAM]}


class JobBase(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.logs = []
        self.a = agentmod.Agent(self.cfg, dict(LEASE), log=self.logs.append)
        self.runner = self.a.repo_open
        self.runner.busy = False          # as after startup() confirmed a clear host
        self.seq = 0
        self.stamp()
        self.probe = ("running", 4242)
        for target, value in (("reap_cgroups", mock.Mock(return_value=0)),
                              ("desktop_probe", lambda cfg, timeout=10.0: self._probe()),
                              ("cgroup_root_of", lambda pid: "/fake/cgroup")):
            p = mock.patch.object(ro, target, value)
            p.start()
            self.addCleanup(p.stop)

    def _probe(self):
        if self.probe is None:
            raise ro.ContainerAbsent()
        return self.probe

    def stamp(self, **over):
        with open(os.path.join(self.cfg.runDir, "guard-ok"), "w") as f:
            json.dump({"computerId": "x", "generation": 1, "leaseEpoch": 2, **over}, f)

    def send(self, op, **fields):
        self.seq += 1
        msg = {"op": op, "leaseEpoch": 2, "ts": time.time(), "seq": self.seq, **fields}
        msg["mac"] = agentmod.sign(b"k" * 32, msg)
        return self.a.handle(json.dumps(msg))

    def wait_done(self, job=JOB):
        for _ in range(500):
            st = self.send("repo_open_status", jobId=job)
            if st.get("state") == "done":
                return st
            time.sleep(0.01)
        self.fail("the job never finished")

    def wait_idle(self):
        for _ in range(500):
            if not self.runner.busy:
                return
            time.sleep(0.01)
        self.fail("the host never became idle")

    def run_job(self, fake, job=JOB, **over):
        with mock.patch.object(ro, "bounded_runc_exec", fake.exec_):
            started = self.send("repo_open", request=relayed(job, **over))
            self.assertEqual(started, {"ok": True, "state": "running"})
            st = self.wait_done(job)
            self.wait_idle()
        return st["result"]

    def assert_no_secret_anywhere(self, fake, *replies):
        for argv in fake.argvs():
            for part in argv:
                self.assertNotIn(TOKEN, part)
                self.assertNotIn("acme", part, "request data never reaches argv")
        for reply in replies:
            self.assertNotIn(TOKEN, json.dumps(reply))
        self.assertNotIn(TOKEN, "\n".join(self.logs))
        for name in os.listdir(self.cfg.runDir):
            p = os.path.join(self.cfg.runDir, name)
            if os.path.isfile(p):
                with open(p, "rb") as f:
                    self.assertNotIn(TOKEN.encode(), f.read(), name)


class Job(JobBase):
    def test_open_runs_every_step_with_argv_only_and_returns_the_kernel_answer(self):
        fake = FakeDesktop()
        admitted_wall = int(time.time() * 1000)
        admitted_mono = time.monotonic()
        result = self.run_job(fake)
        self.assertEqual(result, {"status": 200, "body": OPEN_OK})
        argvs = fake.argvs()
        self.assertEqual(argvs[0], ["install", "-d", "-m", "0700", *V["constants"]["RUN_DIRS"]])
        writes = [a for a in argvs if a[:3] == ["/bin/sh", "-c", ro.WRITE_PROGRAM]]
        u = re.fullmatch(r"/run/ezil/bin/\.ezil-repo-open\.([0-9a-f-]{36})\.mjs", argvs[1][4]).group(1)
        request = f"/run/ezil/requests/{u}.json"
        incoming = f"/run/ezil/git/incoming/{u}.json"
        self.assertEqual([a[4] for a in writes], [f"/run/ezil/bin/.ezil-repo-open.{u}.mjs",
                                                   f"/run/ezil/bin/.ezil-git-grant.{u}.mjs", incoming, request,
                                                   request, request])
        self.assertEqual(argvs[5], ["/bin/sh", "-c", ro.INSTALL_PROGRAM, "sh", f"/run/ezil/bin/.ezil-repo-open.{u}.mjs",
                                    f"/run/ezil/bin/.ezil-git-grant.{u}.mjs", ro.KERNEL_PATH, ro.HELPER_MODULE_PATH,
                                    incoming, request])
        self.assertEqual(argvs[6], ["node", ro.KERNEL_PATH, "prepare", request])
        self.assertEqual(argvs[8], ["node", ro.KERNEL_PATH, "commit", request])
        self.assertEqual(argvs[10], ["node", ro.KERNEL_PATH, "release", request])
        self.assertEqual(fake.phases(), ["prepare", "commit", "release"])
        self.assertEqual(len(argvs), 11, "no fallback after a successful release")
        # stdin: the pinned assets, the grant file (only place the token travels), the requests
        data = [d for a, d in fake.calls if a[:3] == ["/bin/sh", "-c", ro.WRITE_PROGRAM]]
        assets = ro.load_assets()
        self.assertEqual(data[0], assets["ezil-repo-open.mjs"])
        self.assertEqual(data[1], assets["ezil-git-grant.mjs"])
        grant = json.loads(data[2])
        self.assertEqual(list(grant), V["grantFile"]["keys"])
        self.assertEqual(grant, {"v": 1, "protocol": "https", "host": "git-preview.ezil.work", "path": "acme/site.git",
                                 "username": "ezil", "password": TOKEN, "expiresAt": grant["expiresAt"], "scope": "write"})
        phases = []
        for raw in data[3:]:
            self.assertNotIn(TOKEN.encode(), raw)
            req = json.loads(raw)
            self.assertEqual(list(req), V["kernel"]["requestKeys"])
            phases.append(req["phase"])
            self.assertEqual(req["uuid"], u)
            self.assertEqual(req["inflight"], [u])
            self.assertEqual(req["root"], "/workspace")
            self.assertEqual(req["staging"], f"/workspace/.ezil-staging/{u}")
            self.assertEqual(req["incoming"], incoming)
            self.assertEqual(req["budget"], {"limitBytes": 536870912, "maxEntries": 100000, "fraction": 0.8})
            self.assertAlmostEqual(req["deadlineMs"], admitted_wall + ro.HOST_DEADLINE_MS, delta=1000)
            for k in ("repositoryId", "handle", "name", "gitHost", "defaultBranch", "path", "op"):
                self.assertEqual(req[k], body()[k])
        self.assertEqual(phases, ["prepare", "commit", "release"])
        # one absolute deadline: prepare ends by deadline - PREPARE_RESERVE; nothing runs past it
        prepare_deadline = fake.deadlines[6]
        self.assertLessEqual(prepare_deadline, admitted_mono + (ro.HOST_DEADLINE_MS - ro.PREPARE_RESERVE_MS) / 1000 + 1)
        self.assertLessEqual(max(fake.deadlines[:10]), admitted_mono + ro.HOST_DEADLINE_MS / 1000 + 1)
        self.assertEqual(fake.tags, {JOB[:16]})
        self.assert_no_secret_anywhere(fake, result)
        self.assertIn("repo_open op=open outcome=ok", self.logs)

    def test_other_open_states_and_a_path_pass_through(self):
        for state, extra in (("existing", {}), ("initialized_empty", {"empty": True}),
                             ("cloned", {"openFolder": FOLDER + "/src", "path": "src"})):
            self.setUp()
            path = extra.pop("path", None)
            answer = {**OPEN_OK, "state": state, **extra}
            fake = FakeDesktop({"commit": line(answer)})
            result = self.run_job(fake, path=path)
            self.assertEqual(result, {"status": 200, "body": answer})

    def test_refresh_installs_and_releases_without_prepare_or_commit(self):
        fake = FakeDesktop()
        result = self.run_job(fake, op="refresh")
        self.assertEqual(result, {"status": 200, "body": {"ok": True, "state": "refreshed"}})
        self.assertEqual(fake.phases(), ["refresh", "release"])
        reqs = [json.loads(d) for d in [d for a, d in fake.calls if a[:3] == ["/bin/sh", "-c", ro.WRITE_PROGRAM]][3:]]
        self.assertEqual([r["phase"] for r in reqs], ["refresh", "release"])
        self.assertTrue(all(r["op"] == "refresh" for r in reqs))
        self.assert_no_secret_anywhere(fake, result)

    def test_kernel_refusals_pass_through_with_their_status(self):
        for phase, code, status in (("prepare", "folder_conflict", 409), ("prepare", "network_unavailable", 502),
                                    ("prepare", "repository_too_large", 409), ("commit", "workspace_busy", 409),
                                    ("prepare", "git_auth_rejected", 502)):
            self.setUp()
            fake = FakeDesktop({phase: line({"ok": False, "errorCode": code})})
            self.assertEqual(self.run_job(fake), {"status": status, "body": {"ok": False, "error": code}})
            self.assertEqual(fake.phases()[-1], "release", "release runs after a kernel refusal")
        self.setUp()
        fake = FakeDesktop({"prepare": line({"ok": False, "errorCode": "runtime_not_running"})})
        self.assertEqual(self.run_job(fake), ro.refusal("workspace_failed"), "codes outside the kernel list")

    # ------------------------------------------------ never exec into a desktop that is not running
    def test_a_desktop_that_is_not_running_gets_no_exec(self):
        for probe in (None, ("stopped", 4242), ("created", 4242), ("paused", 4242)):
            self.setUp()
            self.probe = probe
            fake = FakeDesktop()
            self.assertEqual(self.run_job(fake), ro.refusal("runtime_not_running"))
            self.assertEqual(fake.calls, [])

    def test_a_pending_stop_fence_restart_or_export_gets_no_exec(self):
        def stop_request():
            self.a.stop_request = {"kind": "stop", "warn": 0, "reason": "x"}

        def restart():
            self.a.restart_request = True

        def restarting():
            self.a.restart_in_progress = True

        def marker(name):
            return lambda: open(os.path.join(self.cfg.runDir, name), "w").close()

        def fence():
            tunnel.fence(self.cfg, "test")

        def exporting():
            p = mock.patch.object(ro.export, "pending", return_value=True)
            p.start()
            return p.stop

        for setup in (stop_request, restart, restarting, marker(desktop.STOPPING), marker("shutdown-pending"),
                      marker(desktop.EXPORT_QUIESCE), fence, exporting):
            self.setUp()
            undo = setup()
            fake = FakeDesktop()
            self.assertEqual(self.run_job(fake), ro.refusal("runtime_not_running"), setup.__name__)
            self.assertEqual(fake.calls, [], setup.__name__)
            if callable(undo):
                undo()

    def test_a_volume_not_guarded_for_this_epoch_is_not_ready(self):
        for stamp in ({"leaseEpoch": 3}, {"generation": 2}, {"leaseEpoch": True, "generation": 1}, None):
            self.setUp()
            if stamp is None:
                os.unlink(os.path.join(self.cfg.runDir, "guard-ok"))
            else:
                self.stamp(**stamp)
            fake = FakeDesktop()
            self.assertEqual(self.run_job(fake), ro.refusal("workspace_not_ready"))
            self.assertEqual(fake.calls, [])

    def test_a_fence_landing_during_prepare_stops_every_later_exec(self):
        """The epoch fence, re-checked before every exec: nothing (not even release) runs once the
        tunnel is fenced or the guard stamp is gone, and the answer is runtime_not_running."""
        for land in (lambda: tunnel.fence(self.cfg, "fence:new-epoch"),
                     lambda: self.stamp(leaseEpoch=3),
                     lambda: os.unlink(os.path.join(self.cfg.runDir, "guard-ok"))):
            self.setUp()

            def before(argv, land=land):
                if argv[:3] == ["node", ro.KERNEL_PATH, "prepare"]:
                    land()
            fake = FakeDesktop(before=before)
            self.assertEqual(self.run_job(fake), ro.refusal("runtime_not_running"))
            self.assertEqual(fake.phases(), ["prepare"], "no commit and no release after the fence")
            self.assertEqual(fake.argvs()[-1][:3], ["node", ro.KERNEL_PATH, "prepare"])

    def test_a_desktop_restarted_or_stopped_during_prepare_gets_no_further_exec(self):
        for after in (("running", 9999), ("stopped", 4242), None):
            self.setUp()

            def before(argv, after=after):
                if argv[:3] == ["node", ro.KERNEL_PATH, "prepare"]:
                    self.probe = after
            fake = FakeDesktop(before=before)
            self.assertEqual(self.run_job(fake), ro.refusal("runtime_not_running"))
            self.assertEqual(fake.phases(), ["prepare"])

    def test_a_stop_during_setup_skips_everything_after(self):
        def before(argv):
            if argv[:3] == ["/bin/sh", "-c", ro.WRITE_PROGRAM] and argv[4].startswith("/run/ezil/git/incoming/"):
                self.a.stop_request = {"kind": "stop", "warn": 0, "reason": "x"}
        fake = FakeDesktop(before=before)
        self.assertEqual(self.run_job(fake), ro.refusal("runtime_not_running"))
        self.assertEqual(len(fake.calls), 4, "the incoming write was the last exec")

    # ------------------------------------------------ time, failures, release
    def test_prepare_timeout_is_busy_and_release_still_runs(self):
        fake = FakeDesktop({"prepare": ro.ExecLimit(True, b"")})
        self.assertEqual(self.run_job(fake), ro.refusal("workspace_busy"))
        self.assertEqual(fake.phases(), ["prepare", "release"])

    def test_commit_timeout_is_busy(self):
        fake = FakeDesktop({"commit": ro.ExecLimit(True, b"")})
        self.assertEqual(self.run_job(fake), ro.refusal("workspace_busy"))
        self.assertEqual(fake.phases(), ["prepare", "commit", "release"])

    def test_too_little_time_left_for_commit_is_busy_without_a_commit_exec(self):
        with mock.patch.object(ro, "COMMIT_MIN_REMAINING_MS", 10 ** 9):
            fake = FakeDesktop()
            self.assertEqual(self.run_job(fake), ro.refusal("workspace_busy"))
        self.assertEqual(fake.phases(), ["prepare", "release"])

    def test_no_prepare_window_left_is_busy_without_a_prepare_exec(self):
        with mock.patch.object(ro, "PREPARE_RESERVE_MS", 10 ** 9):
            fake = FakeDesktop()
            self.assertEqual(self.run_job(fake), ro.refusal("workspace_busy"))
        self.assertEqual(fake.phases(), ["release"])

    def test_setup_failures_fail_and_release_falls_back(self):
        fake = FakeDesktop(fail=lambda argv: (1, b"") if argv[:3] == ["/bin/sh", "-c", ro.INSTALL_PROGRAM] else None)
        self.assertEqual(self.run_job(fake), ro.refusal("workspace_failed"))
        self.assertEqual(fake.phases(), [], "no kernel phase after a failed install")
        last = fake.argvs()[-1]
        self.assertEqual(last[:4], ["/bin/sh", "-c", ro.FALLBACK_PROGRAM, "sh"])
        u = re.fullmatch(r"/workspace/\.ezil-staging/([0-9a-f-]{36})", last[4]).group(1)
        self.assertEqual(last[5:], [f"/run/ezil/requests/{u}.json", f"/run/ezil/git/incoming/{u}.json",
                                    f"/run/ezil/bin/.ezil-repo-open.{u}.mjs", f"/run/ezil/bin/.ezil-git-grant.{u}.mjs"])

    def test_a_failed_first_setup_exec_writes_nothing_and_releases_nothing(self):
        fake = FakeDesktop(fail=lambda argv: (1, b"") if argv[0] == "install" else None)
        self.assertEqual(self.run_job(fake), ro.refusal("workspace_failed"))
        self.assertEqual(len(fake.calls), 1)

    def test_a_failed_release_falls_back_to_removing_this_requests_files(self):
        fake = FakeDesktop({"release": line({"ok": False, "errorCode": "workspace_failed"})})
        self.assertEqual(self.run_job(fake), {"status": 200, "body": OPEN_OK})
        self.assertEqual(fake.argvs()[-1][:3], ["/bin/sh", "-c", ro.FALLBACK_PROGRAM])

    def test_output_overflow_or_garbage_is_workspace_failed(self):
        for out in (ro.ExecLimit(False, b"x" * 100), b"not json\n", b"[1]\n"):
            self.setUp()
            fake = FakeDesktop({"prepare": out})
            self.assertEqual(self.run_job(fake), ro.refusal("workspace_failed"))

    def test_an_exec_that_could_not_start_is_workspace_failed(self):
        fake = FakeDesktop(fail=lambda argv: OSError("desktop_cgroup_unavailable") if argv[:2] == ["node", ro.KERNEL_PATH]
                           and argv[2] == "prepare" else None)
        self.assertEqual(self.run_job(fake), ro.refusal("workspace_failed"))

    def test_a_tampered_asset_fails_before_any_exec(self):
        with mock.patch.object(ro, "REPO_OPEN_ASSETS", {**ro.REPO_OPEN_ASSETS, "ezil-repo-open.mjs": "0" * 64}):
            fake = FakeDesktop()
            self.assertEqual(self.run_job(fake), ro.refusal("workspace_failed"))
        self.assertEqual(fake.calls, [])

    # ------------------------------------------------ the sanitizer
    def test_grant_shaped_output_anywhere_is_workspace_failed(self):
        cases = [
            FakeDesktop({"prepare": OTHER_GRANT.encode() + b"\n" + line(OPEN_OK)}),
            FakeDesktop({"commit": line({**OPEN_OK, "branch": TOKEN})}),       # a valid okOpen carrying the grant
            FakeDesktop(fail=lambda argv: (0, TOKEN.encode()) if argv[:3] == ["/bin/sh", "-c", ro.WRITE_PROGRAM]
                        and argv[4].startswith("/run/ezil/git/incoming/") else None),   # a replaced `cat` echoing
            FakeDesktop({"release": line({"ok": True}) + OTHER_GRANT.encode()}),
            FakeDesktop({"refresh": TOKEN.encode() + b"\n" + line({"ok": True, "state": "refreshed"})}),
            FakeDesktop({"prepare": ro.ExecLimit(True, TOKEN.encode())}),
        ]
        for i, fake in enumerate(cases):
            self.setUp()
            result = self.run_job(fake, op="refresh" if i == 4 else "open")
            self.assertEqual(result, ro.refusal("workspace_failed"), i)
            self.assert_no_secret_anywhere(fake, result)

    # ------------------------------------------------ admission
    def test_one_job_at_a_time_and_job_ids_are_single_use(self):
        gate = threading.Event()
        fake = FakeDesktop(before=lambda argv: gate.wait(5) if argv[:3] == ["node", ro.KERNEL_PATH, "prepare"] else None)
        with mock.patch.object(ro, "bounded_runc_exec", fake.exec_):
            self.assertEqual(self.send("repo_open", request=relayed()), {"ok": True, "state": "running"})
            self.assertEqual(self.send("repo_open", request=relayed("b" * 64)), {"ok": False, "error": "workspace_busy"})
            self.assertEqual(self.send("repo_open", request=relayed()), {"ok": False, "error": "job_replayed"})
            self.assertEqual(self.send("repo_open_status", jobId=JOB), {"ok": True, "state": "running"})
            gate.set()
            done = self.wait_done()
            self.wait_idle()
            self.assertEqual(self.send("repo_open", request=relayed()), {"ok": False, "error": "job_replayed"})
            self.assertEqual(self.send("repo_open_status", jobId=JOB), done, "a replay never re-runs; status stays")
        self.assertEqual(fake.phases(), ["prepare", "commit", "release"])
        self.assertNotIn("b" * 64, self.runner.jobs)

    def test_used_job_ids_survive_an_agent_restart_and_expire_after_the_ttl(self):
        self.run_job(FakeDesktop())
        with open(os.path.join(self.cfg.runDir, ro.USED_IDS_FILE)) as f:
            record = json.load(f)
        self.assertEqual(set(record["ids"]), {JOB})
        self.assertEqual(oct(os.stat(os.path.join(self.cfg.runDir, ro.USED_IDS_FILE)).st_mode & 0o777), "0o600")
        restarted = agentmod.Agent(self.cfg, dict(LEASE), log=self.logs.append)
        restarted.repo_open.busy = False
        self.a = restarted
        self.runner = restarted.repo_open
        self.assertEqual(self.send("repo_open", request=relayed()), {"ok": False, "error": "job_replayed"})
        self.assertEqual(self.send("repo_open_status", jobId=JOB), {"ok": False, "error": "job_unknown"})
        later = time.time() + ro.USED_ID_TTL + 1
        with mock.patch.object(self.runner, "clock", lambda: later):
            self.assertNotEqual(self.runner.start(JOB, body()).get("error"), "job_replayed")
        self.wait_idle()

    def test_an_unreadable_used_id_record_refuses_starts_until_the_ttl(self):
        with open(os.path.join(self.cfg.runDir, ro.USED_IDS_FILE), "w") as f:
            f.write("{not json")
        a = agentmod.Agent(self.cfg, dict(LEASE), log=self.logs.append)
        a.repo_open.busy = False
        self.assertEqual(a.repo_open.start(JOB, body()), {"ok": False, "error": "workspace_busy"})
        with mock.patch.object(a.repo_open, "clock", lambda: time.time() + ro.USED_ID_TTL + 1), \
                mock.patch.object(ro, "bounded_runc_exec", FakeDesktop().exec_):
            self.assertEqual(a.repo_open.start(JOB, body()), {"ok": True, "state": "running"})
            for _ in range(500):
                if not a.repo_open.busy:
                    break
                time.sleep(0.01)

    def test_another_epochs_used_ids_do_not_apply(self):
        with open(os.path.join(self.cfg.runDir, ro.USED_IDS_FILE), "w") as f:
            json.dump({"v": 1, "leaseEpoch": 1, "ids": {JOB: time.time()}}, f)
        a = agentmod.Agent(self.cfg, dict(LEASE), log=self.logs.append)
        self.assertEqual(a.repo_open.used, {})
        self.assertEqual(a.repo_open.quiet_until, 0.0)

    def test_an_unwritable_used_id_record_refuses_the_start(self):
        with mock.patch.object(ro.desktop, "_write_private_atomic", side_effect=OSError("ENOSPC")):
            self.assertEqual(self.send("repo_open", request=relayed()), {"ok": False, "error": "workspace_busy"})
        self.assertEqual(self.runner.jobs, {})
        self.assertFalse(self.runner.busy)

    def test_the_slot_is_busy_from_agent_start_until_the_startup_reap_is_clear(self):
        a = agentmod.Agent(self.cfg, dict(LEASE), log=self.logs.append)
        self.assertTrue(a.repo_open.busy)
        self.assertEqual(a.repo_open.start(JOB, body()), {"ok": False, "error": "workspace_busy"})
        results = iter([2, 1, 0])
        with mock.patch.object(ro, "reap_cgroups", side_effect=lambda cfg: next(results)), \
                mock.patch.object(ro, "REAP_RETRY_SECONDS", 0.01):
            a.repo_open.startup()
        self.assertFalse(a.repo_open.busy)

    def test_a_message_for_another_epoch_is_refused(self):
        self.seq += 1
        msg = {"op": "repo_open", "leaseEpoch": 3, "ts": time.time(), "seq": self.seq, "request": relayed()}
        msg["mac"] = agentmod.sign(b"k" * 32, msg)
        self.assertEqual(self.a.handle(json.dumps(msg)), {"ok": False, "error": "wrong_epoch"})
        self.assertEqual(self.runner.jobs, {})

    def test_invalid_messages_are_refused_before_the_seq_is_used(self):
        last = self.a.last_seq
        for fields in ({"request": relayed(name="../x")}, {"request": relayed(), "extra": 1}, {"request": "x"},
                       {"request": relayed(grant={"expiresAt": iso(-1)})}, {}):
            self.assertEqual(self.send("repo_open", **fields), {"ok": False, "error": "repo_open_invalid"})
        for fields in ({"jobId": "nope"}, {"jobId": JOB.upper()}, {"jobId": JOB, "x": 1}, {}):
            self.assertEqual(self.send("repo_open_status", **fields), {"ok": False, "error": "repo_open_invalid"})
        self.assertEqual(self.a.last_seq, last)
        self.assertEqual(self.runner.jobs, {})
        self.assertEqual(self.send("repo_open_status", jobId="d" * 64), {"ok": False, "error": "job_unknown"})

    def test_finished_results_expire_and_never_block_admission(self):
        now = time.time()
        self.runner.jobs = {f"{i:064x}": {"state": "done", "result": {}, "at": now - i} for i in range(ro.JOBS_MAX)}
        self.run_job(FakeDesktop())
        self.assertEqual(len(self.runner.jobs), ro.JOBS_MAX)
        self.runner.jobs = {"c" * 64: {"state": "done", "result": {}, "at": time.time() - ro.JOB_TTL - 1}}
        self.assertEqual(self.send("repo_open_status", jobId="c" * 64), {"ok": False, "error": "job_unknown"})

    def test_a_thread_that_cannot_start_leaves_no_reservation(self):
        with mock.patch.object(ro.threading.Thread, "start", side_effect=RuntimeError("can't start new thread")):
            self.assertEqual(self.send("repo_open", request=relayed()), {"ok": False, "error": "workspace_failed"})
        self.assertEqual(self.runner.jobs, {})
        self.assertFalse(self.runner.busy)
        self.assertEqual(self.send("repo_open", request=relayed()), {"ok": False, "error": "job_replayed"})

    def test_a_failing_logger_never_leaves_the_job_running_or_the_slot_busy(self):
        def broken(_line):
            raise BrokenPipeError()
        self.a.log = broken
        self.run_job(FakeDesktop())
        self.assertFalse(self.runner.busy)

    def test_unconfirmed_cleanup_publishes_the_failure_and_stays_busy_until_reaped(self):
        remaining = {"n": 3, "calls": 0}

        def reap(cfg):
            remaining["calls"] += 1
            if remaining["calls"] == 1:
                return 0                       # the pre-job clear: nothing left from before
            remaining["n"] = max(0, remaining["n"] - 1)
            return remaining["n"]
        fake = FakeDesktop({"prepare": ro.CleanupPending()})
        with mock.patch.object(ro, "reap_cgroups", side_effect=reap), mock.patch.object(ro, "REAP_RETRY_SECONDS", 0.01):
            result = self.run_job(fake)
        self.assertEqual(result, ro.refusal("workspace_failed"))
        self.assertEqual(remaining["n"], 0, "idle only once the reaper confirmed a clear host")
        self.assertIn("repo_open op=open outcome=cleanup_pending", self.logs)

    def test_leftovers_that_cannot_be_cleared_refuse_new_work(self):
        fake = FakeDesktop()
        clears = iter([False, True])
        with mock.patch.object(self.runner, "_clear", side_effect=lambda deadline=None: next(clears)):
            result = self.run_job(fake)
        self.assertEqual(result, ro.refusal("workspace_failed"))
        self.assertEqual(fake.calls, [], "nothing ran beside an uncleared leftover")

    def test_the_agent_answers_on_the_control_path_without_waiting_for_the_job(self):
        gate = threading.Event()
        fake = FakeDesktop(before=lambda argv: gate.wait(5))
        with mock.patch.object(ro, "bounded_runc_exec", fake.exec_):
            started = time.monotonic()
            self.assertEqual(self.send("repo_open", request=relayed()), {"ok": True, "state": "running"})
            self.assertEqual(self.send("presence"), {"ok": True})
            self.assertLess(time.monotonic() - started, 1.0)
            gate.set()
            self.wait_done()
            self.wait_idle()


# ─────────────────────────────────────────────────────────────────────────── real cgroup v2
STUB_RUNC = """#!/usr/bin/env python3
import os, sys
ROOT = {root!r}
a = sys.argv[1:]
i = a.index("--cgroup")
name, rest = a[i + 1], a[i + 2:]          # <containerId> <argv...>
with open(os.path.join(ROOT, name, "cgroup.procs"), "w") as f:
    f.write(str(os.getpid()))                # what runc exec --cgroup does: join the sub-cgroup
os.execvp(rest[1], rest[1:])
"""


def own_cgroup():
    with open("/proc/self/cgroup") as f:
        found = next(entry for entry in f if entry.startswith("0::/"))
    return "/sys/fs/cgroup" + found[3:].strip()


@unittest.skipUnless(os.geteuid() == 0 and os.path.isfile(os.path.join(own_cgroup(), "cgroup.kill")),
                     "needs root on cgroup v2 with cgroup.kill")
class BoundedExec(unittest.TestCase):
    """bounded_runc_exec with REAL cgroup v2 semantics. The stub runc joins the requested
    sub-cgroup of a scratch 'container' cgroup and runs the argv ON THIS HOST, so every argv
    here is harmless (cat, sh -c echo/sleep, yes)."""

    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.root = os.path.join(own_cgroup(), f"ezil-test-ro-{os.getpid()}-{time.monotonic_ns()}")
        os.mkdir(self.root)
        self.addCleanup(self._remove_root)
        stub = os.path.join(self.d, "runc")
        with open(stub, "w") as f:
            f.write(STUB_RUNC.format(root=self.root))
        os.chmod(stub, 0o755)
        self.cfg["runcBin"] = stub

    def _remove_root(self):
        for name in os.listdir(self.root):
            p = os.path.join(self.root, name)
            if os.path.isdir(p):
                try:
                    with open(os.path.join(p, "cgroup.kill"), "w") as f:
                        f.write("1")
                    time.sleep(0.2)
                    os.rmdir(p)
                except OSError:
                    pass
        os.rmdir(self.root)

    def run_exec(self, argv, timeout, data=None, **kw):
        return ro.bounded_runc_exec(self.cfg, argv, time.monotonic() + timeout, data, cgroup_root=self.root, **kw)

    def leftovers(self):
        return [n for n in os.listdir(self.root) if n.startswith(ro.CGROUP_PREFIX)]

    def test_returns_code_and_stdout_passes_stdin_and_leaves_no_cgroup(self):
        self.assertEqual(self.run_exec(["cat"], 10, b"hello"), (0, b"hello"))
        self.assertEqual(self.run_exec(["sh", "-c", "exit 3"], 10)[0], 3)
        self.assertEqual(self.leftovers(), [])

    def test_stdin_is_an_unlinked_private_file_never_a_pipe_or_argv(self):
        rc, out = self.run_exec(["sh", "-c", "readlink /proc/self/fd/0; stat -L -c %a /proc/self/fd/0"], 10, b"secret")
        target, mode = out.decode().split("\n")[:2]
        self.assertEqual(rc, 0)
        self.assertTrue(target.endswith("(deleted)") or "/#" in target, target)
        self.assertEqual(mode, "600")

    def test_an_orphan_reparented_away_from_the_exec_is_still_killed(self):
        marker = os.path.join(self.d, "orphan-finished")
        rc, _ = self.run_exec(["sh", "-c", f"(exec >/dev/null; sleep 1.5; touch {marker}) & exit 0"], 10)
        self.assertEqual(rc, 0)
        time.sleep(2)
        self.assertFalse(os.path.exists(marker), "every process of the exec ends with it")
        self.assertEqual(self.leftovers(), [])

    def test_output_flood_is_cut_at_the_limit_and_everything_is_killed(self):
        started = time.monotonic()
        with self.assertRaises(ro.ExecLimit) as caught:
            self.run_exec(["yes", "flood"], 30, limit=4096)
        self.assertFalse(caught.exception.timed_out)
        self.assertLessEqual(len(caught.exception.output), 4096)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(self.leftovers(), [])

    def test_a_tree_past_its_deadline_is_killed_and_keeps_its_partial_output(self):
        marker = os.path.join(self.d, "late")
        with self.assertRaises(ro.ExecLimit) as caught:
            self.run_exec(["sh", "-c", f"echo partial; (sleep 1.5; touch {marker}) & sleep 30"], 0.5)
        self.assertTrue(caught.exception.timed_out)
        self.assertEqual(caught.exception.output, b"partial\n")
        time.sleep(2)
        self.assertFalse(os.path.exists(marker))
        self.assertEqual(self.leftovers(), [])

    def test_a_process_that_never_reads_stdin_cannot_stall_the_agent(self):
        started = time.monotonic()
        with self.assertRaises(ro.ExecLimit):
            self.run_exec(["sleep", "30"], 0.5, b"x" * (4 * 1024 * 1024))
        self.assertLess(time.monotonic() - started, 6)
        self.assertEqual(self.leftovers(), [])

    def test_no_process_outside_the_jobs_cgroup_is_touched(self):
        bystander = subprocess.Popen(["sleep", "30"])
        self.addCleanup(lambda: (bystander.kill(), bystander.wait()))
        with self.assertRaises(ro.ExecLimit):
            self.run_exec(["yes"], 10, limit=4096)
        self.assertIsNone(bystander.poll())

    def test_stderr_is_discarded_not_buffered(self):
        rc, out = self.run_exec(["sh", "-c", "head -c 200000 /dev/zero >&2; echo ok"], 10)
        self.assertEqual((rc, out), (0, b"ok\n"))

    def test_nothing_starts_without_a_container_cgroup_or_past_the_deadline(self):
        marker = os.path.join(self.d, "ran")
        with self.assertRaises(OSError):
            ro.bounded_runc_exec(self.cfg, ["touch", marker], time.monotonic() + 10, cgroup_root=None)
        with self.assertRaises(OSError):
            ro.bounded_runc_exec(self.cfg, ["touch", marker], time.monotonic() + 10, cgroup_root=self.d)
        with self.assertRaises(ro.ExecLimit):
            ro.bounded_runc_exec(self.cfg, ["touch", marker], time.monotonic() - 0.01, cgroup_root=self.root)
        with self.assertRaises(ValueError):
            ro.bounded_runc_exec(self.cfg, "touch " + marker, time.monotonic() + 10, cgroup_root=self.root)
        self.assertFalse(os.path.exists(marker))

    def test_a_cgroup_that_never_empties_is_left_in_place_as_pending(self):
        stuck = os.path.join(self.root, ro.CGROUP_PREFIX + "0" * 16 + "-stuck")
        os.mkdir(stuck)
        with mock.patch.object(ro, "_cgroup_populated", return_value=True):
            with self.assertRaises(ro.CleanupPending):
                ro._drain_cgroup(stuck, cap=0.3)
        self.assertTrue(os.path.isdir(stuck), "a cgroup not confirmed empty is never removed")

    def test_a_repopulated_cgroup_is_drained_again(self):
        path = os.path.join(self.root, ro.CGROUP_PREFIX + "1" * 16 + "-busy")
        os.mkdir(path)
        real_rmdir, calls = os.rmdir, []

        def flaky(p):
            calls.append(p)
            if len(calls) == 1:
                raise OSError(16, "Device or resource busy")
            real_rmdir(p)
        with mock.patch.object(ro.os, "rmdir", flaky):
            ro._drain_cgroup(path, cap=5)
        self.assertEqual(len(calls), 2)
        self.assertFalse(os.path.exists(path))

    def test_the_reaper_kills_leftover_job_cgroups_and_reports_clear_only_when_gone(self):
        orphan = os.path.join(self.root, ro.CGROUP_PREFIX + "3" * 16 + "-left")
        os.mkdir(orphan)
        sleeper = subprocess.Popen(["sleep", "30"])
        self.addCleanup(lambda: (sleeper.kill(), sleeper.wait()))
        with open(os.path.join(orphan, "cgroup.procs"), "w") as f:
            f.write(str(sleeper.pid))
        with mock.patch.object(ro, "desktop_probe", return_value=("running", 4242)), \
                mock.patch.object(ro, "cgroup_root_of", return_value=self.root):
            self.assertEqual(ro.reap_cgroups(self.cfg), 1)
            sleeper.wait(timeout=5)
            for _ in range(50):
                if ro.reap_cgroups(self.cfg) == 0:
                    break
                time.sleep(0.05)
        self.assertFalse(os.path.exists(orphan))

    def test_reap_fails_closed_unless_the_container_is_positively_absent(self):
        with mock.patch.object(ro, "desktop_probe", side_effect=ro.ContainerAbsent()):
            self.assertEqual(ro.reap_cgroups(self.cfg), 0)
        for err in (OSError("desktop_state_timeout"), ValueError("bad")):
            with mock.patch.object(ro, "desktop_probe", side_effect=err):
                self.assertEqual(ro.reap_cgroups(self.cfg), 1)
        with mock.patch.object(ro, "desktop_probe", return_value=("running", 4242)), \
                mock.patch.object(ro, "cgroup_root_of", side_effect=OSError("desktop_cgroup_unavailable")):
            self.assertEqual(ro.reap_cgroups(self.cfg), 1)

    def test_a_launcher_that_will_not_exit_is_pending_and_tracked(self):
        real_popen = subprocess.Popen

        class Stubborn(real_popen):
            def wait(self, timeout=None):
                if timeout == 5:
                    raise subprocess.TimeoutExpired(self.args, timeout)
                return super().wait(timeout)
        with mock.patch.object(ro.subprocess, "Popen", Stubborn), \
                mock.patch.object(ro, "_drain_cgroup", side_effect=ro.CleanupPending()):
            with self.assertRaises(ro.CleanupPending) as caught:
                self.run_exec(["true"], 10)
        self.assertIsInstance(caught.exception.args[0], subprocess.Popen)
        caught.exception.args[0].wait()


class Probe(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)

    def test_runc_state_is_bounded_and_strict(self):
        def answer(rc, out="", err=""):
            return lambda cfg, *a, **kw: subprocess.CompletedProcess(a, rc, out, err)
        with mock.patch.object(desktop, "runc", answer(0, json.dumps({"status": "running", "pid": 77}))):
            self.assertEqual(ro.desktop_probe(self.cfg), ("running", 77))
        with mock.patch.object(desktop, "runc", answer(1, err="container does not exist")):
            with self.assertRaises(ro.ContainerAbsent):
                ro.desktop_probe(self.cfg)
        for bad in (answer(1, err="other"), answer(0, "nope"), answer(0, json.dumps({"status": "running", "pid": 1})),
                    answer(0, json.dumps({"status": "running", "pid": True})), answer(0, "[]")):
            with mock.patch.object(desktop, "runc", bad):
                with self.assertRaises(OSError):
                    ro.desktop_probe(self.cfg)

        def hang(cfg, *args, **kw):
            raise subprocess.TimeoutExpired(args, kw.get("timeout"))
        with mock.patch.object(desktop, "runc", hang):
            with self.assertRaises(OSError):
                ro.desktop_probe(self.cfg)


# ─────────────────────────────────────────────────────────────────────────── edge
class RepoOpenEdge(unittest.TestCase):
    def setUp(self):
        test_edge.EdgeE2E.setUp(self)
        self.agent.repo_open.busy = False
        with open(os.path.join(self.cfg.runDir, "guard-ok"), "w") as f:
            json.dump({"generation": test_edge.LEASE["generation"], "leaseEpoch": test_edge.LEASE["leaseEpoch"]}, f)
        self.fake = FakeDesktop()
        for target, value in (("reap_cgroups", mock.Mock(return_value=0)),
                              ("desktop_probe", lambda cfg, timeout=10.0: ("running", 4242)),
                              ("cgroup_root_of", lambda pid: "/fake/cgroup"),
                              ("bounded_runc_exec", self.fake.exec_)):
            p = mock.patch.object(ro, target, value)
            p.start()
            self.addCleanup(p.stop)

    tearDown = test_edge.EdgeE2E.tearDown
    req = test_edge.EdgeE2E.req

    def start_req(self, data, digest=None, headers=None, method="POST", gw=True, query="", ts=None):
        digest = hashlib.sha256(data).hexdigest() if digest is None else digest
        return self.req(method, f"/__ezil/control/repo-open/{digest}{query}",
                        headers=[f"Content-Length: {len(data)}"] if headers is None else headers, body=data, gw=gw, ts=ts)

    def status(self, job=JOB):
        return test_edge.raw(self.port, self.req("POST", f"/__ezil/control/repo-open-status/{job}",
                                                 headers=["Content-Length: 0"]))

    @staticmethod
    def parse(out):
        head, _, payload = out.partition(b"\r\n\r\n")
        return int(head.split(b" ")[1]), json.loads(payload)

    def test_start_then_status_through_the_signed_edge(self):
        data = json.dumps(relayed()).encode()
        code, started = self.parse(test_edge.raw(self.port, self.start_req(data)))
        self.assertEqual((code, started), (200, {"ok": True, "state": "running"}))
        for _ in range(300):
            code, st = self.parse(self.status())
            if st.get("state") == "done":
                break
            time.sleep(0.02)
        self.assertEqual((code, st), (200, {"ok": True, "state": "done", "result": {"status": 200, "body": OPEN_OK}}))
        self.assertEqual(self.fake.phases(), ["prepare", "commit", "release"])
        code, again = self.parse(test_edge.raw(self.port, self.start_req(data)))
        self.assertEqual((code, again), (409, {"ok": False, "error": "job_replayed"}))
        self.assertEqual(self.parse(self.status("e" * 64)), (409, {"ok": False, "error": "job_unknown"}))
        self.assertNotIn(TOKEN, "\n".join(self.logs))

    def test_another_bodys_digest_is_refused_before_the_agent(self):
        """Discriminating: the body is valid and would start a job; only its digest is wrong."""
        data = json.dumps(relayed()).encode()
        other = json.dumps(relayed("b" * 64)).encode()
        code, out = self.parse(test_edge.raw(self.port, self.start_req(data, digest=hashlib.sha256(other).hexdigest())))
        self.assertEqual((code, out), (400, {"ok": False, "error": "repo_open_digest_mismatch"}))
        self.assertEqual(self.agent.repo_open.jobs, {})
        self.assertEqual(self.fake.calls, [])

    def test_framing_signature_and_method_are_enforced_before_the_agent(self):
        data = json.dumps(relayed()).encode()
        d = hashlib.sha256(data).hexdigest()
        # Oversize but otherwise valid (JSON allows trailing whitespace, the digest matches), so only the
        # size bound refuses it.
        big = data + b" " * (edge_mod.MAX_REPO_OPEN_BODY + 1 - len(data))
        self.assertIsNotNone(ro.decode_relay(big))
        cases = [
            (self.start_req(data, gw=False), 401),
            (self.start_req(data, ts=int(time.time()) - 200), 401),                         # stale gw1
            (self.start_req(data, gw=test_edge.gw_header("POST", f"/__ezil/control/repo-open/{'0' * 64}")), 401),
            (self.start_req(data, gw=test_edge.gw_header("POST", f"/__ezil/control/repo-open/{d}",
                                                         binding={**test_edge.LEASE, "leaseEpoch": 3})), 401),   # another epoch
            (self.start_req(big, digest=hashlib.sha256(big).hexdigest()), 400),             # oversize
            (self.req("POST", f"/__ezil/control/repo-open/{d}", headers=["Transfer-Encoding: chunked"],
                      body=b"%x\r\n" % len(data) + data + b"\r\n0\r\n\r\n"), 400),           # chunked
            (self.start_req(data, headers=[f"Content-Length: {len(data)}", "Transfer-Encoding: chunked"]), 400),
            (self.start_req(data, headers=["Content-Length: +12"]), 400),
            (self.start_req(data, headers=[]), 400),
            (self.start_req(b"", headers=["Content-Length: 0"]), 400),
            (self.start_req(b"[1]"), 400),
            (self.start_req(b'{"jobId":"a","jobId":"b"}'), 400),
            (self.start_req(data, method="GET"), 404),
            (self.start_req(data, query="?x=1"), 404),
            (self.req("POST", f"/__ezil/control/repo-open-status/{JOB}", headers=["Content-Length: 3"], body=b"abc"), 404),
            (self.req("GET", f"/__ezil/control/repo-open-status/{JOB}"), 404),
            (self.req("POST", f"/__ezil/control/repo-open-status/{JOB}?x=1"), 404),
            (self.req("POST", f"/__ezil/control/repo-open-status/{JOB}", gw=False), 401),
            (self.req("POST", f"/__ezil/control/repo-open-status/{JOB[:-1]}"), 404),
            (self.req("POST", "/__ezil/control/repo-open"), 404),
        ]
        for data_, code in cases:
            out = test_edge.raw(self.port, data_)
            self.assertTrue(out.startswith(b"HTTP/1.1 %d" % code), (code, data_[:90], out[:90]))
        self.assertEqual(self.agent.repo_open.jobs, {})
        self.assertEqual(self.fake.calls, [])

    def test_agent_refusals_and_failures_map_to_409_or_503(self):
        data = json.dumps(relayed(name="a..b")).encode()
        self.assertEqual(self.parse(test_edge.raw(self.port, self.start_req(data))),
                         (409, {"ok": False, "error": "repo_open_invalid"}))
        data = json.dumps(relayed()).encode()
        with mock.patch.object(self.edge.seq, "send", return_value={}):
            self.assertEqual(self.parse(test_edge.raw(self.port, self.start_req(data))),
                             (503, {"ok": False, "error": "agent_unavailable"}))
        with mock.patch.object(self.edge.seq, "send", return_value={"ok": False, "error": "internal", "detail": "X"}):
            self.assertEqual(self.parse(test_edge.raw(self.port, self.start_req(data)))[0], 503)
        with mock.patch.object(self.edge.seq, "send", side_effect=OSError()):
            self.assertEqual(self.parse(test_edge.raw(self.port, self.start_req(data)))[0], 503)
        with mock.patch.object(self.edge.seq, "send", return_value={"ok": True, "state": "done", "secret": TOKEN,
                                                                     "result": {"status": 200, "body": {}, "x": TOKEN}}):
            out = self.status()
        self.assertNotIn(TOKEN.encode(), out, "only allow-listed keys leave the edge")


# ─────────────────────────────────────────────────────────────────────────── the real kernel
DOCKER_IMAGES = ("ezil-os-desktop:staging-lower34ac-106", "ezil-os-worker-sandbox:5e96dc3f")


def _docker_image():
    if os.geteuid() != 0:
        return None
    for image in DOCKER_IMAGES:
        try:
            if subprocess.run(["docker", "image", "inspect", image], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=20).returncode == 0:
                return image
        except (OSError, subprocess.SubprocessError):
            return None
    return None


IMAGE = _docker_image()


@unittest.skipUnless(IMAGE, "needs root, Docker and a local desktop image (" + ", ".join(DOCKER_IMAGES) + ")")
class RealKernel(JobBase):
    """The real pinned kernel and helper, run by the host job's exact argv sequence inside a
    throwaway container (network none; tmpfs /run WITHOUT noexec, as desktop.py:585 mounts it,
    since the helper wrapper must execute; tmpfs /workspace). Only the runc transport is
    replaced by `docker exec -i <this test's container>`."""

    @classmethod
    def setUpClass(cls):
        cls.name = f"ezil-repo-open-a2h-test-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        subprocess.run(["docker", "run", "-d", "--rm", "--name", cls.name, "--network", "none",
                        "--tmpfs", "/run:rw,exec,nosuid,nodev,mode=755", "--tmpfs", "/workspace:rw,mode=755",
                        "--entrypoint", "/bin/sleep", IMAGE, "infinity"], check=True, stdout=subprocess.DEVNULL,
                       timeout=120)

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["docker", "rm", "-f", cls.name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)

    def sh(self, script):
        return subprocess.run(["docker", "exec", self.name, "/bin/sh", "-c", script], capture_output=True, text=True,
                              timeout=60)

    def docker_exec(self, cfg, argv, deadline, data=None, limit=ro.STDOUT_MAX, tag=None, cgroup_root=None, clock=None):
        self.argvs.append(list(argv))
        r = subprocess.run(["docker", "exec", "-i", self.name, *argv], input=data or b"", stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=max(1.0, deadline - time.monotonic()))
        self.stdouts.append(r.stdout)
        return r.returncode, r.stdout

    def run_real(self, job, **over):
        self.argvs, self.stdouts = [], []
        with mock.patch.object(ro, "bounded_runc_exec", self.docker_exec):
            self.assertEqual(self.send("repo_open", request=relayed(job, **over)), {"ok": True, "state": "running"})
            st = self.wait_done(job)
            self.wait_idle()
        for out in self.stdouts:
            self.assertNotIn(TOKEN.encode(), out)
        return st["result"]

    def test_refresh_existing_open_and_offline_clone_through_the_real_kernel(self):
        # refresh with no folder: the grant is installed, then release removes it (no folder).
        self.assertEqual(self.run_real("1" * 64, op="refresh"), {"status": 200, "body": {"ok": True, "state": "refreshed"}})
        r = self.sh("ls -A /run/ezil/requests /run/ezil/git/incoming /run/ezil/git/grants; "
                    "stat -c '%a %u %n' /run/ezil /run/ezil/bin/ezil-repo-open.mjs /run/ezil/bin/ezil-git-grant.mjs "
                    "/run/ezil/bin/ezil-git-grant; ls -A /run/ezil/bin")
        self.assertIn("700 0 /run/ezil\n", r.stdout)
        self.assertIn("500 0 /run/ezil/bin/ezil-repo-open.mjs", r.stdout)
        self.assertIn("500 0 /run/ezil/bin/ezil-git-grant.mjs", r.stdout)
        self.assertIn("500 0 /run/ezil/bin/ezil-git-grant\n", r.stdout)
        self.assertNotIn(".json", r.stdout, "release removed the request, incoming and orphan grant files")
        self.assertNotIn(".ezil-", r.stdout.split("ezil-git-grant\n", 1)[-1], "no temporary kernel or helper left")

        # an existing folder bound to this repository: prepare says existing, commit repairs and installs.
        b = body()
        binding = json.dumps({"v": 1, "repositoryId": b["repositoryId"], "handle": "acme", "name": "site",
                              "gitHost": "git-preview.ezil.work"})
        setup = self.sh("set -e; git init -q -b main /workspace/repos/acme/site; cd /workspace/repos/acme/site; "
                        "git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m init; "
                        f"printf '%s\\n' '{binding}' > .git/ezil-repo.json; mkdir src")
        self.assertEqual(setup.returncode, 0, setup.stderr)
        answer = {"ok": True, "state": "existing", "folder": FOLDER, "openFolder": FOLDER + "/src",
                  "pathNotFound": False, "branch": "main", "empty": False}
        self.assertEqual(self.run_real("2" * 64, path="src"), {"status": 200, "body": answer})
        self.assertEqual([a[2] for a in self.argvs if a[:2] == ["node", ro.KERNEL_PATH]], ["prepare", "commit", "release"])
        grant = self.sh("stat -c '%a %u' /run/ezil/git/grants/acme__site.json; cat /run/ezil/git/grants/acme__site.json")
        mode, content = grant.stdout.split("\n", 1)
        self.assertEqual(mode, "600 0")
        self.assertEqual(json.loads(content)["password"], TOKEN)
        config = self.sh("cd /workspace/repos/acme/site && git config --local --list && cat .git/config")
        self.assertNotIn(TOKEN, config.stdout)
        expect = [s.replace("<gitHost>", "git-preview.ezil.work").replace("<handle>", "acme").replace("<name>", "site")
                  for s in V["gitConfig"]["expectLocalList"]]
        listed = [ln for ln in config.stdout.split("\n") if ln.startswith("credential.")]
        self.assertEqual(listed, [ln for ln in expect if ln.startswith("credential.")],
                         "commit repaired exactly the §9.5 credential keys of the existing folder")
        helper = self.sh("cd /workspace/repos/acme/site && printf 'protocol=https\\nhost=git-preview.ezil.work\\n"
                         "path=acme/site.git\\n\\n' | /run/ezil/bin/ezil-git-grant get")
        self.assertIn("username=ezil", helper.stdout, helper.stderr)
        self.assertIn(f"password={TOKEN}", helper.stdout, "the installed grant answers git through the helper")
        self.assertEqual(self.sh("ls -A /run/ezil/requests /run/ezil/git/incoming /run/ezil/locks").stdout.strip()
                         .replace("/run/ezil/requests:", "").replace("/run/ezil/git/incoming:", "")
                         .replace("/run/ezil/locks:", "").strip(), "")

        # a new repository offline: prepare cannot reach git-preview, nothing is left behind.
        self.assertEqual(self.run_real("3" * 64, name="other"), ro.refusal("network_unavailable"))
        left = self.sh("ls -A /workspace/.ezil-staging /run/ezil/locks /run/ezil/requests /run/ezil/git/incoming 2>&1; "
                       "ls /run/ezil/git/grants; test -e /workspace/repos/acme/other && echo FOLDER")
        self.assertNotIn("FOLDER", left.stdout)
        self.assertNotIn("acme__other", left.stdout)
        self.assertEqual(re.sub(r"/run/ezil/[a-z/]+:|/workspace/\.ezil-staging:|acme__site\.json", "", left.stdout).strip(), "")
        self.no_token_in_container_except_grant()

    def grep_token(self, script):
        """The token travels on grep's stdin (-f), never in its argv, so grep cannot find itself."""
        return subprocess.run(["docker", "exec", "-i", self.name, "/bin/sh", "-c", script], input=TOKEN + "\n",
                              capture_output=True, text=True, timeout=60).stdout.split()

    def no_token_in_container_except_grant(self):
        self.assertEqual(self.grep_token("grep -rlF -f /dev/stdin /workspace /etc /root /home /tmp /run/ezil 2>/dev/null; true"),
                         ["/run/ezil/git/grants/acme__site.json"])
        self.assertEqual(self.grep_token("grep -lF -f /dev/stdin /proc/[0-9]*/cmdline /proc/[0-9]*/environ 2>/dev/null; true"),
                         [])


if __name__ == "__main__":
    unittest.main()
