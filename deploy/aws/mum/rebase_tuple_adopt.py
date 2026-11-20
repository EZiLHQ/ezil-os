"""Adopt a witnessed production tuple. Only the local ledger may change."""
from datetime import datetime, timedelta
import hashlib
import json
import os
import subprocess
import sys
from time import monotonic, sleep
from urllib.request import urlopen

import rebase_manifest as manifest

need = manifest.need
UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
HASH = r"[0-9a-f]{64}"
HEALTH_URL = "https://os.ezil.work/api/health"
KEYS = ("secretVersionId", "tuple", "registrySha256", "appGitSha")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def tuple_hash(value):
    return sha(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def iso(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def read_recovery(release, path, checksum):
    raw = release.safe_path(path).read_bytes()
    need(len(raw) <= 16384 and sha(raw) == checksum, "tuple-adopt recovery digest mismatch")
    value = manifest.loads(raw.decode())
    need(isinstance(value, dict) and set(value) == {
        "schemaVersion", "authorization", "ledgerSha256", "ledgerGeneration", "basisGeneration",
        "expectedCurrentVersion", "expectedPreviousVersion", "currentTupleSha256", "previousTupleSha256",
        "appTag", "appImageId", "instanceId", "install", "readback", "secretWrites"
    } and type(value["schemaVersion"]) is int and value["schemaVersion"] == 1,
        "invalid tuple-adopt recovery schema")
    for key in ("ledgerSha256", "currentTupleSha256", "previousTupleSha256"):
        need(manifest.matches(HASH, value[key]), "invalid tuple-adopt checksum")
    for key in ("expectedCurrentVersion", "expectedPreviousVersion"):
        need(manifest.matches(UUID, value[key]), "invalid tuple-adopt settings version")
    need(value["expectedCurrentVersion"] != value["expectedPreviousVersion"]
         and type(value["ledgerGeneration"]) is int and type(value["basisGeneration"]) is int
         and value["basisGeneration"] >= 1 and value["basisGeneration"] == value["ledgerGeneration"] - 2,
         "invalid tuple-adopt snapshots")
    for key in ("install", "readback"):
        witness = value[key]
        need(isinstance(witness, dict) and set(witness) == {"commandId", "stdoutSha256", "parametersSha256"}
             and manifest.matches(UUID, witness["commandId"]) and manifest.matches(HASH, witness["stdoutSha256"])
             and manifest.matches(HASH, witness["parametersSha256"]),
             "invalid tuple-adopt SSM witness")
    need(value["install"]["commandId"] != value["readback"]["commandId"],
         "tuple-adopt requires independent SSM witnesses")
    writes = value["secretWrites"]
    need(isinstance(writes, list) and len(writes) == 2 and all(
         isinstance(event, dict) and set(event) == {"eventId", "time"} and manifest.matches(UUID, event["eventId"])
         and manifest.matches(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", event["time"])
         for event in writes) and writes[0]["eventId"] != writes[1]["eventId"]
         and iso(writes[0]["time"]) < iso(writes[1]["time"]), "invalid tuple-adopt CloudTrail pins")
    need(manifest.matches(r"[A-Za-z0-9:/._#-]{1,300}", value["authorization"])
         and manifest.matches(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", value["appTag"])
         and manifest.matches(r"sha256:" + HASH, value["appImageId"])
         and manifest.matches(r"i-[0-9a-f]{17}", value["instanceId"]), "invalid tuple-adopt authority or app identity")
    return value


def observations(release, plan, ledger, current, previous, checksum):
    entries = ledger["entries"]
    need(len(entries) == plan["ledgerGeneration"], "tuple-adopt canonical ledger generation changed")
    latest, basis = entries[-1], entries[plan["basisGeneration"] - 1]
    for envelope, ref, version, digest in (
        (current, basis, plan["expectedCurrentVersion"], plan["currentTupleSha256"]),
        (previous, latest, plan["expectedPreviousVersion"], plan["previousTupleSha256"]),
    ):
        outer, deployment = release.secret_deployment(envelope, require_gate=False)
        actual = release.observed_state(envelope, deployment, ref["appGitSha"])
        need(actual["secretVersionId"] == version and release.state_matches(actual, ref)
             and tuple_hash(actual["tuple"]) == digest
             and outer.get("AWS_STANDALONE_REPO_OPEN_ENABLED") in (None, "", "0", "false", "off"),
             "tuple-adopt witnessed settings or registry changed")
    observed = {key: basis[key] for key in KEYS} | {"secretVersionId": current["VersionId"]}
    entry = {
        "generation": latest["generation"] + 1, "operation": "tuple-adopt", "state": "completed",
        "planSha256": checksum, "basisGeneration": basis["generation"],
        "before": {key: latest[key] for key in KEYS}, "expected": observed, **observed,
    }
    release.validate_ledger({**ledger, "entries": [*entries, entry]})
    return entry


def verify_cloudtrail(release, plan, current, previous):
    writes = plan["secretWrites"]
    records = release.aws("cloudtrail", "lookup-events", "--lookup-attributes",
        f"AttributeKey=ResourceName,AttributeValue={release.json_tool.SECRET}",
        "--start-time", (iso(writes[0]["time"]) - timedelta(seconds=2)).isoformat(),
        "--end-time", (iso(writes[1]["time"]) + timedelta(seconds=2)).isoformat())
    need(not records.get("NextToken"), "tuple-adopt CloudTrail results incomplete")
    changes = [item for item in records["Events"] if item["EventName"] in
               ("PutSecretValue", "UpdateSecret", "UpdateSecretVersionStage")]
    need({item["EventId"] for item in changes} == {witness["eventId"] for witness in writes},
         "tuple-adopt unreviewed settings change in CloudTrail window")
    sessions = []
    for witness, envelope in zip(writes, (previous, current)):
        events = [manifest.loads(item["CloudTrailEvent"]) for item in changes
                  if item["EventId"] == witness["eventId"]]
        need(len(events) == 1, "tuple-adopt CloudTrail event missing or ambiguous")
        event = events[0]
        identity = event.get("userIdentity") or {}
        issuer = identity.get("sessionContext", {}).get("sessionIssuer", {})
        params = event.get("requestParameters") or {}
        sessions.append((identity.get("principalId"), issuer.get("arn")))
        token = params.get("clientRequestToken")
        need(event.get("eventName") == "PutSecretValue" and event.get("eventSource") == "secretsmanager.amazonaws.com"
             and event.get("eventTime") == witness["time"] and not event.get("errorCode")
             and params.get("secretId") == release.json_tool.SECRET
             and (token is None or token == envelope["VersionId"])
             and event.get("userAgent", "").startswith("aws-cli/")
             and issuer.get("userName", "").startswith("AWSReservedSSO_")
             and abs((iso(envelope["CreatedDate"]) - iso(witness["time"])).total_seconds()) < 2,
             "tuple-adopt CloudTrail and settings version evidence disagree")
    need(sessions[0] == sessions[1] and all(sessions[0]), "tuple-adopt CloudTrail role session changed")


def verify_app(release, plan, entry):
    release.rebase_ssm.host_identity(release.aws)
    instance = release.rebase_ssm.HOST
    need(instance == plan["instanceId"], "tuple-adopt production app host changed")
    latest = iso(plan["secretWrites"][-1]["time"])
    for kind in ("install", "readback"):
        witness = plan[kind]
        proof = release.aws("ssm", "get-command-invocation", "--instance-id", instance,
                            "--command-id", witness["commandId"])
        out = proof["StandardOutputContent"]
        need(proof["InstanceId"] == instance and proof["CommandId"] == witness["commandId"]
             and proof["Status"] == "Success" and proof["ResponseCode"] == 0
             and iso(proof["ExecutionEndDateTime"]) > latest
             and sha(out.encode()) == witness["stdoutSha256"] and plan["appTag"] in out,
             "tuple-adopt terminal SSM witness mismatch")
        latest = iso(proof["ExecutionEndDateTime"])
        parent = release.aws("ssm", "list-commands", "--command-id", witness["commandId"])
        commands = parent["Commands"]
        need(not parent.get("NextToken") and len(commands) == 1
             and commands[0]["CommandId"] == witness["commandId"]
             and commands[0]["Status"] == "Success" and commands[0]["InstanceIds"] == [instance]
             and commands[0]["DocumentName"] == "AWS-RunShellScript"
             and tuple_hash(commands[0]["Parameters"]) == witness["parametersSha256"],
             "tuple-adopt parent SSM command mismatch")
        if kind == "install":
            need(entry["appGitSha"] in out, "tuple-adopt install source mismatch")
            continue
        public = [manifest.loads(line) for line in out.splitlines() if line.startswith('{"')]
        expected = entry["tuple"]
        need(len(public) == 1 and all(public[0].get(key) == value for key, value in {
             "sha": entry["appGitSha"], "agentCommit": entry["appGitSha"], "amiId": expected["amiId"],
             "ltVersion": str(expected["launchTemplateVersion"]), "lower": expected["lowerImageDigest"],
             "previousLower": expected["previousLowerImageDigest"]}.items())
             and plan["appImageId"] in out, "tuple-adopt SSM app and tuple mismatch")
    with urlopen(HEALTH_URL, timeout=12) as response:
        need(response.geturl() == HEALTH_URL, "tuple-adopt production health origin changed")
        public = manifest.loads(response.read(16384).decode())
    need(public.get("ok") is True and public.get("sha") == entry["appGitSha"],
         "tuple-adopt running public source changed")


def fresh_app_body(deployment_keys):
    # Commands only inspect an already running named service and read its rendered state.
    node = """
const d=JSON.parse(process.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS||'{}')['ap-south-1'];
const out=Object.fromEntries(KEYS.filter(k=>k in d).map(k=>[k,d[k]]));
if('releases' in d)out.releasesSha256=require('crypto').createHash('sha256').update(JSON.stringify(d.releases)).digest('hex');
const appGate=/^(1|true|on)$/i.test((process.env.AWS_STANDALONE_REPO_OPEN_ENABLED||'').trim());
console.log(JSON.stringify({deployment:out,sha:process.env.EZIL_GIT_SHA,killSwitch:process.env.EZIL_AWS_KILL_SWITCH,appGate}));
""".replace("KEYS", json.dumps([key for key in deployment_keys if key != "releasesSha256"]))
    return "set -eu\npython3 - <<'EZIL_TUPLE_READBACK'\nNODE = " + repr(node) + """
import json,re,subprocess
def out(*args):
    return subprocess.check_output(args,cwd="/opt/ezil-os-production",text=True,timeout=12,stderr=subprocess.DEVNULL).strip()
def container():
    cid=out("docker","compose","--env-file","compose.env","ps","-q","web")
    if not re.fullmatch("[0-9a-f]{12,64}",cid): raise ValueError("container identity")
    return cid
def image(cid):
    i=out("docker","inspect","--type","container","--format","{{.Image}} {{.State.Running}}",cid)
    if not re.fullmatch("sha256:[0-9a-f]{64} true",i): raise ValueError("running image identity")
    return i.split()[0]
cid=container()
expected_image=image(cid)
state=json.loads(out("docker","exec",cid,"node","-e",NODE))
if container()!=cid or image(cid)!=expected_image: raise ValueError("app changed during readback")
print(json.dumps({**state,"imageId":expected_image},separators=(",",":")))
EZIL_TUPLE_READBACK
"""


def verify_fresh_app(release, plan, current, entry, checksum):
    outer, deployment = release.secret_deployment(current, require_gate=False)
    expected = {
        "deployment": release.rebase_app.public_deployment(deployment), "sha": entry["appGitSha"],
        "killSwitch": outer.get("EZIL_AWS_KILL_SWITCH"), "appGate": False, "imageId": plan["appImageId"],
    }
    body = fresh_app_body(expected["deployment"])
    instance = plan["instanceId"]
    # Inline read-only SSM avoids an app install or transport-bucket object writes.
    sent = release.aws("ssm", "send-command", "--instance-ids", instance,
                       "--document-name", "AWS-RunShellScript", "--comment",
                       "ezil-tuple-adopt-readback-" + checksum[:24], "--timeout-seconds", "60", "--parameters",
                       json.dumps({"commands": [body], "executionTimeout": ["45"]}))
    command_id = sent["Command"]["CommandId"]
    need(manifest.matches(UUID, command_id), "tuple-adopt fresh readback command invalid")
    end = monotonic() + 65
    while monotonic() < end:
        try:
            proof = release.aws("ssm", "get-command-invocation", "--instance-id", instance, "--command-id", command_id)
        except ValueError:
            sleep(2)  # Command invocation may not be visible yet.
            continue
        if proof["Status"] in ("Pending", "InProgress", "Delayed"):
            sleep(2)
            continue
        need(proof["InstanceId"] == instance and proof["CommandId"] == command_id
             and proof["Status"] == "Success" and proof["ResponseCode"] == 0
             and manifest.loads(proof["StandardOutputContent"].strip()) == expected,
             "tuple-adopt fresh running app differs from sealed image, source or deployment")
        return command_id
    raise ValueError("tuple-adopt fresh readback did not settle; retain command " + command_id)


def assert_lease(release, owner):
    need(manifest.matches(r"[A-Za-z0-9_.:/-]{1,200}", owner), "tuple-adopt requires the owned production lease")
    # Use the same explicit SSO profile as the production provider reads.
    env = {key: value for key, value in os.environ.items() if key not in {
        "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN",
        "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME", "AWS_DEFAULT_PROFILE",
    }}
    subprocess.run([sys.executable, str(release.REPO / ".github/scripts/staging-lock.py"), "assert",
                    "--scope", "shared-production", "--owner", owner], check=True, timeout=20,
                    env={**env, "AWS_PROFILE": "ezil-admin"})


def run(release, recovery_path, checksum, owner, apply, fresh_readback=False):
    need(release.json_tool.NAMESPACE == "prd", "tuple-adopt is production only")
    plan = read_recovery(release, recovery_path, checksum)
    ledger_path = release.LEDGER_PATH
    if apply:
        need(plan["authorization"].startswith("ratified:") and len(plan["authorization"]) > 10,
             "tuple-adopt requires release-owner ratification")
        assert_lease(release, owner)
    with release.json_tool.app_secret_lock() as fd:
        def secret(stage):
            return release.json_tool.secret_aws(["get-secret-value", "--secret-id", release.json_tool.SECRET,
                                                "--version-stage", stage, "--output", "json"], lock_fd=fd)
        need(sha(release.safe_path(ledger_path).read_bytes()) == plan["ledgerSha256"],
             "tuple-adopt canonical ledger digest changed")
        ledger = release.load_ledger(ledger_path)
        current, previous = secret("AWSCURRENT"), secret("AWSPREVIOUS")
        entry = observations(release, plan, ledger, current, previous, checksum)
        verify_cloudtrail(release, plan, current, previous)
        verify_app(release, plan, entry)
        command_id = (verify_fresh_app(release, plan, current, entry, checksum)
                      if apply or fresh_readback else None)
        need(secret("AWSCURRENT") == current and secret("AWSPREVIOUS") == previous
             and sha(release.safe_path(ledger_path).read_bytes()) == plan["ledgerSha256"]
             and read_recovery(release, recovery_path, checksum) == plan, "tuple-adopt inputs changed during readback")
        if apply:
            assert_lease(release, owner)
            release.write_ledger_append(ledger_path, ledger, entry, plan["ledgerSha256"])
        print(json.dumps({"applied": apply, "freshReadbackCommandId": command_id, "generation": entry["generation"],
                          "basisGeneration": entry["basisGeneration"], "planSha256": checksum}))
