import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const units = ['ezil-supervisor.service', 'ezil-data-mount.service', 'ezil-configuration@.service', 'ezil-mount@.service'];
export const required = ['package.json', 'package-lock.json', ...units.map(name => `deploy/${name}`),
    'deploy/configuration-document.json', 'deploy/mount-document.json',
    ...['host', 'prepare', 'data-mount', 'delivery-operation', 'delivery-executor', 'mount-operation', 'mount-executor']
        .map(name => `dist/${name}.js`)];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const limits = { files: 20000, file: 8 * 1024 * 1024, total: 128 * 1024 * 1024, manifest: 4 * 1024 * 1024 };
const fail = () => { throw new Error('host_release_invalid'); };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
export function validPath(path) {
    return typeof path === 'string' && path.length <= 512 && !path.endsWith('.node') && path.split('/').every(p => /^[A-Za-z0-9_@.][A-Za-z0-9_@.+-]*$/.test(p) && p !== '.' && p !== '..')
        && (['package.json', 'package-lock.json'].includes(path) || /^(dist|node_modules)\//.test(path)
            || [...units, 'configuration-document.json', 'mount-document.json'].some(name => path === `deploy/${name}`));
}
export function parseRelease(bytes, expected) {
    if (!Buffer.isBuffer(bytes) || bytes.length > limits.manifest || !/^[a-f0-9]{64}$/.test(expected) || hash(bytes) !== expected) return fail();
    let value; try { value = JSON.parse(bytes); } catch { return fail(); }
    if (!keys(value, ['schemaVersion', 'sourceCommit', 'nodeMajor', 'files']) || value.schemaVersion !== 1 || value.nodeMajor !== 24
        || !/^[a-f0-9]{40}$/.test(value.sourceCommit) || !Array.isArray(value.files) || !value.files.length || value.files.length > limits.files) return fail();
    const seen = new Set(); let total = 0, previous = '';
    for (const file of value.files) {
        if (!keys(file, ['path', 'sha256', 'bytes']) || !validPath(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
            || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > limits.file || file.path <= previous) return fail();
        previous = file.path; total += file.bytes; seen.add(file.path);
        if (total > limits.total) return fail();
    }
    if (required.some(path => !seen.has(path))) return fail();
    return value;
}
/** Build-time inventory only; privileged installation uses pinned directory FDs.
 * No archives, symlinks, native modules, devices or executable package scripts. */
export async function inventory(directory) {
    const files = []; let total = 0;
    async function visit(relative = '') {
        for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
            const path = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) { if (!['dist', 'node_modules', 'deploy'].includes(path) && !validPath(`${path}/entry`)) return fail(); await visit(path); }
            else {
                const stat = await lstat(join(directory, path));
                if (!validPath(path) || !stat.isFile() || stat.nlink !== 1 || stat.size > limits.file || path.endsWith('.node')) return fail();
                total += stat.size; if (total > limits.total || files.length >= limits.files) return fail();
                const bytes = await readFile(join(directory, path));
                if (bytes.length !== stat.size) return fail();
                files.push({ path, sha256: hash(bytes), bytes: bytes.length });
            }
        }
    }
    await visit(); return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
