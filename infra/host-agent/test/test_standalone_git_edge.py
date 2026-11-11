"""Offline signed edge framing, live guard epoch and lifecycle-lock deadline tests."""
import copy, hashlib, json, os, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/"lib"));sys.path.insert(0,str(HERE))
from ezil_host import standalone_git as sg, edge, agent, desktop
from test_standalone_git import NOW, CID, SECRET, fresh

class Head:
    def __init__(self,raw=b"",headers=None,method="POST",target="/fixture"):
        self.rest=raw;self.method=method;self.target=target
        self.headers=headers if headers is not None else {"content-length":[str(len(raw))]}
    def get(self,k):return self.headers.get(k,[])

class Framing(unittest.TestCase):
    def call(self,h,identifier=None,query="",status=False,result=None):
        raw=h.rest
        e=object.__new__(edge.Edge);e.clock=lambda:NOW
        e.seq=SimpleNamespace(send=mock.Mock(return_value=result or {"ok":True,"state":"running"}))
        with mock.patch.object(edge,"_reply") as reply:
            e._standalone_repo(None,h,identifier or hashlib.sha256(raw).hexdigest(),query,status)
        return reply.call_args.args[1:],e.seq.send

    def test_valid_digest_admission_and_status_are_closed_and_fast(self):
        raw=json.dumps(fresh()).encode()
        (code,value),send=self.call(Head(raw))
        self.assertEqual(code,202);self.assertEqual(value,{"ok":True,"state":"running"})
        self.assertEqual(send.call_args.args,("standalone-repo-open",))
        self.assertEqual(send.call_args.kwargs,{"request":fresh()})
        (code,value),send=self.call(Head(headers={},method="GET"),identifier="b"*64,status=True)
        self.assertEqual(code,200);self.assertEqual(send.call_args.kwargs,{"jobId":"b"*64})

    def test_bad_framing_digest_schema_scope_never_reach_agent(self):
        raw=json.dumps(fresh()).encode()
        bad=copy.deepcopy(fresh());bad["privatePacket"]["git"]["scope"]="admin"
        cases=[(Head(raw,{"content-length":[str(len(raw)),str(len(raw))]}),None,""),
               (Head(raw,{"content-length":[str(len(raw))],"transfer-encoding":["chunked"]}),None,""),
               (Head(raw),None,"?x=1"),(Head(raw),"0"*64,""),
               (Head(raw+b"x",{"content-length":[str(len(raw))]}),hashlib.sha256(raw).hexdigest(),""),
               (Head(json.dumps(bad).encode()),None,""),(Head(raw,{}),None,"")]
        for h,digest,query in cases:
            (code,value),send=self.call(h,digest,query)
            self.assertEqual(code,400);send.assert_not_called();self.assertNotIn(SECRET,repr(value))

    def test_status_refuses_body_and_unknown_job_is_not_success(self):
        (code,_),send=self.call(Head(headers={"content-length":["0"]},method="GET"),"b"*64,status=True)
        self.assertEqual(code,400);send.assert_not_called()
        (code,value),_=self.call(Head(headers={},method="GET"),"b"*64,status=True,result={"ok":False,"error":"job_unknown"})
        self.assertEqual((code,value),(409,{"ok":False,"error":"job_unknown"}))

    def test_unauthenticated_request_never_invokes_new_agent_operation(self):
        e=object.__new__(edge.Edge);e.clock=lambda:NOW;e.key=b"k"*32
        e.binding={"computerId":CID,"generation":1,"leaseEpoch":2}
        e.seq=SimpleNamespace(presence=mock.Mock(),send=mock.Mock())
        h=Head(headers={},target="/__ezil/control/standalone-repo-open/"+"b"*64)
        with mock.patch.object(edge,"read_head",return_value=h),mock.patch.object(edge,"_reply") as reply:
            e.handle(SimpleNamespace(settimeout=lambda*n:None))
        self.assertEqual(reply.call_args.args[1],401);e.seq.send.assert_not_called()

