// Run this reviewed installer from a trusted checkout, not from an unverified
// release. Offline image preparation only: no credentials, disk or service start.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, rename, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash, limits, parseRelease, units } from './host-release.mjs';

const root = '/opt/ezil-supervisor', systemd = '/etc/systemd/system';
const fail = () => { throw new Error('host_installation_unconfirmed'); };
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
async function directory(path, create = false) {
    if (!isAbsolute(path) || normalize(path) !== path) return fail();
    let current = await open('/', directoryFlags);
    try {
        for (const part of path.slice(1).split('/').filter(Boolean)) {
            const child = `/proc/self/fd/${current.fd}/${part}`;
            if (create) { try { await mkdir(child, { mode: 0o755 }); await current.sync(); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
            const next = await open(child, directoryFlags); await current.close(); current = next;
            const stat = await current.stat(); if (stat.uid !== 0 || stat.mode & 0o022) return fail();
        }
        return current;
    } catch (e) { await current.close(); throw e; }
}
// Pin each source ancestor and file; symlink/FIFO/device substitutions cannot
// escape the input tree or block this privileged copy. Source owners need not
// be root: the externally supplied release digest is the content authority.
async function sourceFile(source, relative, limit, durable = false) {
    let parent = await open(source, directoryFlags);
    try {
        const parts = relative.split('/'), name = parts.pop();
        for (const part of parts) { const next = await open(`/proc/self/fd/${parent.fd}/${part}`, directoryFlags); await parent.close(); parent = next; }
        const file = await open(`/proc/self/fd/${parent.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) return fail();
            const bytes = Buffer.alloc(limit + 1); let size = 0;
            while (size < bytes.length) { const r = await file.read(bytes, size, bytes.length - size); if (!r.bytesRead) break; size += r.bytesRead; }
            if (size > limit) return fail(); if (durable) await file.sync(); return bytes.subarray(0, size);
        } finally { await file.close(); }
    } finally { await parent.close(); }
}
async function write(path, bytes) {
    const parent = await directory(dirname(path), true);
    try {
        const file = await open(`/proc/self/fd/${parent.fd}/${path.slice(path.lastIndexOf('/') + 1)}`,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await parent.sync();
    } finally { await parent.close(); }
}
async function absentOrSame(path, bytes) {
    try {
        const s = await lstat(path); if (!s.isFile() || s.uid !== 0 || s.mode & 0o022 || s.nlink !== 1) return fail();
        if (!(await sourceFile(dirname(path), path.split('/').pop(), bytes.length, true)).equals(bytes)) return fail();
        return false;
    } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
}
async function link(path, target) {
    try { const s = await lstat(path); if (!s.isSymbolicLink() || s.uid !== 0 || await readlink(path) !== target) return fail(); }
    catch (e) {
        if (e.code !== 'ENOENT') throw e;
        await symlink(target, path);
    }
    const parent = await directory(dirname(path)); try { await parent.sync(); } finally { await parent.close(); }
}
async function verifyInstalled(destination, release, manifest) {
    const expected = new Set(['release.json', ...release.files.map(f => f.path)]);
    async function visit(path, relative = '') {
        const d = await directory(path);
        try {
            for (const name of await readdir(`/proc/self/fd/${d.fd}`)) {
                const child = join(path, name), rel = relative ? `${relative}/${name}` : name, stat = await lstat(child);
                if (stat.isDirectory()) await visit(child, rel);
                else if (!expected.delete(rel) || !stat.isFile() || stat.uid !== 0 || stat.mode & 0o022 || stat.nlink !== 1) return fail();
            }
            await d.sync();
        } finally { await d.close(); }
    }
    await visit(destination); if (expected.size) return fail();
    if (!(await sourceFile(destination, 'release.json', limits.manifest, true)).equals(manifest)) return fail();
    for (const f of release.files) {
        const bytes = await sourceFile(destination, f.path, f.bytes, true);
        if (bytes.length !== f.bytes || hash(bytes) !== f.sha256) return fail();
    }
}
async function install(source, digest) {
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.versions.node.split('.')[0] !== '24'
        || !isAbsolute(source) || normalize(source) !== source || !/^[a-f0-9]{64}$/.test(digest)) return fail();
    const env = { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' };
    if (!/^v24\./.test(execFileSync('/usr/local/bin/node', ['--version'], { env, encoding: 'utf8' }))) return fail();
    const manifest = await sourceFile(source, 'release.json', limits.manifest), release = parseRelease(manifest, digest);
    // Verify all bytes before creating even a staging directory. The copy below
    // verifies them again, since input may change between preflight and copying.
    for (const f of release.files) {
        const bytes = await sourceFile(source, `payload/${f.path}`, f.bytes);
        if (bytes.length !== f.bytes || hash(bytes) !== f.sha256) return fail();
    }
    for (const path of [root, `${root}/releases`, systemd]) { const d = await directory(path, true); await d.close(); }
    // Refuse upgrades, foreign layouts and modified units; maintenance/recovery
    // must explicitly stop the old host and review those changes separately.
    for (const [path, target] of [[`${root}/current`, `releases/${digest}`], [`${root}/dist`, 'current/dist']]) {
        try { const s = await lstat(path); if (!s.isSymbolicLink() || s.uid !== 0 || await readlink(path) !== target) return fail(); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    for (const name of units) await absentOrSame(`${systemd}/${name}`, await sourceFile(source, `payload/deploy/${name}`, limits.file));
    const destination = `${root}/releases/${digest}`;
    let exists = false;
    try { const d = await directory(destination); await d.close(); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (exists) {
        await verifyInstalled(destination, release, manifest);
    } else {
        const stage = `${root}/releases/.install-${randomUUID()}`, d = await directory(stage, true); await d.close();
        // Keep failed staging directories for diagnosis; they are never active.
        for (const f of release.files) {
            const bytes = await sourceFile(source, `payload/${f.path}`, f.bytes);
            if (bytes.length !== f.bytes || hash(bytes) !== f.sha256) return fail();
            await write(join(stage, f.path), bytes);
        }
        await write(`${stage}/release.json`, manifest); await rename(stage, destination);
    }
    const parent = await directory(`${root}/releases`); try { await parent.sync(); } finally { await parent.close(); }
    // Both historic SSM/configuration paths and the mount workflow resolve to
    // one immutable code/dependency tree. Never rewrite the pinned documents.
    await link(`${root}/current`, `releases/${digest}`); await link(`${root}/dist`, 'current/dist');
    for (const name of units) {
        const bytes = await sourceFile(destination, `deploy/${name}`, limits.file);
        if (await absentOrSame(`${systemd}/${name}`, bytes)) await write(`${systemd}/${name}`, bytes);
    }
    const unitDirectory = await directory(systemd); try { await unitDirectory.sync(); } finally { await unitDirectory.close(); }
    execFileSync('/usr/bin/systemctl', ['daemon-reload'], { env, timeout: 15000, stdio: 'pipe' });
    return { state: 'installed', releaseDigest: digest, sourceCommit: release.sourceCommit };
}
try {
    if (process.argv.length !== 4) fail();
    process.stdout.write(JSON.stringify(await install(process.argv[2], process.argv[3])) + '\n');
} catch { process.stderr.write('{"code":"host_installation_unconfirmed"}\n'); process.exitCode = 1; }
