#!/usr/bin/env python3
"""PR preview slots on the OS staging host. Runs as root through SSM (preview.sh); never a staging install.

Each slot is one extra `ezil-os-staging:<prN-sha12>` web container behind the host's
Caddy at a fixed origin (os-pv1/os-pv2.ezil.work), with its own Compose project,
env file, receipt and TTL. A slot never touches the `ezil-os-staging` project, its
timers or its env file, and a busy slot is never taken from another PR.

Isolation is per tier, and only these tiers are claimed:
- process/URL: own container, loopback port and Caddy site block;
- session/auth: the app's `__Host-` cookies are host-only, and the container owns
  only its own slot origin (EZIL_DEPLOY_ENV=pr-preview, EZIL_PR_PREVIEW_ORIGIN);
- side effects: no cron timers, CRON_SECRET or Stripe webhook secret, and checkout
  off. Computers are off by default (AWS disabled, kill switch on, no computer HMAC);
  `--computers shared` keeps staging's computer settings so a QA identity can run
  chat on the shared staging fleet, under the app's existing per-user caps.
Data is NOT isolated: the slot reads and writes the same PREVIEW Supabase as
os-staging (never production). Schema-changing PRs are refused upstream.
"""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

# preview.sh copies install_receipt.py next to this file on the host; in the repo it is one level up.
sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parent.parent)]
import install_receipt  # noqa: E402

ROOT = Path(os.environ.get('EZIL_PREVIEW_ROOT', '/opt/ezil-os-preview'))
ETC = Path(os.environ.get('EZIL_PREVIEW_ETC', '/etc/ezil-os-preview'))
STAGING_ENV = Path(os.environ.get('EZIL_STAGING_APP_ENV', '/etc/ezil-os-staging/app.env'))
STAGING_COMPOSE_ENV = Path(os.environ.get('EZIL_STAGING_COMPOSE_ENV', '/opt/ezil-os-staging/compose.env'))
SYSTEMD = Path(os.environ.get('EZIL_PREVIEW_SYSTEMD', '/etc/systemd/system'))
REGION = 'ap-south-1'

SLOTS = {1: 3101, 2: 3102}
DEFAULT_TTL_HOURS = 48
STARTING_MINUTES = 30
MAX_TTL_HOURS = 72
# The host is a t3.medium with no swap: hard caps keep two slots from OOM-killing os-staging or
# draining its burst credits (images are built off-host).
MEMORY = '768m'
CPUS = '0.5'
TAG = re.compile(r'pr[0-9]{1,6}-[0-9a-f]{12}')
STAGING_TAG = re.compile(r'OS_STAGING_TAG=([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})')

# Always removed from the staging env: cron and webhook authority.
DROP = frozenset({'CRON_SECRET', 'STRIPE_WEBHOOK_SECRET'})
COMPUTERS_OFF = {'EZIL_AWS_COMPUTERS_ENABLED': '0', 'EZIL_AWS_KILL_SWITCH': '1'}
# Also removed with computers off: the key that controls staging's Cloudflare computers and signs AWS enrolment,
# the lifecycle authority and the app-caller roles.
COMPUTER_CONTROL = re.compile(r'CLOUDFLARE_GUACAMOLE_HMAC_SECRET|EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET|EZIL_AWS_APP_CALLER_ROLE_ARN_[A-Z0-9_]+')


class PreviewError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise PreviewError(message)


def origin(slot):
    return f'https://os-pv{slot}.ezil.work'


def project(slot):
    name = f'ezil-os-preview-pv{slot}'
    require(name != 'ezil-os-staging' and slot in SLOTS, 'Refusing a non-preview Compose project')
    return name


def now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(moment):
    return moment.isoformat().replace('+00:00', 'Z')


