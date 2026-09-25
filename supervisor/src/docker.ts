import { request } from 'node:http';

export class DockerError extends Error {
    constructor(readonly status: number) { super('docker_operation_failed'); }
}

/** Host-private Unix socket only. Bounded responses and fixed error messages
 * prevent daemon diagnostics (paths, environment, credentials) reaching APIs. */
export class Docker {
    constructor(private readonly socketPath = '/var/run/docker.sock') {}
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
