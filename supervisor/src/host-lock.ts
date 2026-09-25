import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { ensureHostDirectory } from './host-config.js';

const DIRECTORY = '/run/ezil-supervisor';

/** flock is attached to the shared open-file description, not a PID file.
 * The short child acquires it on inherited FD 3; the parent retains that same
 * description until close or process death. No long-lived helper can orphan
 * the lock. The fixed path is independent of config/computer IDs. */
export async function acquireHostLock(purpose: 'host' | 'preparation' = 'host') {
    await ensureHostDirectory(DIRECTORY);
    if (!['host', 'preparation'].includes(purpose)) throw new Error('host_lock_unavailable');
    const file = await open(`${DIRECTORY}/${purpose}.lock`, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || stat.mode & 0o077) throw new Error('host_lock_unavailable');
        await new Promise<void>((resolve, reject) => {
            const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], {
                env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'ignore', 'ignore', file.fd], timeout: 5000,
            });
            child.once('error', () => reject(new Error('host_lock_unavailable')));
            child.once('exit', code => code === 0 ? resolve() : reject(new Error(code === 73 ? `${purpose}_already_running` : 'host_lock_unavailable')));
        });
        return { release: () => file.close() };
    } catch (error) { await file.close(); throw error; }
}