def host_fixture(root):
    cfg=SimpleNamespace(stateDir=str(root/"state"),runDir=str(root/"run"),dataMount=str(root/"data"),
                        runcBin=str(root/"runc"),containerId="fixture",stopWarnSeconds=0)
    for p in (cfg.stateDir,cfg.runDir,cfg.dataMount):Path(p).mkdir()
    lease={"computerId":CID,"volumeId":"vol-fixture","fsUuid":CID,"generation":1,"leaseEpoch":2}
    Path(cfg.stateDir,"control.key").write_bytes(b"k"*32)
    Path(cfg.runDir,"guard-ok").write_text(json.dumps({"generation":1,"leaseEpoch":2}))
    Path(cfg.dataMount,".ezil-marker.json").write_text(json.dumps(lease))
    return cfg,lease

class HostGuard(unittest.TestCase):
    def test_wrong_volume_epoch_fence_or_quiesce_refuses_before_exec(self):
        with tempfile.TemporaryDirectory() as d:
            cfg,lease=host_fixture(Path(d))
            with mock.patch.object(sg.subprocess,"run",return_value=subprocess.CompletedProcess([],0)),\
                 mock.patch.object(desktop,"runc",return_value=subprocess.CompletedProcess([],0,'{"status":"running"}')):
                self.assertTrue(sg.host_ready(cfg,lease))
                for field in ("volumeId","fsUuid","generation","leaseEpoch"):
                    other={**lease,field:"wrong"}
                    self.assertFalse(sg.host_ready(cfg,other))
                for marker in (desktop.STOPPING,desktop.EXPORT_QUIESCE,"shutdown-pending"):
                    p=Path(cfg.runDir,marker);p.touch();self.assertFalse(sg.host_ready(cfg,lease));p.unlink()

    def test_actual_hung_runc_readiness_is_bounded_and_cannot_starve_stop(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);cfg,lease=host_fixture(root)
            Path(cfg.runcBin).write_text("#!"+sys.executable+"\nimport time\ntime.sleep(5)\n");os.chmod(cfg.runcBin,0o700)
            a=agent.Agent(cfg,lease,clock=lambda:NOW,log=lambda*x:None)
            real_run=subprocess.run
            def bounded(cmd,*args,**kw):
                if cmd[0]=="mountpoint":
                    self.assertEqual(kw["timeout"],.5);return subprocess.CompletedProcess(cmd,0)
                self.assertEqual(kw["timeout"],.5);return real_run(cmd,*args,**kw)
            def signed(op,seq,**fields):
                m={"op":op,"seq":seq,"ts":NOW,"leaseEpoch":2,**fields};m["mac"]=agent.sign(a.key,m)
                return json.dumps(m).encode()
            replies=[];start=time.monotonic()
            with mock.patch.object(sg.subprocess,"run",side_effect=bounded),mock.patch.object(desktop,"exec_") as run:
                t=threading.Thread(target=lambda:replies.append(a.handle(signed("standalone-repo-open",1,request=fresh()))))
                t.start();time.sleep(.05)
                self.assertTrue(a.handle(signed("stop",2))["ok"]);t.join(2);run.assert_not_called()
            self.assertLess(time.monotonic()-start,1.5)
            self.assertEqual(replies,[{"ok":False,"error":"runtime_not_running"}])
            self.assertEqual(a.stop_request["kind"],"stop")

if __name__=="__main__":unittest.main()

class ClosedReplies(unittest.TestCase):
    call=Framing.call
    def test_arbitrary_agent_fields_cannot_echo_secret(self):
        h=Head(json.dumps(fresh()).encode())
        (code,value),_=self.call(h,result={"ok":True,"state":"running","debug":SECRET})
        self.assertEqual(code,503);self.assertNotIn(SECRET,repr(value))
        (code,value),_=self.call(Head(headers={},method="GET"),"b"*64,status=True,
                               result={"ok":True,"state":"done","result":{"ok":True,"folder":"/workspace","status":SECRET}})
        self.assertEqual(code,503);self.assertNotIn(SECRET,repr(value))
