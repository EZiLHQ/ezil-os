"""Offline standalone Git gates: no Docker, hosts, AWS or external network."""
import copy, hashlib, hmac, json, os, runpy, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))
from ezil_host import standalone_git as sg, standalone_git_runtime as rt, agent, desktop, edge

NOW = 1794430000.0
CID = "11111111-1111-4111-8111-111111111111"
RID = "44444444-4444-8444-8444-444444444444"
SECRET = "art_v1_" + "a" * 40 + "?expires=1794430240"

def fresh():
    from datetime import datetime, timezone
    end = datetime.fromtimestamp(NOW+240,timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z")
    return {"v":1,"jobId":"b"*64,"repositoryId":RID,"timeoutMs":60000,"privatePacket":{
        "version":2,"repository":{"id":"cfprovider123","canonicalURL":"https://github.ezil.work/default/fixture.git","ref":"refs/heads/main"},
        "identity":{"issuer":"https://id.ezil.work/","subject":"auth0|fixture"},
        "git":{"username":"ezil","token":SECRET,"expiresAt":end,"scope":"write"}}}

def output(r, **changes):
    p=r["privatePacket"]
    return json.dumps({"canonicalUrl":p["repository"]["canonicalURL"],"folder":"/workspace/projects/"+RID+"/fixture",
                       "repository":p["repository"],"identity":p["identity"],"status":"reused",**changes}).encode()

def assigned():
    r = fresh()
    owner = hashlib.sha256(r["privatePacket"]["identity"]["subject"].encode()).hexdigest()
    attempt = "22222222-2222-4222-8222-222222222222"
    event = "33333333-3333-4333-8333-333333333333"
    canonical = f"https://github.ezil.work/default/u-{owner[:16]}-a-{attempt}.git"
    identifier = list(hashlib.sha256(f"ezil-os/repo-url/v1|{canonical}".encode()).hexdigest()[:32])
    identifier[12] = "8"
    identifier[16] = "89ab"[int(identifier[16], 16) & 3]
    hx = "".join(identifier)
    repository = f"{hx[:8]}-{hx[8:12]}-{hx[12:16]}-{hx[16:20]}-{hx[20:]}"
    r["repositoryId"] = repository
    r["privatePacket"]["repository"]["canonicalURL"] = canonical
    r["assignmentPreload"] = {"eventId": event, "attemptId": attempt, "ownerSha256": owner, "canonicalURL": canonical,
                              "repositoryId": repository, "ref": "refs/heads/main", "manifestSha256": "c" * 64, "nonce": "d" * 64}
    folder = f"/workspace/projects/{repository}/{canonical.rsplit('/', 1)[1][:-4]}"
    return r, folder


class Packet(unittest.TestCase):
    def test_optional_author_and_renewal_metadata_are_closed(self):
        r={**fresh(),"gitAuthor":{"name":"Contact","email":"contact@ezil.work"},"refreshOnly":True}
        self.assertTrue(sg.valid_request(r,NOW*1000))
        for changes in ({"refreshOnly":False},{"gitAuthor":{"name":"Contact\nInjected","email":"contact@ezil.work"}},
                        {"gitAuthor":{"name":"Contact","email":"bad email@example.org"}},
                        {"gitAuthor":{"name":"Contact","email":"contact@ezil.work","extra":True}}):
            self.assertFalse(sg.valid_request({**r,**changes},NOW*1000))
        legacy=output(r,folder="/workspace/projects/"+RID+"/repository")
        self.assertIsNotNone(sg.validate_output(legacy,r))
        self.assertIsNone(sg.validate_output(legacy,fresh()))

    def test_assignment_preload_is_closed_to_the_canonical_subject_checkout(self):
        r, checkout = assigned()
        self.assertTrue(sg.valid_request(r,NOW*1000))
        self.assertEqual(sg.validate_output(output(r, folder=checkout), r)["checkoutFolder"], checkout)
        for key, value in {"nonce": "wrong", "eventId": RID.replace("-8444-", "-7444-"),
                           "ownerSha256": "a" * 64, "repositoryId": RID, "ref": "refs/heads/other"}.items():
            changed = copy.deepcopy(r)
            changed["assignmentPreload"][key] = value
            self.assertFalse(sg.valid_request(changed,NOW*1000), key)
        self.assertFalse(sg.valid_request({**r, "refreshOnly": True},NOW*1000))
        r["privatePacket"]["git"]["scope"] = "read"
        self.assertFalse(sg.valid_request(r,NOW*1000))

    def test_native_read_write_and_closed_scope_identity_url_ref_expiry(self):
        r=fresh()
        for scope in ("read","write"):
            r["privatePacket"]["git"]["scope"]=scope
            self.assertTrue(sg.valid_request(r,NOW*1000))
        mutations=[
            lambda x:x.update(script="arbitrary"),
            lambda x:x["privatePacket"]["git"].update(scope="admin"),
            lambda x:x["privatePacket"]["git"].update(token=SECRET+"\n"),
            lambda x:x["privatePacket"]["git"].update(token=SECRET+":unsafe"),
            lambda x:x["privatePacket"]["identity"].update(issuer="https://other.invalid/"),
            lambda x:x["privatePacket"]["repository"].update(ref="refs/heads/../bad"),
            lambda x:x["privatePacket"]["repository"].update(canonicalURL="https://github.ezil.work/default/../bad.git"),
            lambda x:x["privatePacket"]["git"].update(expiresAt="2020-01-01T00:00:00Z"),
            lambda x:x.update(timeoutMs=True)]
        for mutate in mutations:
            bad=copy.deepcopy(r);mutate(bad);self.assertFalse(sg.valid_request(bad,NOW*1000))

    def test_duplicate_utf8_oversize_insufficient_lifetime_refused(self):
        r=fresh();raw=json.dumps(r).encode()
        self.assertEqual(sg.parse_request(raw,NOW*1000),r)
        for bad in (raw[:-1]+b',"v":1}',b"\xff",b"x"*20481):
            self.assertIsNone(sg.parse_request(bad,NOW*1000))
        self.assertFalse(sg.valid_request(r,(NOW+180)*1000))

    def test_output_identity_provider_id_ref_and_quarantine_wrapper(self):
        r=fresh()
        self.assertEqual(sg.validate_output(output(r),r),{"ok":True,"folder":"/workspace/projects/"+RID,"status":"fetched"})
        for change in ({"folder":"/workspace"},{"identity":{"issuer":"https://id.ezil.work/","subject":"other"}},
                       {"repository":{**r["privatePacket"]["repository"],"id":"wrong"}},
                       {"repository":{**r["privatePacket"]["repository"],"ref":"refs/heads/other"}},
                       {"status":SECRET},{"extra":True}):
            self.assertIsNone(sg.validate_output(output(r,**change),r))

    def test_public_assets_exact_reviewed_cloudflare_sources(self):
        root=HERE.parents[2]
        self.assertEqual((rt.ASSETS/"stage.py").read_bytes(),(root/"worker/repo-open/stage.py").read_bytes())
        # The app source and the staging Worker have separate release revisions.
        for name, reviewed_sha in {
            "supervise.py": "a820cdc20fb1336ee778b7e19115d5802b7317f2cd1499ed8294449b9182ccbc",
            "assignment-preload.py": "e3d06237dcd0c628d22def148dae0f72226438e0a6dea79c148e8ce0784ffdab",
        }.items():
            self.assertEqual(hashlib.sha256((rt.ASSETS/name).read_bytes()).hexdigest(), reviewed_sha)
        pin,argv=rt.runtime_command()
        self.assertEqual(pin["cliSha256"],"add3f83cef4b35e8a65f43af3d4ad8ed745c5fa25b6d728b21ad8f0500d63049")
        self.assertNotIn(SECRET,repr(argv))

class AssignmentEdge(unittest.TestCase):
    def response(self, path, result):
        binding = {"computerId": CID, "generation": 1, "leaseEpoch": 2}
        key = b"k" * 32
        digest = hmac.new(key, edge.gateway_payload(binding, int(NOW), "GET", path).encode("ascii"), hashlib.sha256).hexdigest()
        head = SimpleNamespace(
            target=path, method="GET", rest=b"",
            get=lambda name: [f"gw1.{int(NOW)}.{digest}"] if name == edge.GW_HEADER else [],
        )
        service = object.__new__(edge.Edge)
        service.key, service.binding, service.clock = key, binding, lambda: NOW
        service.ports = (8443, 5679)
        service.seq = SimpleNamespace(send=mock.Mock(return_value=result), presence=mock.Mock())
        service._proxy = mock.Mock()
        with mock.patch.object(edge, "read_head", return_value=head), mock.patch.object(edge, "_reply") as reply:
            service.handle(SimpleNamespace(settimeout=lambda _: None))
        return reply.call_args.args[1:] if reply.called else None, service._proxy

    def test_signed_status_exposes_only_the_legacy_or_exact_assignment_shape(self):
        request, checkout = assigned()
        witness = request["assignmentPreload"]
        path = "/__ezil/control/standalone-repo-open-status/" + request["jobId"]
        legacy = {"ok": True, "folder": f"/workspace/projects/{request['repositoryId']}", "status": "fetched"}
        ack = {"eventId": witness["eventId"], "nonce": witness["nonce"], "port": 5679, "status": "acknowledged"}
        assignment = {**legacy, "checkoutFolder": checkout, "assignmentPreload": ack}

        def completed(result):
            return {"ok": True, "state": "done", "result": result}

        for result in (legacy, assignment):
            with self.subTest(result=set(result)):
                result_wrapper = completed(result)
                self.assertEqual(self.response(path, result_wrapper)[0], (200, result_wrapper))
        for malformed in (
            {**legacy, "checkoutFolder": checkout},
            {**assignment, "checkoutFolder": legacy["folder"] + "/../other"},
            {**assignment, "assignmentPreload": {**ack, "port": 5679.0}},
            {**assignment, "assignmentPreload": {**ack, "nonce": "q" * 64}},
            {**assignment, "assignmentPreload": {**ack, "secret": SECRET}},
        ):
            with self.subTest(keys=set(malformed)):
                self.assertEqual(self.response(path, completed(malformed))[0], (503, {"ok": False, "error": "agent_unavailable"}))

    def test_private_assignment_port_cannot_be_opened_via_public_edge_proxy(self):
        for path in (
            "/__p/5679/",
            "/__p/8443/proxy/5679/",
            "/__p/8443/preview-ws//absproxy/5679/",
            "/__p/8443/%2fproxy%2f%35%36%37%39/",
        ):
            with self.subTest(path=path):
                reply, forward = self.response(path, None)
                self.assertEqual(reply, (404, {"ok": False, "error": "not_found"}))
                forward.assert_not_called()
        reply, forward = self.response("/__p/8443/proxy/5678/", None)
        self.assertIsNone(reply)
        self.assertEqual(forward.call_args.args[2:], (8443, "/proxy/5678/"))


class AssignmentSupervisor(unittest.TestCase):
    def test_reopen_allows_only_the_exact_platform_terminal_settings(self):
        reviewed = runpy.run_path(str(rt.ASSETS / "supervise.py"))
        checked = reviewed["checked_assignment_terminal"]
        _, checkout = assigned()
        name = Path(checkout).name
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            setting_dir = folder / ".vscode"
            self.assertFalse(checked(directory, name))
            setting_dir.mkdir()
            settings = setting_dir / "settings.json"
            value = {"terminal.integrated.cwd": str(folder / name), "terminal.integrated.splitCwd": "initial"}
            expected = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
            settings.write_bytes(expected)
            self.assertTrue(checked(directory, name))
            self.assertFalse(checked(directory, "ordinary-checkout"))
            settings.chmod(0o755)
            self.assertFalse(checked(directory, name))
            settings.chmod(0o644)
            extra = setting_dir / "tasks.json"
            extra.touch()
            self.assertFalse(checked(directory, name))
            extra.unlink()
            settings.write_bytes(expected + b" ")
            self.assertFalse(checked(directory, name))
            settings.unlink()
            other = folder / "other.json"
            other.write_bytes(expected)
            settings.symlink_to(other)
            self.assertFalse(checked(directory, name))


class Runtime(unittest.TestCase):
    def test_only_fd_bootstrap_is_decorated_not_the_gateway_packet(self):
        r={**fresh(),"gitAuthor":{"name":"Contact","email":"contact@ezil.work"},"refreshOnly":True}
        calls=[]
        def run(cfg,argv,**kw):
            calls.append((argv,kw))
            return subprocess.CompletedProcess(argv,0,b"ezil-cli-bootstrap:ok\n" if len(calls)==1 else output(r))
        with mock.patch.object(desktop,"exec_",side_effect=run):
            result,uncertain=rt.execute(None,{},r,ready=lambda*a:True,clock=lambda:0,wall=lambda:NOW)
        self.assertTrue(result["ok"]);self.assertFalse(uncertain)
        self.assertEqual(json.loads(calls[1][1]["input"]),{**r["privatePacket"],"gitAccess":True,"gitAuthor":r["gitAuthor"],"refreshOnly":True})
        self.assertNotIn("gitAuthor",r["privatePacket"])
        self.assertNotIn("contact@ezil.work",repr(calls[1][0]))
        self.assertIn("--repo-refresh",calls[1][0])

    def test_assignment_preload_runs_after_checkout_without_grant_and_requires_ack(self):
        r, checkout = assigned()
        witness = r["assignmentPreload"]
        calls = []
        def run(cfg, argv, **kwargs):
            calls.append((argv, kwargs))
            answer = [b"ezil-cli-bootstrap:ok", output(r, folder=checkout), b"ezil-assignment-preload:ack\n"][len(calls) - 1]
            return subprocess.CompletedProcess(argv, 0, answer)
        with mock.patch.object(desktop, "exec_", side_effect=run):
            result, uncertain = rt.execute(None, {}, r, ready=lambda *args: True, clock=lambda: 0, wall=lambda: NOW)
        self.assertFalse(uncertain)
        self.assertEqual(result["assignmentPreload"], {"eventId": witness["eventId"], "nonce": witness["nonce"],
                                                        "port": 5679, "status": "acknowledged"})
        self.assertEqual(calls[2][0][-1], checkout)
        self.assertEqual(json.loads(calls[2][1]["input"]), witness)
        self.assertNotIn(SECRET, repr(calls[2]))
        self.assertNotIn(witness["nonce"], repr(calls[2][0]))
        rejected = [subprocess.CompletedProcess([], 0, answer)
                    for answer in (b"ezil-cli-bootstrap:ok", output(r, folder=checkout), b"wrong")]
        with mock.patch.object(desktop, "exec_", side_effect=rejected):
            result, uncertain = rt.execute(None, {}, r, ready=lambda *args: True, clock=lambda: 0, wall=lambda: NOW)
        self.assertFalse(uncertain)
        self.assertEqual(result["diagnosticReason"], "invalid_result")
        self.assertNotIn("assignmentPreload", result)

    def test_supervisor_refusal_has_no_uncertain_writer_or_quarantine(self):
        for reason in ("repo_open_workspace_unavailable","repo_open_folder_conflict"):
            responses=[subprocess.CompletedProcess([],0,b"ezil-cli-bootstrap:ok"),
                       subprocess.CompletedProcess([],0,("ezil-repo-open:error:"+reason+"\n").encode())]
            with mock.patch.object(desktop,"exec_",side_effect=responses):
                result,uncertain=rt.execute(None,{},fresh(),ready=lambda*a:True,clock=lambda:0,wall=lambda:NOW)
            self.assertFalse(result["ok"]);self.assertFalse(uncertain)

    def test_closed_failure_diagnostics_preserve_cleanup_and_never_echo_messages(self):
        supervisor = {
            "repo_open_invalid_request": "invalid_request", "repo_open_workspace_unavailable": "workspace_unavailable",
            "repo_open_workspace_not_ready": "workspace_not_ready", "repo_open_folder_conflict": "folder_conflict",
            "repo_open_git_missing": "bootstrap_unavailable", "repo_open_busy": "checkout_busy",
        }
        cli = {
            "invalid-repository": "invalid_request", "invalid-arguments": "invalid_request",
            "invalid-directory": "workspace_unavailable", "repository-not-authorized": "repository_not_authorized",
            "destination-conflict": "folder_conflict", "destination-busy": "checkout_busy",
            "repository-ref-mismatch": "ref_mismatch", "clone-failed": "clone_failed",
        }
        poison = "provider detail https://private.invalid/not-for-feedback"
        cases = [(0, ("ezil-repo-open:error:" + code + "\n").encode(), reason) for code, reason in supervisor.items()]
        cases += [(2, json.dumps({"error": {"code": code, "message": poison}}).encode(), reason) for code, reason in cli.items()]
        for code, raw, reason in cases:
            with self.subTest(reason=reason, raw=raw):
                responses = [subprocess.CompletedProcess([], 0, b"ezil-cli-bootstrap:ok"), subprocess.CompletedProcess([], code, raw)]
                with mock.patch.object(desktop, "exec_", side_effect=responses):
                    result, uncertain = rt.execute(None, {}, fresh(), ready=lambda *a: True, clock=lambda: 0, wall=lambda: NOW)
                self.assertEqual(result["diagnosticReason"], reason)
                self.assertFalse(uncertain)
                self.assertEqual(set(result), {"ok", "error", "diagnosticReason"})
                self.assertNotIn(poison, json.dumps(result)); self.assertNotIn(SECRET, json.dumps(result))

    def test_unknown_output_and_private_timeout_keep_uncertain_writer_fence(self):
        for code, raw, reason in [(0, b'{"unexpected":"private"}', "invalid_result"),
                                  (126, b"private exception detail", "cleanup_unconfirmed"),
                                  (125, b"private preflight exception", "supervisor_unavailable"),
                                  (2, json.dumps({"error": {"code": "clone-failed", "message": SECRET}}).encode(), "cleanup_unconfirmed")]:
            responses = [subprocess.CompletedProcess([], 0, b"ezil-cli-bootstrap:ok"), subprocess.CompletedProcess([], code, raw)]
            with mock.patch.object(desktop, "exec_", side_effect=responses):
                result, uncertain = rt.execute(None, {}, fresh(), ready=lambda *a: True, clock=lambda: 0, wall=lambda: NOW)
            self.assertTrue(uncertain); self.assertEqual(result["diagnosticReason"], reason)
            self.assertNotIn("private", json.dumps(result)); self.assertNotIn(SECRET, json.dumps(result))
        with mock.patch.object(desktop, "exec_", side_effect=[subprocess.CompletedProcess([], 0, b"ezil-cli-bootstrap:ok"),
                                                             subprocess.TimeoutExpired("private", 1)]):
            result, uncertain = rt.execute(None, {}, fresh(), ready=lambda *a: True, clock=lambda: 0, wall=lambda: NOW)
        self.assertTrue(uncertain); self.assertEqual(result["diagnosticReason"], "cleanup_unconfirmed")

    def test_bootstrap_failure_is_closed_and_cannot_leave_a_git_writer(self):
        for response in [OSError("private provider exception"), subprocess.CompletedProcess([], 1, SECRET.encode())]:
            with mock.patch.object(desktop, "exec_", side_effect=[response]) as run:
                result, uncertain = rt.execute(None, {}, fresh(), ready=lambda *a: True, clock=lambda: 0, wall=lambda: NOW)
            self.assertEqual(result, {"ok": False, "error": "repo_open_git_missing", "diagnosticReason": "bootstrap_unavailable"})
            self.assertFalse(uncertain); self.assertEqual(run.call_count, 1)

    def test_failure_reason_allowlist_matches_worker_and_rejects_arbitrary_values(self):
        import re
        source = (HERE.parents[2] / "worker/src/aws-repo-open.ts").read_text()
        values = re.search(r"REPO_OPEN_DIAGNOSTIC_REASONS = \[(.*?)\] as const", source, re.S).group(1)
        self.assertEqual(set(re.findall(r"'([^']+)'", values)), sg.DIAGNOSTIC_REASONS)
        for reason in [SECRET, "provider said failed", "https://private.invalid"]:
            with self.assertRaises(ValueError): sg.failure("repo_open_failed", reason)

    def test_only_private_stdin_has_packet_not_argv_environment_file(self):
        r=fresh();calls=[]
        def run(cfg,argv,**kw):
            calls.append((argv,kw));self.assertNotIn(SECRET,repr(argv));self.assertNotIn("env",kw)
            self.assertIs(kw["stderr"],subprocess.DEVNULL)
            return subprocess.CompletedProcess(argv,0,b"ezil-cli-bootstrap:ok\n" if len(calls)==1 else output(r))
        with mock.patch.object(desktop,"exec_",side_effect=run):
            result,uncertain=rt.execute(None,{},r,ready=lambda*a:True,clock=lambda:0,wall=lambda:NOW)
        self.assertTrue(result["ok"]);self.assertFalse(uncertain)
        self.assertIs(calls[0][1]["stdin"],subprocess.DEVNULL)
        self.assertEqual(json.loads(calls[1][1]["input"]),{**r["privatePacket"],"gitAccess":True})

    def test_unknown_cleanup_quarantines_but_confirmed_refusal_does_not(self):
        r=fresh()
        for code,raw,want in [(126,b"",True),(2,b'{"error":{"code":"repository-ref-mismatch","message":"fixed"}}',False)]:
            responses=[subprocess.CompletedProcess([],0,b"ezil-cli-bootstrap:ok"),subprocess.CompletedProcess([],code,raw)]
            with mock.patch.object(desktop,"exec_",side_effect=responses):
                result,uncertain=rt.execute(None,{},r,ready=lambda*a:True,clock=lambda:0,wall=lambda:NOW)
            self.assertFalse(result["ok"]);self.assertEqual(uncertain,want)
        with mock.patch.object(desktop,"exec_",side_effect=[subprocess.CompletedProcess([],0,b"ezil-cli-bootstrap:ok"),subprocess.TimeoutExpired("fixed",1)]):
            self.assertTrue(rt.execute(None,{},r,ready=lambda*a:True,clock=lambda:0,wall=lambda:NOW)[1])
        with mock.patch.object(desktop,"exec_",side_effect=subprocess.TimeoutExpired("public",1)) as run:
            self.assertFalse(rt.execute(None,{},r,ready=lambda*a:True)[1]);self.assertEqual(run.call_count,1)

    def test_readiness_rechecked_before_private_exec(self):
        r=fresh()
        with mock.patch.object(desktop,"exec_",return_value=subprocess.CompletedProcess([],0,b"ezil-cli-bootstrap:ok")) as run:
            result,uncertain=rt.execute(None,{},r,ready=mock.Mock(side_effect=[True,False]),clock=lambda:0,wall=lambda:NOW)
            self.assertEqual(result["error"],"runtime_not_running");self.assertFalse(uncertain);self.assertEqual(run.call_count,1)

    def test_real_anonymous_stdin_reaches_fd3_not_eof_and_stdin_devnull(self):
        with tempfile.TemporaryDirectory() as directory:
            stub=Path(directory)/"supervisor.py"
            stub.write_text("import os,stat,sys,hashlib,json\nb=b''\nwhile True:\n c=os.read(3,4096)\n if not c: break\n b+=c\nprint(json.dumps({'fifo':stat.S_ISFIFO(os.fstat(3).st_mode),'sha':hashlib.sha256(b).hexdigest(),'stdin':os.read(0,1).hex(),'leak':b.decode() in repr(sys.argv)+repr(dict(os.environ))}))\n")
            adapter=rt.FD_ADAPTER.replace("'/run/ezil/bin/supervise.py'",repr(str(stub)))
            raw=json.dumps(fresh()["privatePacket"]).encode()
            p=subprocess.run([sys.executable,"-I","-c",adapter,"1000"],input=raw,capture_output=True,timeout=4)
            self.assertEqual(p.returncode,0,p.stderr)
            v=json.loads(p.stdout);self.assertTrue(v["fifo"]);self.assertEqual(v["sha"],hashlib.sha256(raw).hexdigest())
            self.assertEqual(v["stdin"],"");self.assertFalse(v["leak"])

class JobAdmission(unittest.TestCase):
    def test_admits_once_fast_and_status_contains_no_packet_or_token(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg=SimpleNamespace(runDir=directory);release=threading.Event();started=threading.Event()
            def run(*a):
                started.set();release.wait(2)
                return {"ok":True,"folder":"/workspace/projects/"+RID,"status":"fetched"},False
            jobs=sg.Jobs(cfg,{},runner=run,ready=lambda*a:True,clock=lambda:NOW)
            t=time.monotonic();self.assertEqual(jobs.start(fresh()),{"ok":True,"state":"running"})
            self.assertLess(time.monotonic()-t,.3);self.assertTrue(started.wait(1))
            self.assertEqual(jobs.start(fresh())["state"],"running")
            other=fresh();other["jobId"]="c"*64
            self.assertEqual(jobs.start(other)["error"],"workspace_busy")
            self.assertEqual(Path(jobs.marker).read_text(),"b"*64)
            self.assertNotIn(SECRET,repr(jobs.status("b"*64)))
            release.set()
            for _ in range(100):
                if jobs.status("b"*64)["state"]=="done":break
                time.sleep(.01)
            self.assertEqual(jobs.status("b"*64)["result"]["status"],"fetched")
            self.assertFalse(jobs.active())

    def test_uncertain_marker_survives_new_manager_and_no_user_files_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg=SimpleNamespace(runDir=directory);dirty=Path(directory)/"dirty";dirty.write_text("preserve")
            jobs=sg.Jobs(cfg,{},runner=lambda*a:({"ok":False,"error":"repo_open_timeout"},True),ready=lambda*a:True,clock=lambda:NOW)
            jobs.start(fresh())
            for _ in range(100):
                if jobs.status("b"*64)["state"]=="done":break
                time.sleep(.01)
            self.assertTrue(jobs.active())
            restarted=sg.Jobs(cfg,{},ready=lambda*a:True,clock=lambda:NOW)
            self.assertEqual(restarted.start(fresh())["error"],"workspace_busy")
            self.assertEqual(dirty.read_text(),"preserve")

class InstalledLayout(unittest.TestCase):
    def test_actual_recursive_install_line_preserves_assets_from_unrelated_cwd(self):
        root=HERE.parents[2]
        script=(HERE.parent/"ami/build-host-ami.sh").read_text()
        lines=[line for line in script.splitlines() if line.startswith('cp -a "$AGENT_SRC/bin" "$AGENT_SRC/lib" ')]
        self.assertEqual(len(lines),1)
        self.assertEqual(lines[0],'cp -a "$AGENT_SRC/bin" "$AGENT_SRC/lib" /opt/ezil-host/')
        with tempfile.TemporaryDirectory() as directory:
            installed=Path(directory)/"installed";installed.mkdir()
            command=lines[0].replace("/opt/ezil-host/",'"$INSTALL_TARGET/"')
            subprocess.run(["bash","-c",command],env={**os.environ,"AGENT_SRC":str(HERE.parent),"INSTALL_TARGET":str(installed)},
                           check=True,stdin=subprocess.DEVNULL,capture_output=True)
            public="import sys,json,hashlib,base64;sys.path.insert(0,sys.argv[1]);from ezil_host import standalone_git_runtime as r;p,a=r.runtime_command();print(json.dumps({'cli':p['cliSha256'],'stage':hashlib.sha256((r.ASSETS/'stage.py').read_bytes()).hexdigest(),'supervisor':hashlib.sha256(base64.b64decode(a[-1])).hexdigest()}))"
            got=json.loads(subprocess.check_output([sys.executable,"-I","-c",public,str(installed/"lib")],cwd=directory))
            self.assertEqual(got["cli"],"add3f83cef4b35e8a65f43af3d4ad8ed745c5fa25b6d728b21ad8f0500d63049")
            self.assertEqual(got["stage"],hashlib.sha256((root/"worker/repo-open/stage.py").read_bytes()).hexdigest())
            self.assertEqual(got["supervisor"],hashlib.sha256((rt.ASSETS/"supervise.py").read_bytes()).hexdigest())

class SupervisorCancellation(unittest.TestCase):
    def test_real_reviewed_supervisor_reaps_escaped_child_and_suppresses_success(self):
        with tempfile.TemporaryDirectory() as directory:
            marker=Path(directory)/"owned-child"
            child="import os,signal,time,sys\np=os.fork()\nif p==0:\n os.setsid();signal.signal(signal.SIGTERM,signal.SIG_IGN)\n open(sys.argv[1],'w').write(str(os.getpid())+' '+open('/proc/self/stat').read().split()[21])\n while True:time.sleep(1)\nwhile not os.path.exists(sys.argv[1]):time.sleep(.005)\nprint('{\"status\":\"cloned\"}',flush=True)\nos._exit(0)\n"
            adapter=rt.FD_ADAPTER.replace("'/run/ezil/bin/supervise.py'",repr(str(rt.ASSETS/"supervise.py")))
            before=time.monotonic()
            p=subprocess.run([sys.executable,"-I","-c",adapter,"250","100",sys.executable,"-c",child,str(marker)],
                             input=json.dumps(fresh()["privatePacket"]).encode(),capture_output=True,timeout=3)
            try:
                self.assertEqual(p.returncode,126,p.stderr);self.assertEqual(p.stdout,b"")
                self.assertLess(time.monotonic()-before,2)
                self.assertTrue(marker.exists())
                pid,start=marker.read_text().split()
                live=Path("/proc",pid,"stat")
                self.assertTrue(not live.exists() or live.read_text().split()[21]!=start,"owned escaped child was not reaped")
            finally:
                if marker.exists():
                    pid,start=marker.read_text().split()
                    live=Path("/proc",pid,"stat")
                    if live.exists() and live.read_text().split()[21]==start:
                        os.kill(int(pid),9)

class MoreAdmission(unittest.TestCase):
    def test_id_reuse_with_different_packet_and_restart_unknown_never_licenses_new_job(self):
        with tempfile.TemporaryDirectory() as d:
            release=threading.Event()
            def runner(*args):
                release.wait(1)
                return {"ok":False,"error":"repo_open_timeout"},True
            jobs=sg.Jobs(SimpleNamespace(runDir=d),{},runner=runner,ready=lambda*a:True,clock=lambda:NOW)
            jobs.start(fresh())
            changed=fresh();changed["privatePacket"]["repository"]["ref"]="refs/heads/other"
            self.assertEqual(jobs.start(changed)["error"],"job_replayed")
            new=sg.Jobs(SimpleNamespace(runDir=d),{},ready=lambda*a:True,clock=lambda:NOW)
            self.assertEqual(new.status("b"*64),{"ok":False,"error":"job_unknown"})
            self.assertEqual(new.start(fresh())["error"],"workspace_busy")
            release.set()
            for _ in range(100):
                if jobs.status("b"*64)["state"]=="done":break
                time.sleep(.01)

    def test_bootstrap_budget_is_charged_before_private_input(self):
        moments=iter([0,0,45])
        with mock.patch.object(desktop,"exec_",return_value=subprocess.CompletedProcess([],0,b"ezil-cli-bootstrap:ok")) as run:
            result,uncertain=rt.execute(None,{},fresh(),ready=lambda*a:True,clock=lambda:next(moments),wall=lambda:NOW+45)
        self.assertEqual(result["error"],"repo_open_timeout");self.assertFalse(uncertain);self.assertEqual(run.call_count,1)