def parse_iso(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout


def atomic_write(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.')
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


# ---------------------------------------------------------------- receipts

def receipt_path(slot):
    return ROOT / f'pv{slot}' / 'receipt.json'


def read_receipts():
    receipts = {}
    for slot in SLOTS:
        path = receipt_path(slot)
        if path.exists():
            receipts[slot] = json.loads(path.read_text())
    return receipts


def expired(receipt, moment):
    return parse_iso(receipt['expires_at']) <= moment


def choose_slot(receipts, pr, moment):
    """The PR's own slot, else a free or expired one. Never another PR's live slot."""
    for slot, receipt in receipts.items():
        if receipt.get('pr') == pr:
            return slot
    for slot in SLOTS:
        if slot not in receipts or expired(receipts[slot], moment):
            return slot
    busy = ', '.join(f"pv{s}=pr{r['pr']} until {r['expires_at']}" for s, r in sorted(receipts.items()))
    raise PreviewError(f'All preview slots are busy ({busy}); close a PR or wait for its TTL.')


# ---------------------------------------------------------------- env overlay

def parse_env(text):
    """The renderer's raw `KEY=VALUE` lines (Compose `format: raw`); values are never unquoted."""
    values = {}
    for line in text.splitlines():
        if not line:
            continue
        key, sep, value = line.partition('=')
        require(sep and re.fullmatch(r'[A-Z][A-Z0-9_]*', key), 'Unexpected line in the staging env file')
        values[key] = value
    return values


def preview_env(staging, slot, pr, computers):
    require(computers in ('off', 'shared'), 'computers must be off or shared')
    values = {k: v for k, v in staging.items() if k not in DROP}
    if computers == 'off':
        values = {k: v for k, v in values.items() if not COMPUTER_CONTROL.fullmatch(k)}
        values.update(COMPUTERS_OFF)
    values.update({
        'EZIL_DEPLOY_ENV': 'pr-preview',
        'EZIL_PR_PREVIEW_ORIGIN': origin(slot),
        'EZIL_PR_PREVIEW_LANE': f'pr-{pr}',
        'CHECKOUT_ENABLED': '0',
    })
    for key, value in values.items():
        require('\n' not in value and '\r' not in value, f'Multiline value refused for {key}')
    return ''.join(f'{k}={values[k]}\n' for k in sorted(values))


def compose_file(slot, tag, receipt):
    port = SLOTS[slot]
    labels = {f'work.ezil.preview.{k}': str(receipt[k]) for k in ('slot', 'pr', 'sha', 'image_id', 'expires_at')}
    return json.dumps({
        'name': project(slot),
        'services': {'web': {
            'image': f'ezil-os-staging:{tag}',
            'platform': 'linux/amd64',
            'pull_policy': 'never',
            'env_file': [{'path': str(ETC / f'pv{slot}.env'), 'format': 'raw'}],
            'environment': {'AWS_REGION': REGION},
            'restart': 'unless-stopped',
            'init': True,
            'network_mode': 'host',
            'command': ['node', 'node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', str(port)],
            'mem_limit': MEMORY,
            'cpus': CPUS,
            'pids_limit': 512,
            'labels': labels,
            'logging': {'driver': 'json-file', 'options': {'max-size': '20m', 'max-file': '3'}},
        }},
    }, indent=2) + '\n'


# ---------------------------------------------------------------- docker / health

def compose(slot, *args):
    path = ROOT / f'pv{slot}' / 'compose.json'
    return run(['docker', 'compose', '--project-name', project(slot), '--file', str(path), *args])


def staging_tag():
    match = STAGING_TAG.fullmatch(STAGING_COMPOSE_ENV.read_text().strip()) if STAGING_COMPOSE_ENV.exists() else None
    return match.group(1) if match else None


def remove_image(tag):
    """Only a preview tag, and never the image os-staging runs."""
    if TAG.fullmatch(tag or '') and tag != staging_tag():
        subprocess.run(['docker', 'image', 'rm', f'ezil-os-staging:{tag}'], capture_output=True)


def fetch_health(port):
    request = urllib.request.Request(f'http://127.0.0.1:{port}/api/health', headers={'cache-control': 'no-store'})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read(4096))


def wait_healthy(slot, sha, deadline_seconds=120):
    deadline = time.monotonic() + deadline_seconds
    last = None
    while time.monotonic() < deadline:
        try:
            body = fetch_health(SLOTS[slot])
            if body.get('ok') is True and body.get('sha') == sha:
                return
            last = f"sha={body.get('sha')}"
        except Exception as error:  # noqa: BLE001 - booting; report the class only
            last = type(error).__name__
        time.sleep(3)
    raise PreviewError(f'Preview pv{slot} did not report sha {sha} on /api/health ({last})')


# ---------------------------------------------------------------- commands

def teardown_slot(slot, reason):
    path = receipt_path(slot)
    receipt = json.loads(path.read_text()) if path.exists() else {}
    if (ROOT / f'pv{slot}' / 'compose.json').exists():
        compose(slot, 'down', '--remove-orphans', '--timeout', '20')
    (ETC / f'pv{slot}.env').unlink(missing_ok=True)
    path.unlink(missing_ok=True)
    remove_image(receipt.get('tag'))
    remove_image(receipt.get('previous_tag'))
    return {'slot': slot, 'pr': receipt.get('pr'), 'sha': receipt.get('sha'), 'removed': reason}


def download(bucket, tag, directory):
    env = {k: v for k, v in os.environ.items() if not k.startswith('AWS_')}
    env.update(AWS_CONFIG_FILE='/dev/null', AWS_SHARED_CREDENTIALS_FILE='/dev/null', AWS_EC2_METADATA_DISABLED='false')
    for suffix in ('sha256', 'tar.gz', 'runtime.tar.gz', 'source.json'):
        run(['aws', '--region', REGION, '--no-cli-pager', 's3', 'cp', f's3://{bucket}/os-staging/images/{tag}.{suffix}',
             str(directory / f'{tag}.{suffix}'), '--only-show-errors'], env=env)


def write_receipt(slot, receipt):
    atomic_write(receipt_path(slot), json.dumps(receipt, indent=2) + '\n', 0o644)


def deploy(args):
    require(TAG.fullmatch(args.tag) and args.tag.startswith(f'pr{args.pr}-') and args.sha.startswith(args.tag[-12:]),
            'Tag must be pr<PR>-<first 12 of SHA>')
    moment = now()
    receipts = read_receipts()
    slot = choose_slot(receipts, args.pr, moment)
    previous = receipts.get(slot)
    old_tag = previous.get('tag') if previous and previous.get('pr') == args.pr else None
    loaded_tag, touched = None, False
    try:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            download(args.bucket, args.tag, directory)
            # The receipt hash pins the archive, so it alone determines the image ID; a CI build may confirm it.
            image_id = install_receipt.verify_archive(directory, args.tag, 'staging', args.sha, args.receipt_sha256)
            require(args.image_id in ('', image_id), 'Verified archive image ID differs from the CI build')
            with (directory / f'{args.tag}.tar.gz').open('rb') as archive:
                loaded_tag = args.tag
                subprocess.run(['sh', '-c', 'gzip -dc | docker load'], stdin=archive, check=True, capture_output=True)
        loaded = json.loads(run(['docker', 'image', 'inspect', f'ezil-os-staging:{args.tag}', '--format', '{{json .}}']))
        install_receipt.verify_loaded(loaded, args.sha, image_id)
        if previous and previous.get('pr') != args.pr:
            teardown_slot(slot, 'expired')
        receipt = {
            'schema': 1, 'state': 'starting', 'slot': slot, 'origin': origin(slot), 'pr': args.pr, 'sha': args.sha,
            'tag': args.tag, 'image_id': image_id, 'receipt_sha256': args.receipt_sha256, 'computers': args.computers,
            'data_plane': 'shared-staging-preview-supabase', 'deployed_at': iso(moment),
            'expires_at': iso(moment + dt.timedelta(minutes=STARTING_MINUTES)), 'run': args.run,
            # Named so a reaper run after a killed redeploy also removes the image this one replaces.
            'previous_tag': old_tag if old_tag != args.tag else None,
        }
        # The slot is claimed before its container starts: if this command dies (SSM timeout) after `up`,
        # the short expiry hands the container to the reaper instead of leaving it serving unowned.
        touched = True
        write_receipt(slot, receipt)
        staging = parse_env(STAGING_ENV.read_text())
        atomic_write(ETC / f'pv{slot}.env', preview_env(staging, slot, args.pr, args.computers))
        atomic_write(ROOT / f'pv{slot}' / 'compose.json', compose_file(slot, args.tag, receipt), 0o644)
        compose(slot, 'up', '--detach', '--force-recreate', '--wait', '--wait-timeout', '120')
        wait_healthy(slot, args.sha)
        receipt.update(state='serving', expires_at=iso(moment + dt.timedelta(hours=args.ttl_hours)), previous_tag=None)
        write_receipt(slot, receipt)
    except BaseException:
        # A preview has no rollback. Before the slot is touched, the old head keeps serving; after, the
        # slot is removed rather than left half-serving. Either way no failed image stays on the shared disk.
        if touched:
            try:
                compose(slot, 'down', '--remove-orphans', '--timeout', '20')
            except Exception:  # noqa: BLE001 - keep the original error; the receipt still lets reap retry
                pass
            else:
                receipt_path(slot).unlink(missing_ok=True)
            (ETC / f'pv{slot}.env').unlink(missing_ok=True)
            if old_tag != args.tag:
                remove_image(old_tag)
        if loaded_tag and (touched or loaded_tag != old_tag):
            remove_image(loaded_tag)
        raise
    if old_tag and old_tag != args.tag:
        remove_image(old_tag)
    return receipt


def teardown(args):
    found = [slot for slot, receipt in read_receipts().items() if receipt.get('pr') == args.pr]
    return [teardown_slot(slot, 'closed') for slot in found]


def reap(_args):
    moment = now()
    return [teardown_slot(slot, 'expired') for slot, receipt in read_receipts().items() if expired(receipt, moment)]


def status(_args):
    receipts = read_receipts()
    return [receipts.get(slot, {'slot': slot, 'origin': origin(slot), 'pr': None}) for slot in SLOTS]


REAPER_SERVICE = """[Unit]
Description=Remove expired OS PR preview slots

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 {root}/preview_host.py reap
"""
REAPER_TIMER = """[Unit]
Description=Hourly OS PR preview TTL reaper

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
"""


def install_reaper(_args):
    atomic_write(SYSTEMD / 'ezil-os-preview-reap.service', REAPER_SERVICE.format(root=ROOT), 0o644)
    atomic_write(SYSTEMD / 'ezil-os-preview-reap.timer', REAPER_TIMER, 0o644)
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'ezil-os-preview-reap.timer'])
    return {'reaper': 'ezil-os-preview-reap.timer', 'cadence': 'hourly'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest='command', required=True)
    d = commands.add_parser('deploy')
    d.add_argument('--pr', type=int, required=True)
    d.add_argument('--sha', required=True)
    d.add_argument('--tag', required=True)
    d.add_argument('--image-id', default='')
    d.add_argument('--receipt-sha256', required=True)
    d.add_argument('--bucket', required=True)
    d.add_argument('--run', default='')
    d.add_argument('--ttl-hours', type=int, default=DEFAULT_TTL_HOURS)
    d.add_argument('--computers', choices=('off', 'shared'), default='off')
    t = commands.add_parser('teardown')
    t.add_argument('--pr', type=int, required=True)
    for name in ('reap', 'status', 'install-reaper'):
        commands.add_parser(name)
    args = parser.parse_args(argv)
    if args.command == 'deploy':
        require(0 < args.pr < 10**6, 'Invalid PR number')
        require(re.fullmatch(r'[0-9a-f]{40}', args.sha), 'Expected a full commit SHA')
        require(args.image_id == '' or re.fullmatch(r'sha256:[0-9a-f]{64}', args.image_id), 'Expected an image ID')
        require(re.fullmatch(r'[0-9a-f]{64}', args.receipt_sha256), 'Expected a receipt SHA256')
        require(re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', args.bucket), 'Invalid bucket')
        require(re.fullmatch(r'[0-9]{0,20}(-[0-9]{1,3})?', args.run), 'Invalid run reference')
        require(1 <= args.ttl_hours <= MAX_TTL_HOURS, f'TTL must be 1..{MAX_TTL_HOURS} hours')
    elif args.command == 'teardown':
        require(0 < args.pr < 10**6, 'Invalid PR number')
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(ROOT / 'lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        handler = {'deploy': deploy, 'teardown': teardown, 'reap': reap, 'status': status,
                   'install-reaper': install_reaper}[args.command]
        result = handler(args)
    # One parseable line for preview.sh / CI; never contains env values.
    print('PREVIEW_RESULT ' + json.dumps({'command': args.command, 'result': result}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (PreviewError, ValueError) as error:
        print(f'Preview refused: {error}', file=sys.stderr)
        sys.exit(3)
