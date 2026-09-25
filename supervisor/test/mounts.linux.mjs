// Runs in the local privileged Linux harness, never as an application. A
// private loop filesystem models the data disk; this is not EBS acceptance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { open, mkdir, writeFile, rename, symlink, readFile, rm, rmdir, chown, chmod } from 'node:fs/promises';
import { request } from 'node:http';
import { openHostDirectory, openDataDirectory, stageDataDirectory } from '../dist/mounts.js';

const root = process.env.EZIL_TEST_ROOT;
const image = process.env.EZIL_TEST_IMAGE;
assert.match(root ?? '', /^\/run\/ezil-mount-test-[a-f0-9-]{36}$/);
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
const run = (bin, args) => execFileSync(bin, args, { stdio: 'pipe', timeout: 30_000 });
const containers = new Set();
const stages = [];
let diskMounted = false;
let disk;

async function docker(method, path, value) {
    return new Promise((resolve, reject) => {
        const body = value === undefined ? undefined : JSON.stringify(value);
        const req = request({ socketPath: '/var/run/docker.sock', method, path: `/v1.45${path}`,
            headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`docker_${res.statusCode}`));
                resolve(text ? JSON.parse(text) : undefined);
            });
        });
        req.setTimeout(30_000, () => req.destroy(new Error('docker_timeout')));
        req.on('error', reject);
        req.end(body);
    });
}

async function readInContainer(stage, writable) {
    const code = `const fs = require('fs');
        if(fs.readFileSync('/project/sentinel','utf8') !== 'selected') process.exit(41);
        try { fs.writeFileSync('/project/write-test', 'ok'); if(!${writable}) process.exit(42); }
        catch(e) { if(${writable} || e.code !== 'EROFS') process.exit(43); }`;
    const { Id } = await docker('POST', '/containers/create', {
        Image: image, User: '1000:1000', Entrypoint: ['node', '-e', code],
        Labels: { 'org.ezil.test': root }, NetworkDisabled: true,
        HostConfig: { ReadonlyRootfs: true, NetworkMode: 'none', CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'], Memory: 134217728, PidsLimit: 64,
            Mounts: [{ Type: 'bind', Source: stage.source, Target: '/project',
                ReadOnly: !writable, BindOptions: { Propagation: 'rprivate', NonRecursive: true } }] },
    });
    containers.add(Id);
    await docker('POST', `/containers/${Id}/start`);
    const result = await docker('POST', `/containers/${Id}/wait?condition=not-running`);
    assert.equal(result.StatusCode, 0, 'Docker must see only the pinned inode and enforce writes');
    const inspected = await docker('GET', `/containers/${Id}/json`);
    assert.equal(inspected.Mounts[0].Source, stage.source);
    assert(!inspected.Mounts[0].Source.startsWith('/proc/'));
    await docker('DELETE', `/containers/${Id}`);
    containers.delete(Id);
}

try {
    await mkdir(`${root}/disk`);
    await mkdir(`${root}/stage`);
    const file = await open(`${root}/disk.img`, 'wx');
    await file.truncate(64 * 1024 * 1024);
    await file.close();
    run('/usr/sbin/mkfs.ext4', ['-q', '-F', `${root}/disk.img`]);
    run('/bin/mount', ['-o', 'loop', `${root}/disk.img`, `${root}/disk`]);
    diskMounted = true;
    await mkdir(`${root}/disk/Projects`);
    await mkdir(`${root}/disk/Projects/selected`);
    await chown(`${root}/disk/Projects/selected`, 1000, 1000);
    await mkdir(`${root}/disk/private`);
    await writeFile(`${root}/disk/Projects/selected/sentinel`, 'selected');
    await writeFile(`${root}/disk/private/sentinel`, 'not-authorized');
    disk = await openHostDirectory(`${root}/disk`);
    await assert.rejects(openDataDirectory(disk, ['..', 'private']), /invalid_data_directory/);
    await assert.rejects(openDataDirectory(disk, ['Projects/selected']), /invalid_data_directory/);

    const selected = await openDataDirectory(disk, ['Projects', 'selected']);
    // This is the exact validation/start race: swap the path AFTER opening,
    // BEFORE mounting or asking the real Docker daemon to start its reader.
    await rename(`${root}/disk/Projects/selected`, `${root}/disk/Projects/moved`);
    await symlink('../private', `${root}/disk/Projects/selected`);
    await assert.rejects(openDataDirectory(disk, ['Projects', 'selected']), /unsafe_data_directory/);
    const stage = await stageDataDirectory(selected, `${root}/stage`, 'pinned', false);
    stages.push(stage);
    await selected.close();
    assert.equal(await readFile(`${stage.source}/sentinel`, 'utf8'), 'selected');
    await readInContainer(stage, true);
    assert.equal(await readFile(`${root}/disk/Projects/moved/write-test`, 'utf8'), 'ok');
    await assert.rejects(readFile(`${root}/disk/private/write-test`), { code: 'ENOENT' });

    const moved = await openDataDirectory(disk, ['Projects', 'moved']);
    const readonly = await stageDataDirectory(moved, `${root}/stage`, 'readonly', true);
    stages.push(readonly);
    await moved.close();
    await readInContainer(readonly, false);
    await assert.rejects(stageDataDirectory(disk, `${root}/stage`, 'pinned', false), /mount_preparation_failed/);
    assert.equal(await readFile(`${stage.source}/sentinel`, 'utf8'), 'selected', 'collision cannot remove an existing bind');

    await symlink('stage', `${root}/stage-link`);
    await assert.rejects(openHostDirectory(`${root}/stage-link`), /unsafe_host_directory/);
    await mkdir(`${root}/writable`);
    await chmod(`${root}/writable`, 0o777);
    await assert.rejects(openHostDirectory(`${root}/writable`), /unsafe_host_directory/);

    process.stdout.write('PASS: pinned rename race, symlink/traversal denial, real Docker reads/writes, read-only bind, collision safety\n');
} finally {
    // Only this run's containers and mount points. A cleanup failure leaves
    // its disk intact for inspection; never rm recursively through a mount.
    for (const id of containers) await docker('DELETE', `/containers/${id}?force=true`);
    for (const stage of stages.reverse()) await stage.release();
    if (disk) await disk.close();
    if (diskMounted) run('/bin/umount', [`${root}/disk`]);
    await rm(`${root}/disk.img`, { force: true });
    for (const name of ['disk', 'stage', 'writable']) await rmdir(`${root}/${name}`).catch(e => { if(e.code !== 'ENOENT') throw e; });
    await rm(`${root}/stage-link`, { force: true });
}
