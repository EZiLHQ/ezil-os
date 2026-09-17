import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Authority } from '../src/auth.ts';
import { NATIVE_RUNTIME, parseOperation } from '../src/contract.ts';
import { acquireDataRoot, WorkspaceStore } from '../src/workspaces.ts';
import { createNativeRuntime, startNativeServer } from '../src/server.ts';
import { nativeBoot } from '../src/boot.ts';
import { buildLocalBootPayload } from '../../local/src/boot/payload.ts';
import { toShellDesktopState } from '../../app/src/server/shell/boot-payload.ts';

const roots: string[] = [];
const servers: { stop(): void | Promise<void> }[] = [];
const temp = () => { const path = mkdtempSync('/tmp/ezil-native-'); roots.push(path); return path; };
const token = () => randomBytes(32).toString('base64url');
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('authority', () => {
    test('expiry, pairing expiry/replay, workspace and role boundaries', () => {
        let now = 1;
        const rootToken = token(); const auth = new Authority(rootToken, () => now);
        const id = randomUUID();
        const pair = auth.createPairing(id);
        expect(JSON.stringify(auth)).not.toContain(pair.code);
        const minted = auth.redeemPairing(pair.code);
        expect(() => auth.redeemPairing(pair.code)).toThrow('invalid_pairing');
        const cap = auth.authenticate(`Bearer ${minted.token}`);
        expect(() => auth.authorize(cap, { op: 'surface.open', workspaceId: id, surface: 'code' })).not.toThrow();
        expect(() => auth.authorize(cap, { op: 'surface.open', workspaceId: randomUUID(), surface: 'code' })).toThrow('forbidden');
        expect(() => auth.authorize(cap, { op: 'workspace.remove', workspaceId: id })).toThrow('forbidden');
        const connector = auth.authenticate(`Bearer ${auth.mint('connector', id).token}`);
        expect(() => auth.authorize(connector, { op: 'editor.readiness', workspaceId: id, state: 'closed' })).toThrow('forbidden');
        const expiredPair = auth.createPairing(id);
        now += 60_000;
        expect(() => auth.redeemPairing(expiredPair.code)).toThrow('invalid_pairing');
        now = minted.expiresAt;
        expect(() => auth.authenticate(`Bearer ${minted.token}`)).toThrow('unauthorized');
        expect(auth.authenticate(`Bearer ${rootToken}`).role).toBe('admin');
    });
    test('revocation consumes capabilities and outstanding pairing codes', () => {
        const auth = new Authority(token()); const id = randomUUID();
        const pair = auth.createPairing(id); const cap = auth.mint('shell', id);
        auth.revokeWorkspace(id);
        expect(() => auth.authenticate(`Bearer ${cap.token}`)).toThrow();
        expect(() => auth.redeemPairing(pair.code)).toThrow();
    });
    test('closed schema rejects executable paths, URLs, commands and flags', () => {
        const base = { op: 'surface.open', workspaceId: randomUUID(), surface: 'code' };
        for (const key of ['url', 'command', 'executable', 'flags']) expect(() => parseOperation({ ...base, [key]: 'secret-value' })).toThrow('invalid_request');
        for (const port of [0, 80, 1023, 65536, 3000.5, '3000', '3000;open']) expect(() => parseOperation({ op: 'preview.register', workspaceId: base.workspaceId, port })).toThrow();
        expect(parseOperation({ op: 'preview.register', workspaceId: base.workspaceId, port: 3000 }).op).toBe('preview.register');
    });
});

