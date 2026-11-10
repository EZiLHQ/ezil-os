"""Explicit admission of the CURRENT legacy source; no target launch authority.

Only the source registry is changed. The cooperative app-secret lock, exact
VersionId/content checks and idempotent write token bind interruption recovery.
The journal contains hashes and nonsecret release/app identity, never the secret.
"""
import hashlib
import json
import re
import uuid

import rebase_manifest as manifest
import rebase_namespace as context

need = manifest.need


def sha(raw):
    return hashlib.sha256(raw.encode()).hexdigest()


def provider_evidence(release, source, config, build_arn):
    """Re-read the exact source, including immutable workflow observer settings."""
    tool = release.json_tool
    need(release.aws('sts', 'get-caller-identity')['Account'] == tool.ACCOUNT, 'source account mismatch')
    stack = release.aws('cloudformation', 'describe-stacks', '--stack-name', f'ezil-{tool.NAMESPACE}-lifecycle',
                        '--query', 'Stacks[0].{name:StackName,status:StackStatus,role:RoleARN,outputs:Outputs}')
    need(stack['name'] == f'ezil-{tool.NAMESPACE}-lifecycle' and stack['role'] == tool.ROLE and
         stack['status'] in ('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'), 'source lifecycle stack mismatch')
    for name, key in (('WorkflowVersionArn', 'stateMachineVersionArn'), ('RecoveryVersionArn', 'recoveryStateMachineVersionArn'),
                      ('PreparationVersionArn', 'preparationStateMachineVersionArn')):
        outputs = [v['OutputValue'] for v in stack['outputs'] if v['OutputKey'] == name or
                   manifest.matches(r'\w*' + name + r'[0-9A-F]{8}', v['OutputKey'])]
        need(outputs == ([] if source[key] is None else [source[key]]), 'source workflow stack output mismatch')
    release.source_readbacks(source)
    build = release.aws('imagebuilder', 'get-image', '--image-build-version-arn', build_arn)['image']
    release.validate_build(source, build_arn, build, source=True)
    repository, digest = manifest.image_ref(source['lowerImageRef'], repository=tool.REPOSITORY)
    result = release.aws('ecr', 'batch-get-image', '--registry-id', tool.ACCOUNT,
                         '--repository-name', repository.split('/', 1)[1], '--image-ids', 'imageDigest=' + digest)
    need(not result.get('failures') and len(result['images']) == 1, 'source lower readback incomplete')
    image = result['images'][0]
    raw = image['imageManifest']; lower = manifest.loads(raw)
    need(image['registryId'] == tool.ACCOUNT and image['repositoryName'] == repository.split('/', 1)[1] and
         image['imageId']['imageDigest'] == digest and 'sha256:' + sha(raw) == digest and
         lower.get('schemaVersion') == 2 and 'manifests' not in lower and
         source['lowerImageDigest'] in (digest, lower.get('config', {}).get('digest')), 'source lower identity mismatch')
    for key, variable in (('stateMachineVersionArn', 'EZIL_LIFECYCLE_SETTINGS'),
                          ('recoveryStateMachineVersionArn', 'EZIL_LIFECYCLE_RECOVERY_SETTINGS')):
        if source[key] is None: continue
        workflow = release.aws('stepfunctions', 'describe-state-machine', '--state-machine-arn', source[key])
        definition = manifest.loads(workflow['definition'])
        # Existing graphs invoke one immutable observer from their Task states.
        functions = set()
        for state in definition['States'].values():
            if state.get('Type') != 'Task': continue
            arn = state.get('Parameters', {}).get('FunctionName', state.get('Resource', ''))
            if ':lambda:' in arn and ':function:' in arn: functions.add(arn)
        need(len(functions) == 1, 'source immutable observer missing')
        arn = functions.pop()
        need(manifest.matches(rf'arn:aws:lambda:{tool.REGION}:{tool.ACCOUNT}:function:ezil-{tool.NAMESPACE}-lifecycle-[A-Za-z0-9_-]+:[1-9][0-9]*', arn),
             'source observer namespace/version mismatch')
        # Project only nonsecret workflow settings; never persist environment or provider logs.
        function = release.aws('lambda', 'get-function-configuration', '--function-name', arn,
                               '--query', '{arn:FunctionArn,version:Version,settings:Environment.Variables.' + variable + '}')
        need(function['arn'] == arn and function['version'] == arn.rsplit(':', 1)[1], 'source observer readback mismatch')
        settings = manifest.loads(function['settings'])
        expected = config['settings'] if key == 'stateMachineVersionArn' else {
            'lifecycle': config['settings'], 'recoveryVersionArn': source[key]}
        need(settings == expected, 'source observer settings/recovery mismatch')


