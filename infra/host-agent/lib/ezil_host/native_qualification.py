"""Root-only qualification of the installed native Host on its AWS lease.

The manual challenge and qualify commands exchange local root-only files with the
operator. For a provisioned pilot, qualify-via-os uses the existing enrollment
origin and epoch key. Only enable the optional timer on the configured computer.
"""
import argparse
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import selectors
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import ExitStack
from pathlib import Path

from http.client import HTTPException
from urllib.parse import urlsplit

from . import config, enroll, guard, http, native_artifact, native_authority as authority
from . import native_isolation as isolation, native_session, storage
from .fsops import Refused, unlink_durable_at, write_file_durable_at
from .lease import strict_json

CHALLENGE = "qualification-challenge.json"
RECEIPT = "qualification-receipt.json"
DOMAIN = b"ezil-native-qualification-placement-v1|"
REQUEST_DOMAIN = b"ezil-native-qualification-request-v1|"
MAX_AGE_MS = 300_000
FUTURE_SKEW_MS = 5_000
CONFIG_PATH = "/etc/ezil-host/agent.json"
CHALLENGE_KEYS = {"v", "computerId", "bootId", "placement", "profileDigest", "manifestSha256", "nonce", "issuedAt", "expiresAt"}
RECEIPT_KEYS = CHALLENGE_KEYS | {"ownerUserId"}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def now_ms():
    return int(time.time() * 1000)


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def private_json(directory_fd, name):
    raw = isolation._read_private_record(directory_fd, name)
    require(raw is not None, "native_qualification_input_untrusted")
    return strict_json(raw.decode("utf-8"))


def live_target(cfg, artifact):
    # Keep all lease, identity and enrollment read paths below the real trusted run directory.
    os.close(native_artifact.trusted_directory(cfg.runDir))
    lease = enroll.load_lease(cfg)
    require(isinstance(lease, dict), "native_qualification_no_lease")
    require(not os.path.lexists(os.path.join(cfg.runDir, "stopping")), "native_qualification_host_stopping")
    guard_digest = guard.require_stamp(cfg, lease)
    local = storage.identity(lease)
    boot_id = isolation.boot_id()
    instance_id = guard.current_instance_id(cfg)
    require(local is not None and boot_id is not None and instance_id is not None,
            "native_qualification_no_lease")
    computer_id, generation, lease_epoch = local
    placement = {"generation": str(generation), "leaseEpoch": str(lease_epoch), "instanceId": instance_id}
    return lease, guard_digest, {"v": 1, "computerId": computer_id, "bootId": boot_id, "placement": placement,
            "profileDigest": native_session.POLICY_DIGEST, "manifestSha256": artifact["manifestSha256"]}


