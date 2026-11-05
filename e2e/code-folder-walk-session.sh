#!/usr/bin/env bash
# code-folder-walk-session.sh — the Cloudflare folder walk against the REAL Sandbox SDK session of a desktop image
# (its own /container-server), offline. A foreground exec runs inside the session's own `bash --norc`, so a walk
# that `exit`s ends the shared session shell and the desktop stack started in it (live 2026-11-05: every later Code
# mint failed with relay_refresh_failed). Proves, for the command the Worker sends (CODE_FOLDER_RESOLVE_COMMAND):
#   every outcome (restored, missing, symlink, not_directory, error) answers in the same live session; no
#   SESSION_TERMINATED; a logging background process (the desktop's stand-in) survives; no set -f / IFS leak.
# Control: the bare script ends the session and takes the background process with it.
#   [IMAGE=<desktop image>] e2e/code-folder-walk-session.sh        (needs docker, bun, python3, curl)
set -u
IMAGE="${IMAGE:-ezil-os-worker-staging-sandbox:2031b2c1}" # the live Cloudflare image on 2026-11-05
HERE="$(cd "$(dirname "$0")" && pwd)"
NET=ezil-walk-net-$$; NAME=ezil-walk-cs-$$
cleanup() { docker rm --force "$NAME" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT INT TERM
JSON="$(cd "$HERE/.." && bun -e "import { CODE_FOLDER_RESOLVE_COMMAND as command, CODE_FOLDER_RESOLVE_SCRIPT as script } from './worker/src/code-folder-resolve.ts'; console.log(JSON.stringify({ command, script }))")" \
  || { echo "FAIL cannot load the walk from worker/src/code-folder-resolve.ts"; exit 1; }
docker network create --internal "$NET" >/dev/null
docker run -d --name "$NAME" --network "$NET" "$IMAGE" >/dev/null
IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$NAME")"
for i in $(seq 1 60); do curl -fsS -o /dev/null "http://$IP:3000/api/ping" 2>/dev/null && break; sleep 1; done
docker exec "$NAME" sh -c 'mkdir -p /workspace/w/a/b && : > /workspace/w/a/file.txt && ln -sfn /workspace/w/a /workspace/w/link && ln -sfn /tmp /workspace/w/a/out'
JSON="$JSON" IP="$IP" NAME="$NAME" python3 -I - <<'PY'
import json, os, subprocess, time, urllib.request
ip, name = os.environ['IP'], os.environ['NAME']
walk = json.loads(os.environ['JSON'])
fails = 0
def api(path, body):
    req = urllib.request.Request(f'http://{ip}:3000{path}', json.dumps(body).encode(), {'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r: return json.load(r)
    except urllib.error.HTTPError as e: return json.load(e)
def check(ok, msg, detail=''):
    global fails
    fails += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {msg}{('  ' + detail) if detail else ''}")
def desktop_alive(tag):
    out = subprocess.run(['docker', 'exec', name, 'sh', '-c', f"ps -eo cmd | grep -c '[d]esk-{tag}'"], capture_output=True, text=True).stdout.strip()
    return out not in ('', '0')
def session(tag):
    api('/api/session/create', {'id': tag})
    api('/api/process/start', {'command': f"sh -c 'while :; do echo desk-{tag}; sleep 0.1; done'", 'sessionId': tag})
    time.sleep(2)
def run(tag, command, root, rel):
    return api('/api/execute', {'command': command, 'sessionId': tag, 'env': {'EZIL_CODE_FOLDER_ROOT': root, 'EZIL_CODE_FOLDER_REL': rel},
                                'timeoutMs': 5000, 'origin': 'internal'})

session('fixed')
check(desktop_alive('fixed'), 'the desktop stand-in runs in the session before any walk')
cases = [('/workspace/w', 'a/b', 'restored'), ('/workspace/w', 'nope', 'missing'), ('/workspace/w', 'link/b', 'symlink'),
         ('/workspace/w', 'a/out', 'symlink'), ('/workspace/w', 'a/file.txt', 'not_directory'), ('relative/root', 'a', 'error'),
         ('/workspace/w', 'x*', 'missing')]
for root, rel, want in cases:
    r = run('fixed', walk['command'], root, rel)
    got = (r.get('stdout') or '').strip()
    check(r.get('success') is True and r.get('exitCode') == 0 and got == f'ezil-code-folder:{want}',
          f'walk {rel!r} under {root!r} answers {want} in the live session', json.dumps({k: r.get(k) for k in ('code', 'exitCode', 'stdout')}))
time.sleep(3)
check(desktop_alive('fixed'), 'the desktop stand-in survived every walk')
st = api('/api/execute', {'command': 'printf "%s|%s|" "$-" "$#"; printf "%s" "$IFS" | od -An -c | tr -s " "', 'sessionId': 'fixed'})
out = st.get('stdout') or ''
check(st.get('success') is True and 'f' not in out.split('|')[0] and out.split('|')[1] == '0' and '\\t \\n' in out,
      'the session keeps its own state: no set -f, no positional parameters, default IFS', json.dumps(out))

session('control')
r = run('control', walk['script'], '/workspace/w', 'nope')
check(r.get('code') == 'SESSION_TERMINATED', 'control: the bare script ends the session shell', json.dumps({k: r.get(k) for k in ('code', 'httpStatus')}))
time.sleep(3)
check(not desktop_alive('control'), 'control: the desktop stand-in died with it')
print(f"{'PASS' if fails == 0 else 'FAIL'} code-folder-walk-session: {fails} failure(s), image {os.environ.get('IMAGE', '')}")
raise SystemExit(1 if fails else 0)
PY
