"""Offline standalone Git gates: no Docker, hosts, AWS or external network."""
import copy, hashlib, json, os, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))
from ezil_host import standalone_git as sg, standalone_git_runtime as rt, agent, desktop

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
    return json.dumps({"canonicalUrl":p["repository"]["canonicalURL"],"folder":"/workspace/projects/"+RID+"/repository",
                       "repository":p["repository"],"identity":p["identity"],"status":"reused",**changes}).encode()

class Packet(unittest.TestCase):
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
        for name in ("stage.py","supervise.py"):
            self.assertEqual((rt.ASSETS/name).read_bytes(),(root/"worker/repo-open"/name).read_bytes())
        pin,argv=rt.runtime_command()
        self.assertEqual(pin["cliSha256"],"3b88146b48d73637274f9e4d42ed139cbc2d9b0b93f3bad6236fd23a66c919c4")
        self.assertNotIn(SECRET,repr(argv))

class Runtime(unittest.TestCase):
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
        self.assertEqual(json.loads(calls[1][1]["input"]),r["privatePacket"])

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
            self.assertEqual(got["cli"],"3b88146b48d73637274f9e4d42ed139cbc2d9b0b93f3bad6236fd23a66c919c4")
            self.assertEqual(got["stage"],hashlib.sha256((root/"worker/repo-open/stage.py").read_bytes()).hexdigest())
            self.assertEqual(got["supervisor"],hashlib.sha256((root/"worker/repo-open/supervise.py").read_bytes()).hexdigest())

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