def validate_receipt(envelope, challenge, target, control_key, current_ms):
    require(isinstance(challenge, dict) and set(challenge) == CHALLENGE_KEYS and type(challenge["v"]) is int
            and all(challenge.get(key) == value for key, value in target.items()),
            "native_qualification_target_changed")
    require(isinstance(envelope, dict) and set(envelope) == {"receipt", "signature"},
            "native_qualification_receipt_invalid")
    receipt, signature = envelope["receipt"], envelope["signature"]
    require(isinstance(receipt, dict) and set(receipt) == RECEIPT_KEYS and type(receipt["v"]) is int
            and isinstance(signature, str) and re.fullmatch(r"v1=[0-9a-f]{64}", signature) is not None
            and isinstance(control_key, bytes) and len(control_key) == 32,
            "native_qualification_receipt_invalid")
    mac = hmac.new(control_key, DOMAIN + digest(authority.canonical(receipt)).encode("ascii"), hashlib.sha256)
    require(hmac.compare_digest(signature, "v1=" + mac.hexdigest()), "native_qualification_receipt_mac")
    for field in ("v", "computerId", "bootId", "profileDigest", "manifestSha256", "nonce"):
        require(receipt[field] == challenge[field], "native_qualification_target_changed")
    require(isinstance(receipt["ownerUserId"], str) and authority.UUID.fullmatch(receipt["ownerUserId"])
            and isinstance(receipt["nonce"], str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", receipt["nonce"])
            and authority.valid_placement(receipt["placement"])
            and all(receipt["placement"][key] == value for key, value in target["placement"].items()),
            "native_qualification_target_changed")
    ci, ce = (authority.parse_ms(challenge[key]) for key in ("issuedAt", "expiresAt"))
    ri, re_ = (authority.parse_ms(receipt[key]) for key in ("issuedAt", "expiresAt"))
    require(all(value is not None for value in (ci, ce, ri, re_))
            and ci <= ri <= current_ms + FUTURE_SKEW_MS and current_ms < re_ <= ce
            and ce - ci <= MAX_AGE_MS and ri < re_,
            "native_qualification_receipt_expired")
    return receipt


def read_control_key(cfg, placement):
    directory_fd = native_artifact.trusted_directory(cfg.stateDir)
    try:
        record = private_json(directory_fd, enroll.ENROLLED_FILE)
        require(isinstance(record, dict) and record.get("instanceId") == placement["instanceId"]
                and str(record.get("generation")) == placement["generation"]
                and str(record.get("leaseEpoch")) == placement["leaseEpoch"],
                "native_qualification_enrollment_changed")
        key = isolation._read_private_record(directory_fd, enroll.KEY_FILE)
        require(key is not None and len(key) == 32, "native_qualification_enrollment_changed")
        return key
    finally:
        os.close(directory_fd)


def load_config():
    directory_fd = native_artifact.trusted_directory(os.path.dirname(CONFIG_PATH))
    try:
        st = os.stat(os.path.basename(CONFIG_PATH), dir_fd=directory_fd, follow_symlinks=False)
        require(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022,
                "native_qualification_config_untrusted")
        return config.load(CONFIG_PATH)
    finally:
        os.close(directory_fd)


# These fixed scripts run with a clean environment and accept only internally derived inputs.
TLS_PROBE = r"""
const tls = require('node:tls');
const fs = require('node:fs');
const {createHash, X509Certificate} = require('node:crypto');
const {origin, ca, spki} = JSON.parse(fs.readFileSync(0, 'utf8'));
const url = new URL(origin);
if (url.protocol !== 'https:' || url.origin !== origin || (url.port && url.port !== '443')) process.exit(2);
const socket = tls.connect({host:url.hostname, port:443, servername:url.hostname, ca, minVersion:'TLSv1.2',
  checkServerIdentity(host, cert) {
    const error = tls.checkServerIdentity(host, cert);
    if (error) return error;
    const der = new X509Certificate(cert.raw).publicKey.export({type:'spki',format:'der'});
    if (createHash('sha256').update(der).digest('base64') !== spki) return new Error('SPKI mismatch');
  }
});
socket.setTimeout(7000, () => socket.destroy(new Error('TLS timeout')));
socket.once('error', () => process.exit(3));
socket.once('secureConnect', () => {
  if (!socket.authorized) process.exit(4);
  const cert = socket.getPeerCertificate();
  const der = new X509Certificate(cert.raw).publicKey.export({type:'spki',format:'der'});
  const observed = {caSha256:createHash('sha256').update(ca).digest('hex'),
    spkiSha256:createHash('sha256').update(der).digest('base64'), gatewayOrigin:url.origin,
    peerCertificateSha256:createHash('sha256').update(cert.raw).digest('hex'), tlsProtocol:socket.getProtocol()};
  console.log(JSON.stringify(observed));
  socket.end();
  setTimeout(() => socket.destroy(), 500).unref();
});
"""
REFUSAL_RELAY = r"""
const http = require('node:http');
const {pathToFileURL} = require('node:url');
const {createHash} = require('node:crypto');
const wire = new (require('node:net').Socket)({fd:3, readable:true, writable:true});
const {credential, contract} = JSON.parse(process.argv[1]);
const report = value => wire.write(JSON.stringify(value) + '\n');
(async () => {
  const {readPrivateCredential} = await import(pathToFileURL(contract).href);
  const protectedValue = await readPrivateCredential(credential);
  const credentialSha256 = createHash('sha256').update(protectedValue).digest('hex');
  const server = http.createServer((req, res) => {
    report({event:'closed_http_refusal', status:401});
    const body = '{"type":"error","error":{"type":"authentication_error","message":"offline qualification refusal"}}';
    req.resume();
    res.writeHead(401, {'content-type':'application/json','content-length':Buffer.byteLength(body),'connection':'close'});
    res.end(body);
  });
  server.requestTimeout = 5000;
  server.listen(0, '127.0.0.1', () => report({event:'ready', port:server.address().port,
    credentialSha256, serviceUid:process.getuid(), serviceGid:process.getgid(), cwd:process.cwd()}));
})().catch(() => process.exit(2));
wire.on('end', () => process.exit(0));
"""
WORKSPACE_PROBE = r"""
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
if (process.getuid() !== 1000 || process.getgid() !== 1000 || process.cwd() !== process.argv[1]) process.exit(2);
const devices = {};
for (const name of fs.readdirSync('/dev')) {
  const st = fs.lstatSync('/dev/' + name);
  if (st.isCharacterDevice()) devices[name] = st.rdev;
}
const expected = {null:259,random:264,urandom:265,zero:261};
if (Object.entries(expected).some(([name, device]) => devices[name] !== device) ||
    Object.entries(devices).some(([name, device]) => !(name in expected) &&
      (!['full', 'tty'].includes(name) || device !== expected.null))) process.exit(3);
try { fs.statSync(process.argv[2]); process.exit(4); } catch (err) { if (err.code !== 'ENOENT') process.exit(5); }
fs.writeFileSync('qualification.js', 'console.log("ezil-native-build-qualified")\n', {flag:'wx',mode:0o600});
const checked = spawnSync(process.execPath,['--check','qualification.js'],{timeout:3000});
const built = spawnSync(process.execPath,['qualification.js'],{timeout:3000});
if (checked.status !== 0 || built.status !== 0 || built.stdout.toString() !== 'ezil-native-build-qualified\n') process.exit(6);
console.log(JSON.stringify({workloadUid:process.getuid(), devices,
  workspaceSha256:createHash('sha256').update(fs.readFileSync('qualification.js')).digest('hex'),
  buildSha256:createHash('sha256').update(built.stdout).digest('hex'), exitCode:built.status}));
"""


def measured_command(argv, *, data=None, timeout=10):
    clean_env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}
    return subprocess.run(argv, input=data, capture_output=True, text=True, check=True, timeout=timeout,
                          env=clean_env).stdout


