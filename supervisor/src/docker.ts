import { request } from 'node:http';

export class DockerError extends Error {
    constructor(readonly status: number) { super('docker_operation_failed'); }
}

/** Host-private Unix socket only. Bounded responses and fixed error messages
 * prevent daemon diagnostics (paths, environment, credentials) reaching APIs. */
export class Docker {
    constructor(private readonly socketPath = '/var/run/docker.sock') {}
    /** Installation-only pull. Never call from launch or observation. Registry
     * credentials travel only to the host's Unix socket, never a container.
     * A disconnected client may leave cached layers; it does not activate them. */
    async pullImage(reference: string, credentials: { registry: string; token: string } | undefined,
        signal: AbortSignal): Promise<void> {
        if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(reference)
            || (credentials && (reference.split('/')[0] !== credentials.registry || !credentials.token
                || credentials.token.length > 16384 || /[\x00-\x20\x7f]/.test(credentials.token)))) {
            throw new DockerError(0);
        }
        if (signal.aborted) throw new DockerError(0);
        return new Promise<void>((resolve, reject) => {
            const headers = credentials ? { 'x-registry-auth': Buffer.from(JSON.stringify({ username: 'AWS',
                password: credentials.token, serveraddress: credentials.registry })).toString('base64url') } : {};
            const req = request({ socketPath: this.socketPath, method: 'POST', headers,
                path: `/v1.45/images/create?fromImage=${encodeURIComponent(reference)}&platform=linux%2Famd64` }, response => {
                if (response.statusCode !== 200) { req.destroy(); reject(new DockerError(response.statusCode ?? 0)); return; }
                let pending = '', size = 0, failed = false;
                const fail = () => { failed = true; req.destroy(); reject(new DockerError(0)); };
                const line = (value: string) => {
                    if (!value.trim()) return;
                    if (Buffer.byteLength(value) > 65536) return fail();
                    try {
                        const item = JSON.parse(value) as Record<string, unknown>;
                        if (!item || typeof item !== 'object' || Array.isArray(item) || item.error || item.errorDetail) fail();
                    } catch { fail(); }
                };
                response.setEncoding('utf8');
                response.on('data', (chunk: string) => {
                    if (failed) return;
                    size += Buffer.byteLength(chunk);
                    if (size > 16 * 1024 * 1024) return fail();
                    pending += chunk;
                    let end: number;
                    while (!failed && (end = pending.indexOf('\n')) !== -1) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
                    if (Buffer.byteLength(pending) > 65536) fail();
                });
                response.on('error', () => reject(new DockerError(0)));
                response.on('end', () => { if (!failed) line(pending); if (!failed) resolve(); });
            });
            const abort = () => req.destroy(new Error('cancelled'));
            signal.addEventListener('abort', abort, { once: true });
            const deadline = setTimeout(abort, 300_000);
            req.once('close', () => { clearTimeout(deadline); signal.removeEventListener('abort', abort); });
            req.once('error', () => reject(new DockerError(0)));
            req.end();
        });
    }
    async call<T>(method: string, path: string, value?: unknown): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const body = value === undefined ? undefined : JSON.stringify(value);
            const req = request({ socketPath: this.socketPath, method, path: `/v1.45${path}`,
                headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
            }, response => {
                const chunks: Buffer[] = [];
                let size = 0;
                response.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > 2 * 1024 * 1024) { req.destroy(); reject(new DockerError(0)); return; }
                    chunks.push(chunk);
                });
                response.on('error', () => reject(new DockerError(0)));
                response.on('end', () => {
                    const status = response.statusCode ?? 0;
                    if (status < 200 || status >= 300) return reject(new DockerError(status));
                    try {
                        const text = Buffer.concat(chunks).toString();
                        resolve((text ? JSON.parse(text) : undefined) as T);
                    } catch { reject(new DockerError(0)); }
                });
            });
            const deadline = setTimeout(() => req.destroy(new Error('deadline')), 30_000);
            req.once('close', () => clearTimeout(deadline));
            req.on('error', () => reject(new DockerError(0)));
            req.end(body);
        });
    }
}

export type DockerContainer = {
    Id: string; Image: string;
    Config: { Labels: Record<string, string>; Image: string };
    State: { Running: boolean; Status: string; Dead: boolean };
    HostConfig: { Memory: number; PortBindings: Record<string, { HostIp: string; HostPort: string }[] | null> };
    Mounts: { Type: string; Source: string; Destination: string }[];
    NetworkSettings: { Networks: Record<string, { NetworkID: string; IPAddress: string }> };
};
