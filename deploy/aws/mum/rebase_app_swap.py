"""Image-pinned staging app-only swap and restore under the promotion ledger.

Replaces only the app identity (Git SHA and web image ID) while the kill switch
stays closed and the lifecycle tuple and registry stay unchanged. It installs
through the reviewed install-host.sh in exactly one one-shot SSM command; that
installer still re-renders the environment, recreates Compose services and
stops/re-enables the six timers, which the probes read back.

Offline tests exercise this module only with fakes. They do not prove a real
IAM, SSM-document or host fence: deploy.sh and raw AWS-RunShellScript remain
able to bypass the ledger, and the deploy.sh check is cooperative only.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tarfile

import rebase_app
import rebase_manifest as manifest
import rebase_release as release
import rebase_ssm

need = manifest.need
# Same image identity rules as the reviewed install-verified path.
spec = importlib.util.spec_from_file_location('install_receipt', Path(__file__).parents[1] / 'os-staging/install_receipt.py')
install_receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install_receipt)
PLAN_KEYS = {'schemaVersion', 'operation', 'ledgerGeneration', 'agentCommit', 'from', 'to', 'undoes', 'installerSha256'}
# The only paths either app may change relative to the baked host-agent commit.
ALLOWED = re.compile(r'shell/[^\0]+|app/public/os/bundle\.min\.js')
INSTALLER = 'deploy/aws/os-staging/install-host.sh'
SLUG = 'ezil-os-staging'
SMALL = 1024 * 1024
SECRET_DRIFT = 'app secret changed while pending; manual reconciliation required'
RECEIPT_UNVERIFIED = 'archive receipt does not match the inspected artifacts; run app-archive-check'
PROBE_KEYS = {'gitSha', 'killSwitch', 'deployment', 'imageId', 'tagImageId', 'composeTag', 'composeImageId', 'servedSha', 'timers', 'lockFree'}
METADATA = ('manifest.json', 'repositories', 'index.json')
OCI_MANIFESTS = ('application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json')
OCI_INDEXES = ('application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json')
# install-host.sh extracts exactly these runtime members and runs render-env.py as root.
RUNTIME = ('compose.yaml', 'Caddyfile', 'render-env.py',
           *(f'cron/ezil-os-staging-{job}.{kind}' for job in rebase_app.JOBS for kind in ('service', 'timer')))


def load_plan(path):
    value = manifest.read(release.safe_path(path))
    need(isinstance(value, dict) and set(value) == PLAN_KEYS and type(value['schemaVersion']) is int and value['schemaVersion'] == 1,
         'invalid app plan')
    need(value['operation'] in release.APP_OPERATIONS and type(value['ledgerGeneration']) is int and value['ledgerGeneration'] > 0 and
         manifest.matches(r'[0-9a-f]{40}', value['agentCommit']) and manifest.matches(r'[0-9a-f]{64}', value['installerSha256']),
         'invalid app plan')
    src, dst = value['from'], value['to']
    need(isinstance(src, dict) and set(src) == {'tag', 'gitSha', 'imageId'} and isinstance(dst, dict) and
         set(dst) == {'tag', 'gitSha', 'imageId', 'checksumSha256'}, 'invalid app plan identities')
    for side in (src, dst):
        need(manifest.matches(r'[0-9a-f]{40}', side['gitSha']) and manifest.matches(r'sha256:[0-9a-f]{64}', side['imageId']) and
             manifest.matches(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', side['tag']), 'invalid app plan identities')
    need(manifest.matches(r'[0-9a-f]{64}', dst['checksumSha256']), 'invalid app artifact pin')
    need(src['gitSha'] != dst['gitSha'] and src['imageId'] != dst['imageId'] and src['tag'] != dst['tag'], 'app plan must change the whole app')
    need(value['undoes'] is None if value['operation'] == 'app-swap' else manifest.matches(r'[0-9a-f]{64}', value['undoes']),
         'invalid restore link')
    return value


def git_file(source_repo, sha, path):
    result = subprocess.run(['git', '-C', str(source_repo), 'show', sha + ':' + path],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90, check=False)
    need(result.returncode == 0, 'app plan source commits unavailable')
    return result.stdout


def check_source(plan, source_repo):
    """Both apps may differ from the baked host-agent commit only in the shell bundle allowlist."""
    for sha in (plan['from']['gitSha'], plan['to']['gitSha']):
        result = subprocess.run(['git', '-C', str(source_repo), 'diff', '--no-renames', '--name-only', '-z', plan['agentCommit'], sha],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90, check=False)
        need(result.returncode == 0, 'app plan source commits unavailable')
        names = [name for name in result.stdout.decode('utf-8').split('\0') if name]
        need(all(ALLOWED.fullmatch(name) for name in names), 'app plan changes paths outside the shell bundle allowlist')


def receipt_path(plan_path):
    return Path(plan_path).parent / 'app-archive-receipt.json'


def scan_archive(path):
    """SHA-256 of the gzip file, the bytes of every small regular member, and every member name with its tar type."""
    digest = hashlib.sha256()

    class Reader:
        def __init__(self, raw):
            self.raw = raw

        def read(self, size=-1):
            chunk = self.raw.read(size)
            digest.update(chunk)
            return chunk

    members, names = {}, {}
    with release.safe_path(path).open('rb') as raw:
        reader = Reader(raw)
        with tarfile.open(fileobj=reader, mode='r|gz') as bundle:
            for member in bundle:
                need(member.name not in names, 'duplicate archive member')
                names[member.name] = member.type
                if member.isfile() and member.size <= SMALL:
                    members[member.name] = bundle.extractfile(member).read()
        while reader.read(SMALL):
            pass
    return digest.hexdigest(), members, names


def archive_tags(members, names, tag, image_id, source):
    """Every docker-save tagging record must name exactly SLUG:tag for the pinned image of source.

    The image ID is the config digest, as install_receipt.py derives it. That equals
    the host's image ID on the classic Docker store; the before-probe proves it for
    the running image on the target host, and refuses before any mutation otherwise.
    """
    # Oversized or non-regular tagging metadata would otherwise be skipped, not refused.
    need(all(name in members for name in METADATA if name in names), 'archive tagging metadata is not inspectable')
    entries = manifest.loads(members.get('manifest.json', b'null').decode('utf-8'))
    need(isinstance(entries, list) and len(entries) == 1 and isinstance(entries[0], dict), 'archive must contain exactly one image')
    need(entries[0].get('RepoTags') == [SLUG + ':' + tag], 'archive would tag an unexpected name')
    name = entries[0].get('Config')
    config = members.get(name)
    need(isinstance(name, str) and re.fullmatch(r'(?:[0-9a-f]{64}\.json|blobs/sha256/[0-9a-f]{64})', name) and config is not None and
         hashlib.sha256(config).hexdigest() in (name.removesuffix('.json'), name.removeprefix('blobs/sha256/')), 'invalid archive config')
    need('sha256:' + hashlib.sha256(config).hexdigest() == image_id, 'archive image ID differs from the plan')
    install_receipt.image_metadata(manifest.loads(config.decode('utf-8')), source)
    public = manifest.loads(config.decode('utf-8')).get('config', {}).get('Labels', {}).get('work.ezil.public-config-sha256')
    need(public is None or manifest.matches(r'[0-9a-f]{64}', public), 'invalid public configuration label')
    if 'repositories' in members:
        repositories = manifest.loads(members['repositories'].decode('utf-8'))
        need(isinstance(repositories, dict) and set(repositories) == {SLUG} and isinstance(repositories[SLUG], dict) and
             set(repositories[SLUG]) == {tag}, 'archive would tag an unexpected name')
    if 'index.json' in members:
        index = manifest.loads(members['index.json'].decode('utf-8'))
        need(isinstance(index, dict) and isinstance(index.get('manifests'), list) and len(index['manifests']) == 1, 'invalid archive index')
        for item in index['manifests']:
            # An absent name annotation creates no tag; a present one must be exactly this tag.
            annotations = (item.get('annotations') or {}) if isinstance(item, dict) else None
            need(isinstance(annotations, dict) and
                 annotations.get('io.containerd.image.name', 'docker.io/library/' + SLUG + ':' + tag) == 'docker.io/library/' + SLUG + ':' + tag and
                 annotations.get('org.opencontainers.image.ref.name', tag) == tag, 'archive would tag an unexpected name')
            # docker load follows the index, not manifest.json: the tagged descriptor must reach the pinned config.
            need(index_config(members, item) == image_id, 'archive index does not name the pinned image')
    return public


def index_config(members, descriptor, nested=False):
    """Config digest an index descriptor resolves to, through content-addressed blobs.

    At most one nested index (the containerd image store's form), holding exactly one image manifest
    besides attestation manifests, which carry no runnable image. Anything else is refused.
    """
    digest = descriptor.get('digest') if isinstance(descriptor, dict) else None
    need(isinstance(digest, str) and manifest.matches(r'sha256:[0-9a-f]{64}', digest), 'invalid archive index')
    blob = members.get('blobs/sha256/' + digest.removeprefix('sha256:'))
    need(blob is not None and 'sha256:' + hashlib.sha256(blob).hexdigest() == digest, 'archive index is not inspectable')
    document = manifest.loads(blob.decode('utf-8'))
    media = descriptor.get('mediaType')
    need(isinstance(document, dict) and document.get('mediaType', media) == media, 'invalid archive index')
    if media in OCI_MANIFESTS:
        config = document.get('config')
        return config.get('digest') if isinstance(config, dict) else None
    need(media in OCI_INDEXES and not nested and isinstance(document.get('manifests'), list), 'invalid archive index')
    images = [item for item in document['manifests'] if not (isinstance(item, dict) and isinstance(item.get('annotations'), dict) and
                                                             item['annotations'].get('vnd.docker.reference.type') == 'attestation-manifest')]
    need(len(images) == 1, 'invalid archive index')
    return index_config(members, images[0], nested=True)


def runtime_check(runtime, sha, plan, source_repo):
    """The runtime archive install-host.sh extracts must equal the baked commit's files, byte for byte."""
    digest, members, names = scan_archive(runtime)
    need(digest == sha, 'runtime archive differs from the checksum marker')
    # As install-host.sh: an entry named cron may only be a directory; every other member is a regular file.
    need(set(names) - {'cron'} == set(RUNTIME) and set(members) == set(RUNTIME) and names.get('cron', tarfile.DIRTYPE) == tarfile.DIRTYPE,
         'invalid runtime archive members')
    for name in RUNTIME:
        path = 'deploy/aws/os-staging/' + name
        need(members[name] == git_file(source_repo, plan['agentCommit'], path) == git_file(source_repo, plan['to']['gitSha'], path),
             'runtime archive differs from the baked source')
    return digest


def inspect_artifacts(plan_path, plan, archive, checksum, runtime, source_repo):
    """Local preflight of the exact archive bytes the checksum marker pins, before any docker load."""
    dst = plan['to']
    marker = release.safe_path(checksum).read_bytes()
    need(hashlib.sha256(marker).hexdigest() == dst['checksumSha256'], 'checksum marker differs from the plan pin')
    lines = marker.decode('utf-8').splitlines()
    pinned = re.fullmatch(r'([0-9a-f]{64})  ' + re.escape(dst['tag'] + '.tar.gz'), lines[0]) if len(lines) == 2 else None
    runtime_pin = re.fullmatch(r'([0-9a-f]{64})  ' + re.escape(dst['tag'] + '.runtime.tar.gz'), lines[1]) if len(lines) == 2 else None
    need(pinned is not None and runtime_pin is not None, 'invalid checksum marker')
    sha, members, names = scan_archive(archive)
    need(sha == pinned.group(1), 'image archive differs from the checksum marker')
    public = archive_tags(members, names, dst['tag'], dst['imageId'], dst['gitSha'])
    runtime_sha = runtime_check(runtime, runtime_pin.group(1), plan, source_repo)
    # Evidence for the operator: compare with the approved staging public configuration.
    return {'planSha256': release.digest(plan_path), 'tag': dst['tag'], 'imageId': dst['imageId'],
            'checksumSha256': dst['checksumSha256'], 'archiveSha256': sha, 'runtimeSha256': runtime_sha, 'publicConfigSha256': public,
            'archivePath': str(archive), 'checksumPath': str(checksum), 'runtimePath': str(runtime)}


def archive_check(plan_path, archive, checksum, runtime, source_repo, apply):
    receipt = inspect_artifacts(plan_path, load_plan(plan_path), archive, checksum, runtime, source_repo)
    if apply:
        release.json_tool.write(receipt_path(plan_path), receipt)
    print(('Archive receipt written: ' if apply else 'DRY RUN: archive verified: ') + receipt['tag'])
    return receipt


def require_receipt(plan_path, plan, source_repo):
    """The receipt is a claim, not proof: inspect the artifacts it names again and require the same result.

    install-host.sh checks both downloaded archives against the plan-pinned marker before docker load,
    so equal hashes here mean the host loads exactly the bytes inspected here.
    """
    need(receipt_path(plan_path).is_file(), 'archive receipt missing; run app-archive-check')
    receipt = manifest.read(release.safe_path(receipt_path(plan_path)))
    paths = ('archivePath', 'checksumPath', 'runtimePath')
    need(isinstance(receipt, dict) and all(isinstance(receipt.get(key), str) for key in paths), RECEIPT_UNVERIFIED)
    try:
        inspected = inspect_artifacts(plan_path, plan, *(receipt[key] for key in paths), source_repo)
    except (ValueError, OSError, tarfile.TarError, UnicodeDecodeError):
        inspected = None
    need(inspected == receipt, RECEIPT_UNVERIFIED)


def probe(plan_path, operation, tag):
    result = rebase_ssm.run(Path(plan_path).parent, operation, rebase_app.probe_body(tag), True,
                            release.aws, release.json_tool.write, fresh=True)
    need(isinstance(result, dict) and set(result) == PROBE_KEYS and isinstance(result['timers'], dict), 'invalid app probe readback')
    return result


def timers_running(observed):
    timers = observed['timers']
    return set(timers) == set(rebase_app.JOBS) and all(
        isinstance(t, dict) and t.get('enabled') == 'enabled' and t.get('active') == 'active' for t in timers.values())


def services_idle(observed):
    return all(t.get('service') in ('inactive', 'failed') for t in observed['timers'].values())


def at(observed, side, deployment):
    # compose.env names the image a later restart or recreate would run; its tag must still resolve to
    # this side's image. Caddy must serve this side's SHA from /api/health.
    return (observed['gitSha'], observed['imageId'], observed['composeTag'], observed['composeImageId'], observed['servedSha'],
            observed['killSwitch'], observed['deployment']) == \
        (side['gitSha'], side['imageId'], side['tag'], side['imageId'], side['gitSha'], '1', deployment) and timers_running(observed)


def other_in_flight():
    """Evidence only: unfinished SSM commands that may reach the host. It cannot see non-SSM host access.

    ListCommands rejects --instance-id together with Status=Pending and has no Cancelling filter, so
    list the account's executing and pending commands and inspect their targets. A command addressed
    by Targets lists no instance IDs; it cannot be ruled out and counts as in flight.
    """
    for selector in ({'key': 'ExecutionStage', 'value': 'Executing'}, {'key': 'Status', 'value': 'Pending'}):
        response = release.aws('ssm', 'list-commands', '--filters', json.dumps([selector]))
        need(not response.get('NextToken') and isinstance(response.get('Commands'), list), 'incomplete SSM listing')
        for command in response['Commands']:
            targets = command.get('InstanceIds') if isinstance(command, dict) else None
            if not targets or rebase_ssm.HOST in targets:
                return True
    return False


def read_secret(fd):
    return release.json_tool.secret_aws(['get-secret-value', '--secret-id', release.json_tool.SECRET, '--output', 'json'], lock_fd=fd)


def terminal(ledger_path, ledger, pending, state, envelope, d, side):
    entry = {'generation': pending['generation'] + 1, 'planSha256': pending['planSha256'], 'operation': pending['operation'],
             'state': state, **release.observed_state(envelope, d, side['gitSha']), 'appImageId': side['imageId']}
    release.validate_ledger({**ledger, 'entries': [*ledger['entries'], entry]})
    return release.write_ledger_append(ledger_path, ledger, entry)


def admit_before(plan_path, plan, generation, deployment):
    before = probe(plan_path, f'app-probe-g{generation}-before', plan['to']['tag'])
    need(at(before, plan['from'], deployment), 'live app differs from the plan before-state')
    need(before['lockFree'] and services_idle(before) and not other_in_flight(), 'staging host is not quiescent')
    # docker load would move an existing tag before any post-load inspection.
    need(before['tagImageId'] in (None, plan['to']['imageId']), 'candidate tag already names another image')


def swap(plan_path, source_repo, apply, ledger_path=None):
    ledger_path = Path(ledger_path or release.LEDGER_PATH)
    plan = load_plan(plan_path)
    plan_sha = release.digest(plan_path)
    src, dst = plan['from'], plan['to']
    # One snapshot: the bytes hashed here are the bytes sent, whatever happens to the file later.
    installer = release.safe_path(release.REPO / INSTALLER).read_bytes()
    need(hashlib.sha256(installer).hexdigest() == plan['installerSha256'], 'staging installer changed')
    check_source(plan, source_repo)
    require_receipt(plan_path, plan, source_repo)
    with release.json_tool.app_secret_lock() as fd:
        envelope = read_secret(fd)
        _, d = release.secret_deployment(envelope)
        deployment = rebase_app.public_deployment(d)
        ledger = release.load_ledger(ledger_path)
        latest = ledger['entries'][-1]
        admitted = False
        if latest.get('state') == 'pending':
            need(latest['planSha256'] == plan_sha and latest['operation'] == plan['operation'], 'pending operation of another plan; run ledger-reconcile')
            # The installer re-renders the environment from the current secret: resuming after a rotation would change non-app state.
            need(envelope['VersionId'] == latest['before']['secretVersionId'], SECRET_DRIFT)
            need(latest['expected'] == {**release.release_state(d, dst['gitSha']), 'appImageId': dst['imageId']}, 'ledger drift')
            pending = latest
        else:
            live = release.release_state(d, src['gitSha'])
            need(latest['generation'] == plan['ledgerGeneration'], 'stale plan: ledger generation advanced')
            need((latest['tuple'], latest.get('registrySha256'), latest['appGitSha']) == (live['tuple'], live['registrySha256'], src['gitSha']) and
                 (latest['operation'] not in release.APP_OPERATIONS or latest['appImageId'] == src['imageId']), 'ledger drift')
            if plan['operation'] == 'app-restore':
                undone = ledger['entries'][-2] if len(ledger['entries']) > 1 else None
                need(latest['operation'] == 'app-swap' and latest['planSha256'] == plan['undoes'] and undone is not None and
                     undone.get('state') == 'pending' and undone['planSha256'] == plan['undoes'] and
                     (undone['before']['appGitSha'], undone['before']['appImageId']) == (dst['gitSha'], dst['imageId']),
                     'app-restore must undo the latest completed app-swap')
            pending = {'generation': latest['generation'] + 1, 'planSha256': plan_sha, 'operation': plan['operation'], 'state': 'pending',
                       'before': {**release.observed_state(envelope, d, src['gitSha']), 'appImageId': src['imageId']},
                       'expected': {**release.release_state(d, dst['gitSha']), 'appImageId': dst['imageId']}}
            release.validate_ledger({**ledger, 'entries': [*ledger['entries'], pending]})
            if not apply:
                print(f'DRY RUN: would probe, append pending {plan["operation"]} generation {pending["generation"]} and send one install')
                return
            admit_before(plan_path, plan, pending['generation'], deployment)
            need(read_secret(fd) == envelope, 'app secret changed during admission')
            ledger = release.write_ledger_append(ledger_path, ledger, pending)
            admitted = True
        if not apply:
            print(f'DRY RUN: {plan["operation"]} generation {pending["generation"]} is pending; apply resumes its one command')
            return
        operation = f'{plan["operation"]}-g{pending["generation"]}'
        journal = Path(plan_path).parent / (operation + '-ssm.json')
        if not admitted and (not journal.exists() or manifest.read(journal)['status'] == 'uploading'):
            # Nothing was sent yet; re-establish the before-state after any crash.
            admit_before(plan_path, plan, pending['generation'], deployment)
        app = {'tag': dst['tag'], 'gitSha': dst['gitSha'], 'checksumSha256': dst['checksumSha256']}
        rebase_ssm.run(Path(plan_path).parent, operation, rebase_app.body(installer.decode('utf-8'), app, deployment), True,
                       release.aws, release.json_tool.write, one_shot=True)
        after = probe(plan_path, f'app-probe-g{pending["generation"]}-after', dst['tag'])
        need(at(after, dst, deployment), 'post-install state differs; run app-swap-reconcile')
        # As reconciliation: another install still queued or holding deploy.lock could replace the app after this row closes.
        need(after['lockFree'] and services_idle(after) and not other_in_flight(), 'staging host is not proven quiescent; retain the fence')
        check = read_secret(fd)
        need(check['VersionId'] == envelope['VersionId'], 'app secret changed during app swap')
        terminal(ledger_path, ledger, pending, 'completed', check, d, dst)
    print(f'{plan["operation"]} completed generation {pending["generation"] + 1}: {src["gitSha"][:12]} -> {dst["gitSha"][:12]}; '
          'kill switch remains closed')


def reconcile(plan_path, apply, ledger_path=None):
    """Close this plan's pending entry only from two quiescent probes matching exactly before or expected."""
    ledger_path = Path(ledger_path or release.LEDGER_PATH)
    plan = load_plan(plan_path)
    src, dst = plan['from'], plan['to']
    with release.json_tool.app_secret_lock() as fd:
        ledger = release.load_ledger(ledger_path)
        pending = ledger['entries'][-1]
        need(pending.get('state') == 'pending' and pending['planSha256'] == release.digest(plan_path),
             'app-swap-reconcile requires this plan pending entry')
        need(rebase_ssm.generation_terminal(Path(plan_path).parent, pending['generation'], release.aws),
             'remote command not terminal; wait or cancel')
        envelope = read_secret(fd)
        # After a rotation the host may have rendered either secret version; only the owner can tell.
        need(envelope['VersionId'] == pending['before']['secretVersionId'], SECRET_DRIFT)
        _, d = release.secret_deployment(envelope)
        deployment = rebase_app.public_deployment(d)
        if not apply:
            print('DRY RUN: remote commands terminal; apply probes the host twice before closing the fence')
            return
        first = probe(plan_path, f'app-probe-g{pending["generation"]}-reconcile-a', dst['tag'])
        second = probe(plan_path, f'app-probe-g{pending["generation"]}-reconcile-b', dst['tag'])
        need(first['lockFree'] and second['lockFree'] and (first['gitSha'], first['imageId']) == (second['gitSha'], second['imageId']) and
             services_idle(second) and not other_in_flight(), 'staging host is not proven quiescent; retain the fence')
        side, state = (dst, 'completed') if at(second, dst, deployment) else (src, 'aborted') if at(second, src, deployment) else (None, None)
        if side is None:
            # Nonsecret identities and timer names only.
            print(json.dumps({'gitSha': {'live': second['gitSha'], 'before': src['gitSha'], 'expected': dst['gitSha']},
                              'imageId': {'before': second['imageId'] == src['imageId'], 'expected': second['imageId'] == dst['imageId']},
                              'composeTag': {'live': second['composeTag'], 'before': src['tag'], 'expected': dst['tag']},
                              'composeImageId': {'before': second['composeImageId'] == src['imageId'], 'expected': second['composeImageId'] == dst['imageId']},
                              'servedSha': {'live': second['servedSha'], 'before': src['gitSha'], 'expected': dst['gitSha']},
                              'deploymentMatches': second['deployment'] == deployment,
                              'timersNotRunning': sorted(k for k, t in second['timers'].items()
                                                         if t.get('enabled') != 'enabled' or t.get('active') != 'active')}, sort_keys=True))
            need(False, 'manual reconciliation required')
        check = read_secret(fd)
        need(check['VersionId'] == envelope['VersionId'], 'app secret changed during reconciliation')
        terminal(ledger_path, ledger, pending, state, check, d, side)
    print('App operation reconciled: ' + state)


def cli(args):
    need(args.plan is not None and args.manifest is None, args.operation + ' requires --plan')
    if args.operation == 'app-archive-check':
        need(args.archive is not None and args.checksum is not None and args.runtime is not None and args.source_repo is not None,
             'app-archive-check requires --archive, --checksum, --runtime and --source-repo')
        archive_check(args.plan, args.archive, args.checksum, args.runtime, args.source_repo, args.apply)
    elif args.operation == 'app-swap':
        need(args.source_repo is not None, 'app-swap requires --source-repo')
        swap(args.plan, args.source_repo, args.apply, args.ledger)
    else:
        reconcile(args.plan, args.apply, args.ledger)