def gateway_tls(cfg, netns, node):
    pins = {"origin": cfg.nativeGatewayOrigin, "ca": cfg.nativeGatewayCaPem, "spki": cfg.nativeGatewaySpkiSha256}
    report = strict_json(measured_command(["ip", "netns", "exec", netns, node, "-e", TLS_PROBE],
                                          data=json.dumps(pins)))
    require(report["caSha256"] == digest(pins["ca"].encode()) and report["spkiSha256"] == pins["spki"]
            and report["gatewayOrigin"] == pins["origin"], "native_qualification_tls_unverified")
    return report


def read_proc_status(pid):
    return dict(line.split(":", 1) for line in Path(f"/proc/{pid}/status").read_text().splitlines() if ":" in line)


def measure_uid(pid, uid_base, netns_path):
    status = read_proc_status(pid)
    expected = str(uid_base + 1000)
    uid_map = Path(f"/proc/{pid}/uid_map").read_text().split()
    gid_map = Path(f"/proc/{pid}/gid_map").read_text().split()
    require(status["Uid"].split() == [expected] * 4 and status["Gid"].split() == [expected] * 4
            and uid_map == gid_map == ["0", str(uid_base), "65536"]
            and status["NoNewPrivs"].strip() == "1" and int(status["CapEff"].strip(), 16) == 0,
            "native_qualification_uid_namespace_unverified")
    namespaces = {ns: os.stat(f"/proc/{pid}/ns/{ns}").st_ino for ns in ("user", "mnt", "pid", "net", "ipc", "uts", "cgroup")}
    require(all(value != os.stat(f"/proc/self/ns/{ns}").st_ino for ns, value in namespaces.items())
            and namespaces["net"] == os.stat(netns_path).st_ino, "native_qualification_uid_namespace_unverified")
    return {"outerUid": int(expected), "uidMap": uid_map, "gidMap": gid_map, "namespaces": namespaces,
            "effectiveCapabilities": 0, "noNewPrivileges": 1}