describe('owned workspace data', () => {
    test('a second helper cannot mutate the same root', () => {
        const root = temp(); const release = acquireDataRoot(root);
        expect(() => acquireDataRoot(root)).toThrow('data_root_in_use');
        release(); acquireDataRoot(root)();
    });
    test('random stable identity, schema records and legacy preservation', () => {
        const root = temp(); writeFileSync(join(root, 'legacy.qcow2'), 'legacy');
        const store = new WorkspaceStore(root); const record = store.create('Guest');
        const again = new WorkspaceStore(root);
        expect(again.guestId).toBe(store.guestId); expect(again.get(record.id)).toEqual(record);
        store.remove(record.id);
        expect(readFileSync(join(root, 'legacy.qcow2'), 'utf8')).toBe('legacy');
        expect(existsSync(store.paths(record.id).files)).toBe(false);
        expect(new WorkspaceStore(temp()).guestId).not.toBe(store.guestId);
    });
    test('active/unknown state and restart forbid removal', () => {
        const root = temp(); const store = new WorkspaceStore(root); const record = store.create('Guest');
        store.setEditor(record.id, 'active');
        expect(() => store.remove(record.id)).toThrow('editor_not_closed');
        const again = new WorkspaceStore(root);
        expect(again.get(record.id).editorState).toBe('unknown');
        expect(() => again.remove(record.id)).toThrow('editor_not_closed');
        again.setEditor(record.id, 'closed'); again.remove(record.id);
    });
    test('rejects symlinked roots, nested links and forged ownership', () => {
        const root = temp(); const outside = temp(); const link = join(root, 'linked'); symlinkSync(outside, link);
        expect(() => new WorkspaceStore(link)).toThrow('symlink_refused');
        const store = new WorkspaceStore(root); const record = store.create('Guest');
        writeFileSync(join(outside, 'keep'), 'safe');
        symlinkSync(outside, join(store.paths(record.id).files, 'escape'));
        expect(() => store.remove(record.id)).toThrow('symlink_refused');
        expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('safe');
        rmSync(join(store.paths(record.id).files, 'escape'));
        writeFileSync(join(store.root, 'workspaces', record.id, 'workspace.json'), JSON.stringify({ ...record, guestId: randomUUID() }));
        expect(() => store.remove(record.id)).toThrow('ownership_refused');
    });
    test('native boot omits hosted controls, credentials and paths; hosted/local unchanged', () => {
        const store = new WorkspaceStore(temp()); const record = store.create('</script>'); const payload = nativeBoot(record);
        expect(payload.desktopState.runtime).toEqual(NATIVE_RUNTIME);
        expect(payload.desktopState.endpoints).toEqual({});
        expect(JSON.stringify(payload)).not.toContain(store.root);
        expect(toShellDesktopState({ isConfigured: true, hasHmacSecret: true }).runtime).toBeUndefined();
        expect(buildLocalBootPayload(payload.computer).desktopState.endpoints.codePreviewUrl).toBe('/api/shell/code-preview-url');
    });
});

