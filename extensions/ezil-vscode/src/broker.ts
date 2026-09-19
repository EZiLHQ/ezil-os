import { lstatSync, openSync, closeSync, readFileSync, fstatSync, constants } from 'node:fs';
import { isAbsolute, relative, resolve, dirname } from 'node:path';

export interface BrokerDescriptor {
    contractVersion: 1; origin: string; workspaceId: string; token: string;
    expiresAt: number; dataRoot: string; workspacePath: string;
    workspaceKind?: 'managed' | 'attached'; workspaceIdentity?: string;
}
/** Electron's provider broker exposes no workspace-management operations. */
export interface ModelBrokerDescriptor {
    contractVersion: 1; url: string; capability: string;
    operations: ('models' | 'chat')[]; formats: string[];
}
export type Descriptor = BrokerDescriptor | ModelBrokerDescriptor;
function inside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}
function noSymlinks(path: string): void {
    for (let cursor = path; ; cursor = dirname(cursor)) {
        if (lstatSync(cursor).isSymbolicLink()) throw new Error('broker_unavailable');
        if (dirname(cursor) === cursor) return;
    }
}
function loopbackOrigin(value: unknown): value is string {
    try { return typeof value === 'string' && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value)
        && new URL(value).origin === value; } catch { return false; }
}
/** Only local files or the bundled editor's loopback remote filesystem. The
 * private descriptor still authorizes the exact canonical directory and inode. */
export function localFolder(uri: { scheme: string; authority: string; fsPath: string }): string {
    if (uri.scheme === 'file' && !uri.authority) return uri.fsPath;
    if (uri.scheme === 'vscode-remote' && loopbackOrigin(`http://${uri.authority}`)) return uri.fsPath;
    return '';
}
export function readBroker(path: string | undefined, folders: readonly string[], now = Date.now()): Descriptor {
    if (!path || !isAbsolute(path)) throw new Error('broker_unavailable');
    noSymlinks(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > 4096 || (st.mode & 0o077) !== 0 || st.nlink !== 1
            || (process.getuid && st.uid !== process.getuid())) throw new Error('broker_unavailable');
        if (folders.length !== 1 || !isAbsolute(folders[0]!) || inside(folders[0]!, path)) throw new Error('broker_unavailable');
        noSymlinks(folders[0]!);
        if (!lstatSync(folders[0]!).isDirectory()) throw new Error('broker_unavailable');
        const value = JSON.parse(readFileSync(fd, 'utf8'));
        if (!value || value.contractVersion !== 1) throw new Error('broker_unavailable');
        if ('url' in value) {
            if (Object.keys(value).some(key => !['contractVersion', 'url', 'capability', 'operations', 'formats'].includes(key))
                || !loopbackOrigin(value.url) || !/^[A-Za-z0-9_-]{43,128}$/.test(value.capability)
                || !Array.isArray(value.operations) || !value.operations.includes('models')
                || value.operations.some((op: unknown) => op !== 'models' && op !== 'chat')
                || !Array.isArray(value.formats) || value.formats.some((format: unknown) =>
                    format !== 'text/event-stream' && format !== 'application/vnd.amazon.eventstream')) throw new Error('broker_unavailable');
            return value as ModelBrokerDescriptor;
        }
        if (!loopbackOrigin(value.origin)
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.workspaceId)
            || !/^[A-Za-z0-9_-]{43}$/.test(value.token)
            || !Number.isFinite(value.expiresAt) || value.expiresAt <= now
            || !isAbsolute(value.dataRoot) || !isAbsolute(value.workspacePath)) throw new Error('broker_unavailable');
        const dataRoot = resolve(value.dataRoot);
        const expected = resolve(value.workspacePath);
        const managed = [resolve(dataRoot, 'workspaces', value.workspaceId, 'files'),
            resolve(dataRoot, 'native-v1', 'workspaces', value.workspaceId, 'files')];
        // The descriptor is app-owned and outside the project. Electron-owned
        // workspaces and standalone helper workspaces use different managed roots.
        if (!inside(dataRoot, path) || inside(expected, path)
            || resolve(folders[0]!) !== expected) throw new Error('broker_unavailable');
        noSymlinks(dataRoot);
        noSymlinks(expected);
        const kind = value.workspaceKind;
        if (kind === 'attached') {
            // Attached roots are authorized only by the fixed host-owned
            // connector descriptor, never by metadata inside a project.
            if (resolve(path) !== resolve(dataRoot, 'private', 'connectors', `${value.workspaceId}.json`)
                || inside(dataRoot, expected) || inside(expected, dataRoot)) throw new Error('broker_unavailable');
            for (const directory of [dataRoot, dirname(dirname(path)), dirname(path)]) {
                const stat = lstatSync(directory);
                if (!stat.isDirectory() || (stat.mode & 0o077) !== 0
                    || (process.getuid && stat.uid !== process.getuid())) throw new Error('broker_unavailable');
            }
        } else if ((kind !== undefined && kind !== 'managed') || !managed.includes(expected)) throw new Error('broker_unavailable');
        if (kind !== undefined || value.workspaceIdentity !== undefined) {
            const stat = lstatSync(expected);
            if (!kind || value.workspaceIdentity !== `${stat.dev}:${stat.ino}`) throw new Error('broker_unavailable');
        }
        return value;
    } catch { throw new Error('broker_unavailable'); }
    finally { closeSync(fd); }
}
export function parsePort(input: string): number | undefined {
    if (!/^[0-9]{4,5}$/.test(input)) return undefined;
    const port = Number(input);
    return port >= 1024 && port <= 65535 ? port : undefined;
}
export async function sendOperation(descriptor: BrokerDescriptor, operation: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(operation).sort().join(',');
    const readiness = operation.op === 'editor.readiness' && keys === 'op,state'
        && (operation.state === 'active' || operation.state === 'unknown');
    const preview = (operation.op === 'preview.register' || operation.op === 'preview.unregister') && keys === 'op,port'
        && Number.isInteger(operation.port) && Number(operation.port) >= 1024 && Number(operation.port) <= 65535;
    if (!readiness && !preview) throw new Error('broker_unavailable');
    const response = await fetch(`${descriptor.origin}/api/native/operations`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
        headers: { 'content-type': 'application/json', origin: descriptor.origin, authorization: `Bearer ${descriptor.token}` },
        body: JSON.stringify({ ...operation, workspaceId: descriptor.workspaceId }),
    });
    if (!response.ok) throw new Error('broker_unavailable');
    // Do not display arbitrary response text or reflected tokens in notifications.
    const value = await response.json() as { ok?: boolean };
    if (value.ok !== true) throw new Error('broker_unavailable');
}

export async function readModels(descriptor: ModelBrokerDescriptor): Promise<string[]> {
    if (!descriptor.operations.includes('models')) throw new Error('broker_unavailable');
    const response = await fetch(`${descriptor.url}/v1/models`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5_000),
        headers: { authorization: `Bearer ${descriptor.capability}` },
    });
    if (!response.ok) throw new Error('broker_unavailable');
    const value = await response.json() as { models?: unknown };
    if (!Array.isArray(value.models) || value.models.length > 100 || value.models.some(model =>
        typeof model !== 'string' || !/^[a-zA-Z0-9._:-]{1,200}$/.test(model))) throw new Error('broker_unavailable');
    return value.models;
}