def initialize(release, manifest_path, config_path, build_arn, app_path, ledger_path, apply=False, expected_version=None):
    tool = release.json_tool
    need(manifest.matches(r'[A-Za-z0-9-]{1,128}', expected_version), 'source-init requires expected secret VersionId')
    source = release.scoped_manifest(manifest_path, source=True)
    config = manifest.read(release.safe_path(config_path))
    deployment = release.staging(config)
    need(not (set(manifest.TUPLE) | {'releases'}) & deployment.keys(), 'source-init requires a legacy plain deployment')
    manifest.promoted_release(deployment, source)
    need(config.get('recoveryVersionArn') == source['recoveryStateMachineVersionArn'], 'legacy source recovery evidence mismatch')
    need(source['preparationStateMachineVersionArn'] is None and source['previousLowerImageDigest'] is None and
         source['previousLowerImageRef'] is None, 'legacy source cannot be a target')
    need(manifest.matches(rf'arn:aws:imagebuilder:{tool.REGION}:{tool.ACCOUNT}:image/ezil-host-{tool.NAMESPACE}/'
                          + re.escape(source['recipeVersion']) + r'/[1-9][0-9]*', build_arn), 'source build identity mismatch')
    app = manifest.read(release.safe_path(app_path))
    need(set(app) == {'tag', 'gitSha', 'checksumSha256'}, 'invalid source app artifact')
    installer = release.REPO / 'deploy/aws/os-staging/install-host.sh'
    release.rebase_app.body(release.safe_path(installer).read_text(), app, install=False)
    ledger_path = context.path(ledger_path)
    need(ledger_path.is_absolute(), 'absolute source ledger path required')
    directory = release.safe_path(manifest_path).parent
    journal_path = directory / 'source-registration.json'
    need(not journal_path.is_symlink(), 'source journal must not be a symlink')
    pins = dict(schemaVersion=1, namespace=tool.NAMESPACE, source=source, buildArn=build_arn,
                directory=str(directory.resolve()),
                expectedSecretVersion=expected_version, ledgerPath=str(ledger_path.absolute()),
                manifestSha256=release.digest(manifest_path), configSha256=release.digest(config_path),
                appSha256=release.digest(app_path), installerSha256=release.digest(installer))

    def recheck():
        need(release.digest(manifest_path) == pins['manifestSha256'] and
             release.digest(config_path) == pins['configSha256'] and release.digest(app_path) == pins['appSha256'] and
             release.digest(installer) == pins['installerSha256'], 'source-init reviewed input drift')
        provider_evidence(release, source, config, build_arn)

    def read(fd):
        return tool.secret_aws(['get-secret-value', '--secret-id', tool.SECRET, '--output', 'json'], lock_fd=fd)

    def app_check(d, name):
        result = release.app_operation(journal_path, {'rollout': {'app': app}}, name, True,
                                       release.rebase_app.public_deployment(d), install=False)
        need(result['gitSha'] == app['gitSha'], 'source-init running app identity mismatch')

    with tool.app_secret_lock() as fd:
        need(not ledger_path.exists() and not ledger_path.is_symlink(), 'source-init requires absent ledger')
        recheck()
        envelope = read(fd)
        _, d = release.secret_deployment(envelope)
        need(not set(manifest.TUPLE) & d.keys(), 'source-init live deployment must remain plain')
        manifest.promoted_release(d, source)
        need({k: v for k, v in d.items() if k != 'releases'} == deployment, 'source-init live deployment drift')
        journal = manifest.read(release.safe_path(journal_path)) if journal_path.exists() else None
        pair = tool.pair(config)
        if journal is None:
            need(envelope['VersionId'] == expected_version, 'source-init stale secret version')
            need('releases' not in d or d['releases'] == [], 'source-init requires an empty registry')
            updated = tool.edit_release_secret(envelope, pair, pair, [source])
            raw = json.dumps(updated, separators=(',', ':'))
            journal = {**pins, 'beforeSha256': sha(envelope['SecretString']), 'afterSha256': sha(raw),
                       'beforeDeployment': release.rebase_app.public_deployment(d), 'writeToken': str(uuid.uuid4())}
        else:
            need(set(journal) == set(pins) | {'beforeSha256', 'afterSha256', 'beforeDeployment', 'writeToken'} and
                 all(journal[k] == v for k, v in pins.items()) and
                 all(manifest.matches(r'[0-9a-f]{64}', journal[k]) for k in ('beforeSha256', 'afterSha256')) and
                 manifest.matches(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', journal['writeToken']),
                 'source-init journal drift')
            if envelope['VersionId'] == journal['writeToken']:
                raw = envelope['SecretString']
            else:
                updated = tool.edit_release_secret(envelope, pair, pair, [source])
                raw = json.dumps(updated, separators=(',', ':'))
        before = envelope['VersionId'] == expected_version and sha(envelope['SecretString']) == journal['beforeSha256']
        after = envelope['VersionId'] == journal['writeToken'] and sha(envelope['SecretString']) == journal['afterSha256']
        need(before or after, 'source-init secret drift')
        need(journal['beforeDeployment'] in (release.rebase_app.public_deployment(deployment),
             release.rebase_app.public_deployment({**deployment, 'releases': []})), 'source-init journal deployment drift')
        need(sha(raw) == journal['afterSha256'] and
             (d.get('releases', []) == [] if before else d.get('releases') == [source]), 'source-init registry drift')
        _, expected_d = release.secret_deployment({'SecretString': raw})
        if before: app_check(d, 'source-init-gate')
        else:
            running = release.app_operation(journal_path, {'rollout': {'app': app}}, 'source-init-resume-gate', True, install=False)
            need(running['gitSha'] == app['gitSha'] and running['deployment'] in
                 (journal['beforeDeployment'], release.rebase_app.public_deployment(expected_d)), 'source-init resume app drift')
        if not apply:
            need(before, 'partial admission requires exact apply reconciliation')
            print('DRY RUN: current source/provider/app/secret admission verified; no registry write')
            return
        if before:
            if not journal_path.exists(): tool.write(journal_path, journal)
            recheck()
            need(read(fd) == envelope, 'source-init secret changed before write')
            result = tool.secret_aws(['put-secret-value', '--cli-input-json', 'file:///dev/stdin', '--output', 'json'],
                json.dumps({'SecretId': tool.SECRET, 'SecretString': raw, 'ClientRequestToken': journal['writeToken']}), lock_fd=fd)
            need(result['VersionId'] == journal['writeToken'], 'source-init write version mismatch')
            envelope = read(fd)
        need(envelope['VersionId'] == journal['writeToken'] and sha(envelope['SecretString']) == journal['afterSha256'],
             'source-init secret readback mismatch')
        body = release.rebase_app.body(installer.read_text(), app, release.rebase_app.public_deployment(expected_d))
        receipt = release.rebase_ssm.run(directory, 'source-init-app', body, True, release.aws, tool.write, one_shot=True)
        need(receipt['gitSha'] == app['gitSha'] and receipt['killSwitch'] == '1' and
             receipt['deployment'] == release.rebase_app.public_deployment(expected_d), 'source-init app readback mismatch')
        app_check(expected_d, 'source-init-verify')
        recheck()
        check = read(fd)
        need(check == envelope and not ledger_path.exists(), 'source-init final input drift')
        entry = release.ledger_entry(journal_path, 'source-init', check, expected_d, app['gitSha'], 1)
        value = release.validate_ledger({'schemaVersion': 1, 'entries': [entry]})
        ledger_path.parent.mkdir(parents=True, exist_ok=True)
        tool.write(ledger_path, value)
        print('Legacy source retained; promotion ledger initialized. No rebase target authorized.')