async function fixture() {
    const root = temp(); const admin = token();
    let now = Date.now();
    const runtime = createNativeRuntime({ dataRoot: root, adminToken: admin, handoffTimeoutMs: 80, now: () => now }); servers.push(runtime);
    const server = { origin: 'http://127.0.0.1:49152', port: 49152 };
    const request = (path: string, options: RequestInit = {}, capability = admin) => runtime.fetch(new Request(`${server.origin}${path}`, {
        ...options, headers: { host: '127.0.0.1:49152', origin: server.origin, authorization: `Bearer ${capability}`, 'content-type': 'application/json', ...options.headers },
    }), server.origin);
    const operation = (op: unknown, capability = admin) => request('/api/native/operations', { method: 'POST', body: JSON.stringify(op) }, capability);
    const record = (await (await operation({ op: 'workspace.create', name: 'Guest' })).json()).workspace;
    const mint = async (role: string, id = record.id) => (await (await request('/api/native/capabilities', { method: 'POST', body: JSON.stringify({ workspaceId: id, role }) })).json()).token;
    return { root, admin, server, runtime, request, operation, record, mint, advance: (ms: number) => { now += ms; } };
}
describe('loopback HTTP', () => {
    test('only authenticated top-level /os navigation may omit Origin', async () => {
        const f = await fixture();
        const headers = { host: '127.0.0.1:49152', authorization: `Bearer ${f.admin}`,
            'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
        const request = (path: string, changes: Record<string, string> = {}, method = 'GET') =>
            f.runtime.fetch(new Request(f.server.origin + path, { method, headers: { ...headers, ...changes } }), f.server.origin);
        expect((await request('/os')).status).toBe(200);
        expect((await request('/os', { authorization: '' })).status).toBe(401);
        const invalid: Record<string, string>[] = [{ 'sec-fetch-dest': 'iframe' }, { 'sec-fetch-mode': 'cors' },
            { origin: 'null' }, { origin: 'https://foreign.example' }, { host: 'localhost:49152' }];
        for (const changes of invalid) {
            expect((await request('/os', changes)).status).toBe(403);
        }
        expect((await request('/api/native/boot')).status).toBe(403);
        expect((await request('/os', {}, 'POST')).status).toBe(403);
        expect((await f.runtime.fetch(new Request(f.server.origin + '/os', { headers: {
            host: headers.host, authorization: headers.authorization,
        } }), f.server.origin)).status).toBe(403);
        for (const file of ['bundle.min.js', 'bundle.min.css', 'icons.js']) {
            expect((await request(`/os/${file}`, { authorization: '' })).status).toBe(200);
            expect((await request(`/os/${file}`, { origin: 'https://foreign.example' })).status).toBe(403);
            expect((await request(`/os/${file}`, { upgrade: 'websocket' })).status).toBe(400);
        }
    });
    test('rejects missing/bad bearer, wrong/missing Origin, Host, cookies and URL tokens', async () => {
        const f = await fixture();
        const rejectedHeaders: Record<string, string>[] = [
            { authorization: '' }, { authorization: 'Bearer bogus' }, { origin: '' }, { origin: 'null' },
            { origin: 'https://hostile.example' }, { host: 'localhost:80' }, { cookie: 'auth=anything' },
        ];
        for (const headers of rejectedHeaders) {
            const response = await f.request('/api/native/boot', { headers });
            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(await response.text()).not.toContain(f.admin);
        }
        expect((await f.request('/api/native/boot?token=secret')).status).toBe(400);
        expect((await f.request('/api/native/boot')).status).toBe(200);
        const unauth = await f.runtime.fetch(new Request(`${f.server.origin}/api/native/boot`, { headers: { host: '127.0.0.1:49152' } }), f.server.origin);
        expect(unauth.status).toBe(403);
        expect((await f.request('/api/native/boot', { headers: { upgrade: 'websocket' } })).status).toBe(400);
    });
    test('workspace capabilities cannot cross workspaces, elevate roles or renew themselves', async () => {
        const f = await fixture(); const shell = await f.mint('shell');
        const other = (await (await f.operation({ op: 'workspace.create', name: 'Other' })).json()).workspace;
        expect((await f.operation({ op: 'workspace.get', workspaceId: other.id }, shell)).status).toBe(403);
        expect((await f.operation({ op: 'workspace.remove', workspaceId: f.record.id }, shell)).status).toBe(403);
        expect((await f.request('/api/native/capabilities', { method: 'POST', body: JSON.stringify({ workspaceId: f.record.id, role: 'shell' }) }, shell)).status).toBe(403);
        expect((await f.request('/api/native/boot', {}, shell)).status).toBe(200);
        f.advance(300_000);
        expect((await f.request('/api/native/boot', {}, shell)).status).toBe(401);
    });
    test('bounded/invalid bodies redact secrets and documents use exact committed assets', async () => {
        const f = await fixture();
        const response = await f.request('/api/native/operations', { method: 'POST', body: `{"token":"${f.admin}` });
        expect(response.status).toBe(400); expect(await response.text()).not.toContain(f.admin);
        expect((await f.request('/api/native/operations', { method: 'POST', body: 'x'.repeat(4097) })).status).toBe(413);
        const document = await (await f.request('/os')).text();
        expect(document).not.toContain(f.admin); expect(document).not.toContain(f.root);
        expect(document).toContain('native-macos');
        for (const file of ['bundle.min.js', 'bundle.min.css', 'icons.js']) {
            const asset = await f.request(`/os/${file}`, { headers: { authorization: '' } });
            expect(Buffer.from(await asset.arrayBuffer())).toEqual(readFileSync(new URL(`../../app/public/os/${file}`, import.meta.url)));
        }
    });
    test('Code-first launch queues trusted handoff; unavailable does not block shell', async () => {
        const f = await fixture(); const shell = await f.mint('shell');
        const pending = f.operation({ op: 'surface.open', workspaceId: f.record.id, surface: 'code' }, shell);
        await Bun.sleep(10);
        expect((await f.operation({ op: 'workspace.remove', workspaceId: f.record.id })).status).toBe(409);
        const handoffs = (await (await f.request('/api/native/handoffs')).json()).handoffs;
        expect(handoffs).toHaveLength(1);
        expect(handoffs[0].files).toBe(join(f.root, 'native-v1', 'workspaces', f.record.id, 'files'));
        expect((await f.request('/api/native/handoffs', { method: 'POST', body: JSON.stringify({ id: handoffs[0].id, state: 'opened' }) })).status).toBe(200);
        expect((await (await pending).json()).state).toBe('opened');
        expect((await f.request('/api/native/handoffs', { method: 'POST', body: JSON.stringify({ id: handoffs[0].id, state: 'opened' }) })).status).toBe(404);
        expect((await (await f.operation({ op: 'surface.open', workspaceId: f.record.id, surface: 'browser' }, shell)).json()).state).toBe('unavailable');
        expect((await f.request('/api/native/boot')).status).toBe(200);
    });
    test('connector readiness, port registration, heartbeat expiry and close authority', async () => {
        const f = await fixture(); const connector = await f.mint('connector');
        const op = (value: object) => f.operation({ ...value, workspaceId: f.record.id }, connector);
        expect((await op({ op: 'preview.register', port: 3000 })).status).toBe(409);
        expect((await op({ op: 'editor.readiness', state: 'active' })).status).toBe(200);
        for (const port of [80, 65536, f.server.port, '3000']) expect((await op({ op: 'preview.register', port })).status).toBe(400);
        expect((await op({ op: 'preview.register', port: 3000 })).status).toBe(200);
        expect((await op({ op: 'preview.unregister', port: 3000 })).status).toBe(200);
        expect((await op({ op: 'editor.readiness', state: 'closed' })).status).toBe(403);
        f.advance(45_000);
        expect((await (await f.operation({ op: 'workspace.get', workspaceId: f.record.id })).json()).workspace.editorState).toBe('unknown');
        expect((await f.operation({ op: 'workspace.remove', workspaceId: f.record.id })).status).toBe(409);
        await f.operation({ op: 'editor.readiness', workspaceId: f.record.id, state: 'closed' });
        expect((await f.operation({ op: 'workspace.remove', workspaceId: f.record.id })).status).toBe(200);
        expect((await op({ op: 'editor.readiness', state: 'active' })).status).toBe(401);
    });
});

describe('Electron attached workspace', () => {
    test('boots the inherited workspace despite an older helper selection and never deletes its files', async () => {
        const dataRoot = temp(); const root = temp(); const id = randomUUID(); const admin = token();
        const oldStore = new WorkspaceStore(dataRoot); const old = oldStore.create('Old');
        writeFileSync(join(root, 'keep.txt'), 'Electron-owned');
        const runtime = createNativeRuntime({ dataRoot, adminToken: admin, attachedWorkspace: { id, root }, handoffTimeoutMs: 100 });
        servers.push(runtime);
        const origin = 'http://127.0.0.1:49152';
        const request = (path: string, value?: unknown) => runtime.fetch(new Request(origin + path, {
            method: value === undefined ? 'GET' : 'POST',
            headers: { host: '127.0.0.1:49152', origin, authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
            body: value === undefined ? undefined : JSON.stringify(value),
        }), origin);
        const op = (value: unknown) => request('/api/native/operations', value);
        const boot = await (await request('/api/native/boot')).json();
        expect(boot.computer.id).toBe(id);
        expect(JSON.stringify(boot)).not.toContain(root);
        expect(JSON.stringify(boot)).not.toContain(dataRoot);
        expect(await (await request('/os')).text()).toContain(id);
        expect((await (await op({ op: 'workspace.list' })).json()).workspaces.map((w: { id: string }) => w.id)).toEqual([id]);
        expect((await op({ op: 'workspace.select', workspaceId: old.id })).status).toBe(404);
        expect((await op({ op: 'workspace.create', name: 'Duplicate' })).status).toBe(409);
        await op({ op: 'editor.readiness', workspaceId: id, state: 'closed' });
        expect((await op({ op: 'workspace.remove', workspaceId: id })).status).toBe(409);
        expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('Electron-owned');
        expect(existsSync(join(dataRoot, 'native-v1', 'workspaces', id))).toBe(false);
        expect(oldStore.selectedId).toBe(old.id);
        const pending = op({ op: 'surface.open', workspaceId: id, surface: 'code' });
        await Bun.sleep(5);
        const handoff = (await (await request('/api/native/handoffs')).json()).handoffs[0];
        expect(handoff.files).toBe(root);
        expect(handoff.profile).toBe(join(dataRoot, 'native-v1', 'attached', id, 'profile'));
        for (const app of ['code', 'browser']) expect(existsSync(join(handoff.profile, app))).toBe(true);
        await request('/api/native/handoffs', { id: handoff.id, state: 'opened' });
        expect((await (await pending).json()).state).toBe('opened');
    });
    test('requires a UUID and an absolute existing directory, and releases the lock on failure', () => {
        const dataRoot = temp(); const root = temp();
        writeFileSync(join(root, 'file'), 'not a directory');
        const link = join(root, 'link'); symlinkSync(temp(), link);
        for (const attachedWorkspace of [
            { id: '../escape', root }, { id: randomUUID(), root: 'relative' },
            { id: randomUUID(), root: join(root, 'absent') }, { id: randomUUID(), root: join(root, 'file') },
            { id: randomUUID(), root: link },
        ]) {
            expect(() => createNativeRuntime({ dataRoot, adminToken: token(), attachedWorkspace })).toThrow();
            acquireDataRoot(dataRoot)();
        }
    });
});

test.skipIf(process.env.EZIL_NATIVE_SOCKET_TESTS !== '1')('real Bun binds an OS-selected loopback port', async () => {
    const root = temp(); const admin = token();
    const server = startNativeServer({ dataRoot: root, adminToken: admin }); servers.push(server);
    expect(server.port).toBeGreaterThan(0);
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
    const response = await fetch(`${server.origin}/api/native/operations`, {
        method: 'POST', headers: { origin: server.origin, authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'workspace.create', name: 'Guest' }),
    });
    expect(response.status).toBe(200);
});
