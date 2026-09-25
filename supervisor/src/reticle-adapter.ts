import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_NAME = 'pairing-token';

export function parseReticleOrigins(value: string | undefined): string[] {
    let parsed: unknown;
    try { parsed = JSON.parse(value ?? ''); } catch { throw new Error('invalid_reticle_origins'); }
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) throw new Error('invalid_reticle_origins');
    const origins: string[] = [];
    for (const item of parsed) {
        if (typeof item !== 'string') throw new Error('invalid_reticle_origins');
        let url: URL;
        try { url = new URL(item); } catch { throw new Error('invalid_reticle_origins'); }
        const localHttp = url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
        if ((url.protocol !== 'https:' && !localHttp) || url.origin !== item || url.username || url.password
            || url.hostname.includes('*')) {
            throw new Error('invalid_reticle_origins');
        }
        origins.push(item);
    }
    if (new Set(origins).size !== origins.length) throw new Error('invalid_reticle_origins');
    return origins;
}

/** Provision explicitly instead of using upstream's best-effort auto-token
 * path, which may continue without authentication after a storage failure. */
export async function persistentReticleToken(directory: string): Promise<string> {
    try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const dirStat = await lstat(directory);
        if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077) !== 0) {
            throw new Error('invalid_private_directory');
        }
        const target = join(directory, TOKEN_NAME);
        try { await lstat(target); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const temporary = join(directory, `.pairing-${randomBytes(12).toString('hex')}`);
            const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
            try { await file.writeFile(`${randomBytes(32).toString('base64url')}\n`); await file.sync(); }
            finally { await file.close(); }
            try {
                // Publish only complete, synced bytes. Concurrent provisioners
                // cannot overwrite the token selected by the first writer.
                try { await link(temporary, target); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            } finally { await unlink(temporary); }
            const dir = await open(directory, constants.O_RDONLY);
            try { await dir.sync(); } finally { await dir.close(); }
        }
        const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > 44 || (stat.mode & 0o077) !== 0) throw new Error('invalid_private_token');
            const bytes = Buffer.alloc(45);
            const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
            const token = bytes.subarray(0, bytesRead).toString('utf8').replace(/\n$/, '');
            if (!TOKEN.test(token)) throw new Error('invalid_private_token');
            return token;
        } finally { await file.close(); }
    } catch { throw new Error('pairing_token_unavailable'); }
}

type Daemon = { close(): Promise<void>; announceShutdown?: () => void };

export function requireReticleMounts(mountInfo: string): void {
    for (const point of ['/project', '/data']) {
        const matching = mountInfo.split('\n').filter((line) => line.split(' - ')[0]?.split(' ')[4] === point);
        if (matching.length !== 1) throw new Error('reticle_mount_required');
        const [mount, fs] = matching[0]!.split(' - ');
        if (!mount?.split(' ')[5]?.split(',').includes('rw')
            || !fs?.split(' ')[2]?.split(',').includes('rw')
            || ['overlay', 'tmpfs', 'ramfs', 'proc', 'sysfs'].includes(fs?.split(' ')[0] ?? '')) {
            throw new Error('reticle_mount_required');
        }
    }
}

export async function runReticleAdapter(): Promise<void> {
    // The host gives this container only its selected project and private data.
    // Direct startDaemon avoids CLI setup, detached children and project .env
    // loading. No installer or automatic project instrumentation is invoked.
    process.env.RETICLE_TELEMETRY = '0';
    process.env.DO_NOT_TRACK = '1';
    const origins = parseReticleOrigins(process.env.EZIL_RETICLE_ALLOWED_ORIGINS);
    requireReticleMounts(await readFile('/proc/self/mountinfo', 'utf8'));
    const token = await persistentReticleToken('/data/reticle');
    const project = await lstat('/project');
    if (!project.isDirectory() || project.isSymbolicLink()) throw new Error('invalid_project_mount');
    process.chdir('/project');
    const packageJson = JSON.parse(await readFile('/opt/reticle/package.json', 'utf8')) as Record<string, unknown>;
    if (packageJson.name !== '@reticlehq/server' || packageJson.version !== '3.2.0') {
        throw new Error('unsupported_reticle_version');
    }
    const modulePath = '/opt/reticle/dist/index.js';
    const upstream = await import(modulePath) as { startDaemon(options: Record<string, unknown>): Promise<Daemon> };
    const daemon = await upstream.startDaemon({
        port: 4400, host: '0.0.0.0', token, allowedOrigins: origins,
        reticleRoot: '/project/.reticle', pairingTokenDir: '/data/reticle',
    });
    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        const deadline = setTimeout(() => process.exit(1), 10_000);
        try { daemon.announceShutdown?.(); } catch { /* close remains mandatory */ }
        void daemon.close().then(() => {
            clearTimeout(deadline);
            process.stdout.write('reticle_adapter_stopped\n');
            process.exit(0);
        }).catch(() => process.exit(1));
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    process.stdout.write('reticle_adapter_ready\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void runReticleAdapter().catch(() => {
        // Upstream errors may contain paths or request data; do not echo them.
        process.stderr.write('reticle_adapter_start_failed\n');
        process.exit(1);
    });
}