def measure_cgroup(cgroup, cli_pid, relay_pid):
    observed = {name: Path(cgroup.path, name).read_text().strip() for name in ("cpu.max", "memory.max", "pids.max")}
    require(observed == {"cpu.max": "200000 100000", "memory.max": str(4 << 30), "pids.max": "512"}
            and cli_pid in cgroup.child("cli").members() and relay_pid in cgroup.child("driver").members(),
            "native_qualification_cgroup_unverified")
    return dict(observed, cliPid=cli_pid, peerPid=relay_pid)


def fence_egress(plan):
    netns = plan["netns"]
    listing = measured_command(["ip", "netns", "exec", netns, "nft", "list", "table", "inet", "ezil_native"])
    require(listing.count("policy drop") == 2 and all(prefix in listing for prefix in isolation.DENIED_V4)
            and "meta nfproto ipv6 drop" in listing, "native_qualification_egress_unverified")
    # The isolated ACK phase has no external interface or route. TLS ran separately above.
    measured_command(["ip", "-n", netns, "link", "set", plan["vethNs"], "down"])
    links = strict_json(measured_command(["ip", "-n", netns, "-json", "link", "show"]))
    active = [link["ifname"] for link in links if "UP" in link["flags"]]
    require(active == ["lo"], "native_qualification_offline_network_unverified")
    return {"nftRuleSetSha256": digest(listing.encode()), "ackNetwork": "no-active-interface-except-loopback",
            "outputPolicy": "drop", "inputPolicy": "drop"}


