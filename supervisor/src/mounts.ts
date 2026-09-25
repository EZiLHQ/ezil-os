import { constants } from 'node:fs';
import { mkdir, open, rmdir, type FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, normalize } from 'node:path';

const component = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}$/;
const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function requireLinux(): void {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('linux_root_required');
}

/** Only host configuration supplies absolute roots. Every ancestor must be
 * root-owned and unwritable by app users; following even an ancestor symlink
 * would turn the directory-FD checks below into a path traversal. */
export async function openHostDirectory(path: string): Promise<FileHandle> {
    requireLinux();
    if (!isAbsolute(path) || normalize(path) !== path || path === '/' || path.endsWith('/')) {
        throw new Error('invalid_host_directory');
    }
    const parts = path.slice(1).split('/');
    if (!parts.every(part => component.test(part))) throw new Error('invalid_host_directory');
    let parent = await open('/', flags);
    try {
        for (const part of parts) {
            const child = await open(`/proc/self/fd/${parent.fd}/${part}`, flags);
            await parent.close();
            parent = child;
            const stat = await parent.stat();
            if (stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('unsafe_host_directory');
        }
        return parent;
    } catch {
        await parent.close();
        throw new Error('unsafe_host_directory');
    }
}

/** Resolves one component at a time, keeping the parent open until the child
 * is pinned. The returned FD refers to the selected inode through renames.
 * No realpath-to-Docker handoff occurs. Callers derive parts from owned IDs,
 * never from a publisher path. Nested filesystems are outside this adapter. */
export async function openDataDirectory(root: FileHandle, parts: string[]): Promise<FileHandle> {
    requireLinux();
    if (!parts.length || !parts.every(part => component.test(part) && part !== '.' && part !== '..')) {
        throw new Error('invalid_data_directory');
    }
    const device = (await root.stat()).dev;
    let parent = root;
    try {
        for (const part of parts) {
            const child = await open(`/proc/self/fd/${parent.fd}/${part}`, flags);
            if (parent !== root) await parent.close();
            parent = child;
            if ((await child.stat()).dev !== device) throw new Error('nested_data_filesystem');
        }
        return parent;
    } catch {
        if (parent !== root) await parent.close();
        throw new Error('unsafe_data_directory');
    }
}

/** mount(8) canonicalizes paths by default, which would lose the open inode
 * and reintroduce the race. --no-canonicalize is mandatory. FD 3 is explicitly
 * inherited by the child; /proc/self/fd/3 is resolved by the kernel. Commands
 * have no shell, ambient environment, or caller-controlled executable. */
async function mountCommand(args: string[], fd?: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn('/bin/mount', args, {
            env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' },
            stdio: fd === undefined ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'ignore', 'ignore', fd],
            timeout: 10_000,
        });
        child.once('error', () => reject(new Error('mount_operation_failed')));
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('mount_operation_failed')));
    });
}

async function unmount(path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn('/bin/umount', ['--no-canonicalize', path], {
            env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, stdio: 'ignore', timeout: 10_000,
        });
        child.once('error', () => reject(new Error('mount_cleanup_failed')));
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('mount_cleanup_failed')));
    });
}

export type StagedDirectory = { source: string; release(): Promise<void> };

/** Make a stable bind in a host-owned directory shared with the Docker
 * daemon's mount namespace. Docker sees this path, never a /proc FD which
 * could be canonicalized or reused after a supervisor restart. The caller
 * MUST observe all consuming containers removed before release(). */
export async function stageDataDirectory(
    source: FileHandle, stagingRoot: string, slot: string, readOnly: boolean,
): Promise<StagedDirectory> {
    if (!component.test(slot) || slot === '.' || slot === '..') throw new Error('invalid_mount_slot');
    const root = await openHostDirectory(stagingRoot);
    const target = `${stagingRoot}/${slot}`;
    let created = false;
    let mounted = false;
    try {
        await mkdir(`/proc/self/fd/${root.fd}/${slot}`, { mode: 0o700 });
        created = true;
        await mountCommand(['--no-canonicalize', '--bind', '/proc/self/fd/3', target], source.fd);
        mounted = true;
        await mountCommand(['--no-canonicalize', '--make-private', target]);
        await mountCommand(['--no-canonicalize', '-o', `remount,bind,nosuid,nodev${readOnly ? ',ro' : ',rw'}`, target]);
        const pinned = await source.stat();
        const bound = await open(target, flags);
        try {
            const stat = await bound.stat();
            if (stat.dev !== pinned.dev || stat.ino !== pinned.ino) throw new Error('mount_identity_mismatch');
        } finally { await bound.close(); }
        let released = false;
        return { source: target, release: async () => {
            if (released) return;
            await unmount(target);
            await rmdir(target);
            released = true;
        } };
    } catch {
        // Never recursively remove: a failed unmount must leave user data and
        // its stable anchor intact. No lazy/forced detach hides a live writer.
        if (mounted) await unmount(target);
        if (created) await rmdir(target);
        throw new Error('mount_preparation_failed');
    } finally { await root.close(); }
}
