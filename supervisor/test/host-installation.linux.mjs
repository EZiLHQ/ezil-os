import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readlink, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { hash, units } from '../deploy/host-release.mjs';

// Only the retained QEMU mount-operation fixture is accepted, never a real
// computer. Test provisioning below is explicit and separate from installation.
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
const [phase, source] = process.argv.slice(2); assert.ok(['install', 'verify'].includes(phase));
assert.equal(process.argv.length, 4); assert.equal(resolve(source), source);
const exec = promisify(execFile), command = (file, args, timeout = 30000) => exec(file, args, { timeout, maxBuffer: 1048576,
    env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
const ctl = (...args) => command('/usr/bin/systemctl', ['--no-pager', ...args], 90000);
assert.equal((await command('/usr/bin/systemd-detect-virt', ['--vm'])).stdout.trim(), 'qemu');
assert.equal((await command('/usr/bin/docker', ['ps', '-aq'])).stdout.trim(), '');
const root = '/opt/ezil-supervisor', configRoot = '/etc/ezil-supervisor', saved = '/var/lib/ezil-host-installation-test.json';
const manifest = await readFile(join(source, 'release.json')), digest = hash(manifest), destination = `${root}/releases/${digest}`;
const installer = new URL('../deploy/install-host.mjs', import.meta.url).pathname;
const install = (expected = digest) => command('/usr/local/bin/node', [installer, source, expected], 120000);
const failed = run => assert.rejects(run, error => error.code === 1 && error.stdout === '' && error.stderr === '{"code":"host_installation_unconfirmed"}\n');
const absent = path => assert.rejects(lstat(path), { code: 'ENOENT' });
const plan = { schemaVersion: 1, computerId: '55555555-5555-4555-8555-555555555555', volumeId: 'vol-33333333333333333',
    filesystemUuid: '44444444-4444-4444-8444-444444444444', mode: 'mount' };
const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
async function durable(path, bytes) {
    const f = await open(path, 'wx', 0o600); try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
    const d = await open(configRoot, 'r'); try { await d.sync(); } finally { await d.close(); }
}
if (phase === 'install') {
    await absent(root); await absent(configRoot); await absent(saved);
    await failed(install('0'.repeat(64))); await absent(root);
    const target = join(source, 'payload/dist/host.js'), bytes = await readFile(target);
    await writeFile(target, 'changed'); await failed(install()); await absent(root); await writeFile(target, bytes);
    await rename(target, `${target}.retained`); await symlink('host.js.retained', target);
    try { await failed(install()); await absent(root); } finally { await unlink(target); await rename(`${target}.retained`, target); }
    console.log('PASS wrong release digest, modified bytes and symlink input fail before installation');

    const result = JSON.parse((await install()).stdout); assert.equal(result.state, 'installed'); assert.equal(result.releaseDigest, digest);
    assert.deepEqual(JSON.parse((await install()).stdout), result);
    assert.equal(await readlink(`${root}/current`), `releases/${digest}`); assert.equal(await readlink(`${root}/dist`), 'current/dist');
    assert.equal(await realpath(`${root}/dist/host.js`), `${destination}/dist/host.js`);
    await absent(configRoot); // No computer keys, authority, disk plans or application state were generated.
    assert.notEqual((await ctl('show', 'ezil-supervisor.service', '--property=ActiveState', '--value')).stdout.trim(), 'active');
    for (const name of units) {
        assert((await readFile(`/etc/systemd/system/${name}`)).equals(await readFile(join(source, 'payload/deploy', name))));
        assert.equal((await ctl('show', name, '--property=FragmentPath', '--value')).stdout.trim(), `/etc/systemd/system/${name}`);
    }
    const marker = `${destination}/unlisted.js`; await writeFile(marker, 'extra');
    try { await failed(install()); } finally { await unlink(marker); }
    const installed = `${destination}/dist/host.js`; await chmod(installed, 0o666);
    try { await failed(install()); } finally { await chmod(installed, 0o644); }
    const other = Buffer.from(JSON.stringify({ ...JSON.parse(manifest), sourceCommit: '0'.repeat(40) }));
    await writeFile(join(source, 'release.json'), other);
    try { await failed(install(hash(other))); } finally { await writeFile(join(source, 'release.json'), manifest); }
    assert.equal(await readlink(`${root}/current`), `releases/${digest}`);
    console.log('PASS root-owned release, exact units and repeat installation; unknown files, permissive code and implicit upgrades are rejected');

    for (const [path, code] of [['dist/delivery-operation.js', 'delivery_operation_failed'], ['current/dist/mount-operation.js', 'mount_operation_failed']]) {
        await assert.rejects(command('/usr/local/bin/node', [`${root}/${path}`, 'invalid']), e =>
            e.code === 1 && e.stderr === `{"code":"${code}"}\n`);
    }
    for (const name of [`ezil-configuration@prepare-${randomUUID()}.service`, `ezil-mount@mount-${randomUUID()}.service`]) {
        await assert.rejects(ctl('start', name));
        assert.equal((await ctl('show', name, '--property=Result', '--value')).stdout.trim(), 'exit-code');
        assert.equal((await ctl('show', name, '--property=MainPID', '--value')).stdout.trim(), '0');
        await ctl('reset-failed', name);
    }
    console.log('PASS both shipped operation paths execute and missing authority fails in their actual systemd units');

    await mkdir(configRoot, { mode: 0o700 });
    await durable(`${configRoot}/data-volume.json`, JSON.stringify(plan));
    await durable(`${configRoot}/control.key`, randomBytes(32));
    await durable(`${configRoot}/config.json`, JSON.stringify({ schemaVersion: 1, computerId: plan.computerId, computerGeneration: 1,
        configurationRevision: 1, volumeId: plan.volumeId, dataRoot: '/srv/ezil-data', stateDirectory: '/var/lib/ezil-supervisor',
        stagingRoot: '/run/ezil-supervisor/mounts', controlPort: 24818, memoryBudgetMiB: 2048, suspended: false,
        preparedInstallations: [], approvedInstallations: [] }));
    await writeFile(saved, JSON.stringify({ bootId, digest }), { flag: 'wx', mode: 0o600 });
    await ctl('enable', 'ezil-supervisor.service', 'ezil-data-mount.service'); await ctl('start', 'ezil-supervisor.service');
} else {
    const old = JSON.parse(await readFile(saved)); assert.notEqual(old.bootId, bootId); assert.equal(old.digest, digest);
    assert.equal((await ctl('is-active', 'ezil-supervisor.service')).stdout.trim(), 'active');
}
// Load the installed release itself, not test-tree replacements.
const { signControlRequest } = await import(`${destination}/dist/control-auth.js`);
const { canonicalJson } = await import(`${destination}/dist/control-protocol.js`);
const secret = await readFile(`${configRoot}/control.key`), configuration = JSON.parse(await readFile(`${configRoot}/config.json`));
async function request(signed = true, computerId = plan.computerId) {
    const body = Buffer.from(JSON.stringify({ schemaVersion: 1, requestId: randomUUID(), computerId, computerGeneration: 1, operation: 'configuration' }));
    return fetch('http://127.0.0.1:24818/v1/control', { method: 'POST', body, signal: AbortSignal.timeout(2000),
        headers: { 'content-type': 'application/json', ...(signed ? signControlRequest('POST', '/v1/control', body, secret) : {}) } });
}
try {
    let response;
    for (let n = 0; n < 100; n++) { try { response = await request(); if (response.status === 200) break; await response.body?.cancel(); } catch {} await delay(100); }
    assert.equal(response?.status, 200);
    assert.deepEqual(await response.json(), { computerId: plan.computerId, computerGeneration: 1, configurationRevision: 1, configurationDigest: hash(canonicalJson(configuration)) });
    const unsigned = await request(false), foreign = await request(true, randomUUID());
    assert.equal(unsigned.status, 401); assert.equal(foreign.status, 403); await unsigned.body?.cancel(); await foreign.body?.cancel();
    assert.equal(await readFile('/srv/ezil-data/Documents/renamed', 'utf8'), 'persisted operation\n');
    await absent('/srv/ezil-data/Documents/deleted'); assert.equal(await readFile('/srv/ezil-data/Projects/ssm-test/.git/config', 'utf8'), 'git state\n');
    const db = new DatabaseSync('/srv/ezil-data/Projects/ssm-test/state.sqlite', { readOnly: true });
    try { assert.deepEqual(db.prepare('SELECT value FROM state').all().map(r => r.value), ['committed']); } finally { db.close(); }
    assert.equal((await command('/usr/bin/docker', ['ps', '-aq'])).stdout.trim(), '');
    console.log(`PASS installed supervisor ${phase}: signed loaded configuration, cross-computer denial and retained filesystem/SQLite; no apps started`);
} finally { secret.fill(0); await ctl('stop', 'ezil-supervisor.service'); }