def start_refusal_relay(launcher, rec, artifact, node, names, credential, reporter):
    cfg = launcher.cfg
    uid, gid = int(cfg.nativeServiceUid), int(cfg.nativeServiceGid)
    require(uid != 0 and gid != 0 and uid != int(cfg.nativeUidBase) + 1000,
            "native_qualification_peer_unverified")
    contract = os.path.join(os.path.dirname(os.path.join(artifact["dir"], artifact["core"])), "gatewayNativeContract.mjs")
    parent, child = socket.socketpair()
    reporter.callback(parent.close)
    try:
        argv = [node, "--disallow-code-generation-from-strings", "-e", REFUSAL_RELAY,
                json.dumps({"credential": credential, "contract": contract})]
        process = isolation.spawn_driver(argv, child, {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                                         cgroup_path=names["cgroup"].child("driver").path,
                                         netns_path=f"/var/run/netns/{names['plan']['netns']}", uid=uid, gid=gid)
    finally:
        child.close()
    entry = launcher.procs[rec["operationId"]]
    entry["popen"] = process
    entry["driver"] = isolation.identity(process.pid)
    require(launcher.procs[rec["operationId"]]["driver"] is not None, "native_qualification_peer_unverified")
    isolation.verify_direct_exe(process, node)
    parent.settimeout(7)
    wire = reporter.enter_context(parent.makefile("rb"))
    ready = strict_json(wire.readline(4097).decode())
    require(set(ready) == {"event", "port", "credentialSha256", "serviceUid", "serviceGid", "cwd"}
            and ready["event"] == "ready" and ready["serviceUid"] == uid and ready["serviceGid"] == gid
            and type(ready["port"]) is int and 1 <= ready["port"] <= 65535 and ready["cwd"] == "/",
            "native_qualification_peer_unverified")
    return process, ready, wire


class CliFrames:
    def __init__(self, fd):
        self.fd = fd
        self.buffer = b""
        self.bytes = 0

    def await_frame(self, expected, deadline):
        with selectors.DefaultSelector() as selector:
            selector.register(self.fd, selectors.EVENT_READ)
            while time.monotonic() < deadline:
                if b"\n" in self.buffer:
                    line, self.buffer = self.buffer.split(b"\n", 1)
                    require(len(line) < isolation.FRAME_LIMIT, "native_qualification_cli_stream_invalid")
                    frame = strict_json(line.decode())
                    if isinstance(frame, dict) and expected(frame):
                        return frame
                    continue
                if not selector.select(max(0, deadline - time.monotonic())):
                    break
                chunk = os.read(self.fd, 8192)
                self.buffer += chunk
                self.bytes += len(chunk)
                require(chunk and len(self.buffer) <= isolation.FRAME_LIMIT and self.bytes <= 2 << 20,
                        "native_qualification_cli_stream_invalid")
        raise Refused("native_qualification_cli_timeout")


def send_cli_frame(writer, frame):
    writer.write(authority.canonical(frame) + b"\n")
    writer.flush()


def make_probe_pipes(entry, stack):
    cli_in, probe_in = os.pipe2(os.O_CLOEXEC)
    probe_out, cli_out = os.pipe2(os.O_CLOEXEC)
    cli_err = os.open(os.devnull, os.O_WRONLY | os.O_CLOEXEC)
    entry["cliIo"] = (cli_in, cli_out, cli_err)
    stack.callback(os.close, probe_out)
    out = CliFrames(probe_out)
    return stack.enter_context(os.fdopen(probe_in, "wb")), out


def probe_cli(launcher, rec, artifact, port, workspace, leaves, credential, names, relay, stack):
    entry = launcher.procs[rec["operationId"]]
    writer, stream = make_probe_pipes(entry, stack)
    session = rec["sessionId"]
    model = native_session.PROFILE["model"]
    tools = native_session.PROFILE["tools"]
    args = ["--bare", "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--replay-user-messages", "--permission-mode", "acceptEdits", "--permission-prompt-tool", "stdio",
            "--setting-sources", "", "--strict-mcp-config", "--tools", ",".join(tools), "--model", model,
            "--session-id", session]
    env = {"HOME": leaves[0], "CLAUDE_CONFIG_DIR": leaves[1], "TMPDIR": leaves[2], "PATH": "/usr/bin:/bin",
           "USER": "ezil-native", "LOGNAME": "ezil-native", "LANG": "C.UTF-8",
           "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{port}", "ANTHROPIC_API_KEY": "qualification-offline-only",
           "CLAUDE_CODE_MAX_RETRIES": "0", "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
           "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_TELEMETRY": "1",
           "DISABLE_ERROR_REPORTING": "1", "DISABLE_AUTOUPDATER": "1"}
    exe = os.path.join(artifact["dir"], artifact["cli"])
    response = launcher.spawn_cli(rec, {"cwd": workspace, "args": args, "env": env, "executable": exe})
    pid = response["pid"]
    ancestry = launcher.capture_identity(rec, pid)
    installed = os.stat(exe)
    process_exe = os.stat(f"/proc/{pid}/exe")
    require((process_exe.st_dev, process_exe.st_ino) == (installed.st_dev, installed.st_ino),
            "native_qualification_cli_binary_mismatch")
    uid = measure_uid(pid, int(launcher.cfg.nativeUidBase), f"/var/run/netns/{names['plan']['netns']}")
    cgroup = measure_cgroup(names["cgroup"], pid, relay.pid)
    base = isolation.runc_cmd(launcher.cfg.runcBin, launcher.runc_root, "exec", "--user", "1000:1000",
                              "--no-new-privs", "--cwd", workspace, names["container"])
    version = measured_command([*base, exe, "--version"]).strip()
    require(version == artifact["cliVersion"] + " (Claude Code)", "native_qualification_cli_binary_mismatch")
    probe = strict_json(measured_command([*base, "/usr/bin/node", "-e", WORKSPACE_PROBE, workspace, credential]))
    source_hash = digest(Path(workspace, "qualification.js").read_bytes())
    require(source_hash == probe["workspaceSha256"] and probe["exitCode"] == 0 and probe["workloadUid"] == 1000,
            "native_qualification_build_unverified")

    initialize = str(uuid.uuid4())
    send_cli_frame(writer, {"type": "control_request", "request_id": initialize, "request": {"subtype": "initialize"}})
    init = stream.await_frame(lambda frame: frame.get("type") == "control_response"
                             and frame.get("response", {}).get("request_id") == initialize, time.monotonic() + 12)
    require(init["response"]["subtype"] == "success", "native_qualification_cli_init_refused")
    user_id = str(uuid.uuid4())
    send_cli_frame(writer, {"type": "user", "message": {"role": "user", "content": "Verify local acknowledgement."},
                            "session_id": "", "parent_tool_use_id": None, "uuid": user_id})
    deadline = time.monotonic() + 18
    system = stream.await_frame(lambda frame: frame.get("type") == "system" and frame.get("subtype") == "init", deadline)
    require(system.get("model") == model and system.get("permissionMode") == "acceptEdits"
            and system.get("session_id") == session, "native_qualification_cli_profile_changed")
    ack = stream.await_frame(lambda frame: frame.get("type") == "user" and frame.get("uuid") == user_id
                             and frame.get("session_id") == session, deadline)
    result = stream.await_frame(lambda frame: frame.get("type") == "result", deadline)
    require(result.get("is_error") is True, "native_qualification_offline_refusal_missing")
    prepared = entry["rootfsPreparation"]
    return {"uidNamespaces": uid, "cgroup": cgroup, "devices": {"kernelDeviceNumbers": probe["devices"]},
            "workspace": {"guardedDevice": os.stat(workspace).st_dev, "sourceSha256": source_hash},
            "build": {"exitCode": probe["exitCode"], "outputSha256": probe["buildSha256"]},
            "rootfsTemplate": {"descriptorSha256": artifact["rootfsTemplateSha256"],
                               "preparedRootfsTree": Path(prepared["path"]).name},
            "childIdentity": {"pid": ancestry["pid"], "procStart": ancestry["procStart"],
                              "bootId": ancestry["bootId"], "cliVersion": version},
            "cliInitialize": {"controlRequestId": initialize, "sessionId": session, "model": model,
                              "permissionMode": system["permissionMode"]},
            "firstMessageAck": {"userUuid": ack["uuid"], "sessionId": ack["session_id"],
                                "transport": "loopback-refusal-only", "terminal": "expected-error"}}


def run_measurements(cfg, lease, receipt, artifact):
    # Fresh names, reserved slot, same guarded data filesystem, no customer workspace files.
    with ExitStack() as stack:
        data = stack.enter_context(tempfile.TemporaryDirectory(prefix=".ezil-native-qualification-", dir=cfg.dataMount))
        state = stack.enter_context(tempfile.TemporaryDirectory(prefix=".ezil-native-qualification-", dir=cfg.nativeStateRoot))
        os.chmod(state, 0o711)
        workspace = os.path.join(data, "workspace")
        os.mkdir(workspace, 0o755)
        require(os.stat(data).st_dev == os.stat(cfg.dataMount).st_dev, "native_qualification_workspace_wrong_device")
        runtime_dir = stack.enter_context(tempfile.TemporaryDirectory(prefix="native-qualification-", dir=cfg.runDir))
        default_rootfs = cfg.get("nativeRootfsWorkRoot") or cfg.runDir + "-native-rootfs"
        rootfs_parent = os.path.dirname(default_rootfs)
        os.close(native_artifact.trusted_directory(rootfs_parent, searchable=True))
        private_rootfs = os.path.join(rootfs_parent, "native-qualification-rootfs-" + secrets.token_hex(12))
        probe_cfg = config.Config(cfg, dataMount=data, nativeStateRoot=state, runDir=runtime_dir,
                                  nativeRootfsWorkRoot=private_rootfs)
        launcher = isolation.Launcher(probe_cfg, lease)
        rec = {"resourceKey": secrets.token_hex(32), "slot": 16383, "operationId": str(uuid.uuid4()),
               "sessionId": str(uuid.uuid4()), "runtimeId": str(uuid.uuid4()), "bootId": receipt["bootId"]}
        names = launcher._names(rec)
        entry = {"artifactDir": artifact["dir"], "artifact": artifact}
        launcher.procs[rec["operationId"]] = entry
        service_uid, service_gid = int(cfg.nativeServiceUid), int(cfg.nativeServiceGid)
        top = launcher._state_root(rec)
        paths = [top, os.path.join(top, "sessions"), os.path.join(top, "sessions", rec["sessionId"])]
        leaves = [os.path.join(paths[-1], leaf) for leaf in ("home", "config", "tmp")]
        for path in [*paths, *leaves]:
            os.close(isolation._private_dir(path, service_uid, service_gid))
        require(artifact.get("node"), "native_qualification_node_unpinned")
        node = os.path.join(artifact["dir"], artifact["node"])
        observed = {"artifact": {"manifestSha256": artifact["manifestSha256"], "nodeAbi": artifact["nodeAbi"],
                                 "cliVersion": artifact["cliVersion"]}}
        require(not names["cgroup"].exists() and not os.path.lexists(names["bundle"])
                and not os.path.lexists(f"/var/run/netns/{names['plan']['netns']}"),
                "native_qualification_resource_exists")
        try:
            names["cgroup"].create(isolation.LIMITS, leaves=("driver", "cli"))
            isolation.apply_network(names["plan"], cfg.get("nativeResolver"))
            observed["tls"] = gateway_tls(cfg, names["plan"]["netns"], node)
            observed["egress"] = fence_egress(names["plan"])
            synthetic = "ezg_" + secrets.token_urlsafe(32)
            credential = isolation.write_credential(cfg, rec["resourceKey"], synthetic, service_uid, service_gid)
            relay, ready, wire = start_refusal_relay(launcher, rec, artifact, node, names, credential, stack)
            require(ready["credentialSha256"] == digest(synthetic.encode()), "native_qualification_peer_unverified")
            observed["credentialPeer"] = {"uid": ready["serviceUid"], "gid": ready["serviceGid"],
                                          "credentialScope": "synthetic-core-file-read-only"}
            observed.update(probe_cli(launcher, rec, artifact, ready["port"], workspace, leaves,
                                      credential, names, relay, stack))
            refusal = strict_json(wire.readline(4097).decode())
            require(refusal == {"event": "closed_http_refusal", "status": 401},
                    "native_qualification_offline_refusal_missing")
        finally:
            cleaned = launcher.stop(rec, None)
            for process in (entry.get("popen"), entry.get("cliPopen")):
                if process is not None:
                    process.wait(timeout=5)
        require(all(cleaned.values()) and not names["cgroup"].exists()
                and not os.path.lexists(f"/var/run/netns/{names['plan']['netns']}")
                and not os.path.lexists(names["bundle"]) and not os.path.lexists(names["rootfsContainer"])
                and not os.path.lexists(private_rootfs),
                "native_qualification_cleanup_unverified")
        observed["fencingCleanup"] = {"removed": sorted(cleaned), "remainingProcesses": 0}
        return observed


def publish(cfg, receipt, artifact, observed, directory_fd, recheck):
    try:
        os.mkdir("evidence", 0o700, dir_fd=directory_fd)
        os.fsync(directory_fd)
    except FileExistsError:
        pass
    observations = {}
    evidence_fd = isolation._open_private_directory(directory_fd, "evidence")
    try:
        for name, observation in observed.items():
            raw = authority.canonical(observation)
            sha256 = digest(raw)
            write_file_durable_at(evidence_fd, sha256 + ".json", raw, 0o600)
            observations[name] = {"status": "observed", "evidenceSha256": sha256, "observed": observation}
    finally:
        os.close(evidence_fd)
    kernel = os.uname().release
    runc = measured_command([cfg.runcBin, "--version"]).splitlines()[0]
    witness = {"v": 2, "bootId": receipt["bootId"], "kernel": kernel, "runc": runc,
               "manifestSha256": artifact["manifestSha256"], "placement": receipt["placement"],
               "computerId": receipt["computerId"], "observations": observations,
               "hostEpoch": isolation.derive_host_epoch(receipt["bootId"], receipt["computerId"], receipt["placement"])}
    recheck()
    isolation.write_witness(cfg, witness)
    print(json.dumps({"qualified": True, "witnessSha256": digest(json.dumps(witness, sort_keys=True).encode()),
                      "observationCount": len(observations), "providerCalls": 0}))


def stop_on_signal(signum, frame):
    raise Refused("native_qualification_interrupted")


def new_challenge(target):
    issued = now_ms()
    return dict(target, nonce=secrets.token_urlsafe(32), issuedAt=authority.iso_ms(issued),
                expiresAt=authority.iso_ms(issued + MAX_AGE_MS))


def request_placement_receipt(cfg, lease, challenge, key):
    """Only the root-configured canary may ask its verified enrollment origin for a proof."""
    require(cfg.get("nativeQualificationComputerId") == challenge["computerId"],
            "native_qualification_target_changed")
    uri = urlsplit(storage.endpoint(cfg, lease) or "")
    require(uri.scheme == "https" and uri.hostname and uri.netloc in (uri.hostname, uri.hostname + ":443")
            and uri.path == storage.PATH and not uri.query and not uri.fragment, "native_qualification_origin_invalid")
    url = "https://" + uri.netloc + "/api/compute/aws/native-qualification"
    raw = authority.canonical(challenge)
    signature = "v1=" + hmac.new(key, REQUEST_DOMAIN + digest(raw).encode("ascii"), hashlib.sha256).hexdigest()
    try:
        status, body = http.request("POST", url, body=raw,
                                    headers={"Content-Type": "application/json", "X-Ezil-Signature": signature},
                                    timeout=8, ca_file=cfg.caFile, response_limit=4097)
        require(status == 200 and 0 < len(body) <= 4096, "native_qualification_receipt_unavailable")
        return strict_json(body.decode("utf-8"))
    except (OSError, ValueError, HTTPException) as error:
        raise Refused("native_qualification_receipt_unavailable") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("step", choices=("challenge", "qualify", "qualify-via-os"))
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0, "native_qualification_root_required")
        os.umask(0o077)
        signal.signal(signal.SIGTERM, stop_on_signal)
        cfg = load_config()
        artifact = native_artifact.load(cfg.nativeRuntimeRoot, cfg.get("nativeRuntimePin"))
        lease, guard_digest, target = live_target(cfg, artifact)
        with ExitStack() as stack:
            directory_fd = isolation._open_witness_directory(cfg, create=True)
            stack.callback(os.close, directory_fd)
            lock = os.open("qualification.lock", os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_RDWR,
                           0o600, dir_fd=directory_fd)
            stack.callback(os.close, lock)
            st = os.fstat(lock)
            require(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1
                    and stat.S_IMODE(st.st_mode) == 0o600, "native_qualification_storage_untrusted")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.step == "challenge":
                raw = authority.canonical(new_challenge(target))
                write_file_durable_at(directory_fd, CHALLENGE, raw, 0o600)
                print(raw.decode())
                return 0
            key = read_control_key(cfg, target["placement"])
            if args.step == "qualify-via-os":
                challenge = new_challenge(target)
                envelope = request_placement_receipt(cfg, lease, challenge, key)
            else:
                challenge = private_json(directory_fd, CHALLENGE)
                envelope = private_json(directory_fd, RECEIPT)
            receipt = validate_receipt(envelope, challenge, target, key, now_ms())
            if args.step == "qualify":
                unlink_durable_at(directory_fd, CHALLENGE)
                unlink_durable_at(directory_fd, RECEIPT)
            observed = run_measurements(cfg, lease, receipt, artifact)

            def recheck():
                _, final_digest, final_target = live_target(cfg, artifact)
                require(guard_digest == final_digest and hmac.compare_digest(key, read_control_key(cfg, final_target["placement"])),
                        "native_qualification_target_changed")
                validate_receipt(envelope, challenge, final_target, key, now_ms())

            publish(cfg, receipt, artifact, observed, directory_fd, recheck)
            return 0
    except Refused as error:
        print(error.code, file=sys.stderr)
    except (OSError, ValueError, KeyError, AttributeError, TypeError, subprocess.SubprocessError) as error:
        print(f"native_qualification_failed:{type(error).__name__}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
