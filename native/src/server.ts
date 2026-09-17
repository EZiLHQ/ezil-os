import { fileURLToPath } from 'node:url';
import { Authority, type Capability } from './auth.ts';
import { exact, NativeError, object, parseOperation, workspaceId } from './contract.ts';
import { acquireDataRoot, WorkspaceStore, type AttachedWorkspace } from './workspaces.ts';
import { Handoffs } from './handoff.ts';
import { nativeBoot } from './boot.ts';
import { renderOsDocument } from '../../local/src/boot/os-document.ts';
import { ASSET_ROUTES, shellAssetResponse } from '../../local/src/boot/assets.ts';

const MAX_BODY = 4096;
const ASSETS = fileURLToPath(new URL('../../app/public/os/', import.meta.url));
function json(body: unknown, status = 200): Response {
    return Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
}
async function body(req: Request): Promise<unknown> {
    if (req.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new NativeError('json_required', 415);
    if (Number(req.headers.get('content-length')) > MAX_BODY) throw new NativeError('body_too_large', 413);
    const reader = req.body?.getReader();
    if (!reader) throw new NativeError('invalid_request');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > MAX_BODY) { await reader.cancel(); throw new NativeError('body_too_large', 413); }
            chunks.push(chunk.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (err) { if (err instanceof NativeError) throw err; throw new NativeError('invalid_request'); }
}
function admin(cap: Capability): void { if (cap.role !== 'admin') throw new NativeError('forbidden', 403); }

export interface NativeOptions { dataRoot: string; adminToken: string; attachedWorkspace?: AttachedWorkspace; handoffTimeoutMs?: number; now?: () => number }
/** The actual HTTP handler, separated from TCP binding so its security gates can be tested without a socket. */
export function createNativeRuntime(options: NativeOptions) {
    const authority = new Authority(options.adminToken, options.now);
    const release = acquireDataRoot(options.dataRoot);
    let store: WorkspaceStore;
    try { store = new WorkspaceStore(options.dataRoot, options.attachedWorkspace); }
    catch (err) { release(); throw err; }
    const handoffs = new Handoffs(options.handoffTimeoutMs);
    const previews = new Map<string, Set<number>>();
    const editorSeen = new Map<string, number>();
    const now = options.now ?? Date.now;
    const refreshEditor = (id: string) => {
        const record = store.get(id);
        if (record.editorState === 'active' && now() - (editorSeen.get(id) ?? 0) >= 45_000) {
            previews.delete(id);
            return store.setEditor(id, 'unknown');
        }
        return record;
    };
    return {
        stop() { handoffs.stop(); release(); },
        async fetch(req: Request, origin: string): Promise<Response> {
            try {
                const url = new URL(req.url);
                if (req.headers.get('host') !== new URL(origin).host || url.origin !== origin) throw new NativeError('invalid_host', 403);
                if (url.search || req.headers.has('cookie')) throw new NativeError('invalid_request');
                // Static committed assets carry no identity or authority. Browser subresources
                // omit Origin; if present it must still match. Every document/API needs both.
                if (req.headers.has('upgrade')) throw new NativeError('websocket_unsupported', 400);
                const asset = Object.hasOwn(ASSET_ROUTES, url.pathname) ? ASSET_ROUTES[url.pathname] : undefined;
                if (asset && req.method === 'GET') {
                    const sentOrigin = req.headers.get('origin');
                    if (sentOrigin !== null && sentOrigin !== origin) throw new NativeError('invalid_origin', 403);
                    return shellAssetResponse(ASSETS, asset, req) ?? json({ ok: false, error: 'asset_missing' }, 404);
                }
                const navigation = url.pathname === '/os' && req.method === 'GET'
                    && req.headers.get('origin') === null
                    && req.headers.get('sec-fetch-mode') === 'navigate'
                    && req.headers.get('sec-fetch-dest') === 'document';
                if (!navigation && req.headers.get('origin') !== origin) throw new NativeError('invalid_origin', 403);
                const cap = authority.authenticate(req.headers.get('authorization'));
                if ((url.pathname === '/os' || url.pathname === '/api/native/boot') && req.method === 'GET') {
                    if (cap.role === 'connector') throw new NativeError('forbidden', 403);
                    const id = cap.workspaceId ?? store.selectedId;
                    if (!id) throw new NativeError('workspace_required', 409);
                    const payload = nativeBoot(refreshEditor(id));
                    if (url.pathname !== '/os') return json(payload);
                    return new Response(renderOsDocument(payload), { headers: {
                        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
                        'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
                        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
                    } });
                }
                if (url.pathname === '/api/native/capabilities' && req.method === 'POST') {
                    admin(cap);
                    const input = object(await body(req));
                    exact(input, ['workspaceId', 'role']);
                    const id = workspaceId(input.workspaceId); store.get(id);
                    if (input.role !== 'shell' && input.role !== 'connector') throw new NativeError('invalid_role');
                    return json({ ok: true, ...authority.mint(input.role, id) });
                }
                if (url.pathname === '/api/native/previews' && req.method === 'GET') {
                    admin(cap);
                    const id = store.selectedId;
                    if (!id) throw new NativeError('workspace_required', 409);
                    const workspace = refreshEditor(id);
                    return json({ ok: true, workspaceId: id, editorState: workspace.editorState,
                        ports: [...(previews.get(id) ?? [])].sort((a, b) => a - b) });
                }
                if (url.pathname === '/api/native/handoffs') {
                    admin(cap);
                    if (req.method === 'GET') return json({ ok: true, handoffs: handoffs.take() });
                    if (req.method === 'POST') {
                        const input = object(await body(req)); exact(input, ['id', 'state']);
                        const id = workspaceId(input.id);
                        if (input.state !== 'opened' && input.state !== 'unavailable') throw new NativeError('invalid_state');
                        handoffs.complete(id, input.state);
                        return json({ ok: true });
                    }
                }
                if (url.pathname !== '/api/native/operations' || req.method !== 'POST') throw new NativeError('not_found', 404);
                const op = parseOperation(await body(req));
                authority.authorize(cap, op);
                if ('workspaceId' in op) refreshEditor(op.workspaceId);
                switch (op.op) {
                    case 'workspace.list': return json({ ok: true, workspaces: store.list().map(r => refreshEditor(r.id)) });
                    case 'workspace.create': return json({ ok: true, workspace: store.create(op.name) });
                    case 'workspace.get': return json({ ok: true, workspace: refreshEditor(op.workspaceId) });
                    case 'workspace.select': return json({ ok: true, workspace: store.select(op.workspaceId) });
                    case 'workspace.remove':
                        if (handoffs.hasWorkspace(op.workspaceId)) throw new NativeError('handoff_pending', 409);
                        store.remove(op.workspaceId); authority.revokeWorkspace(op.workspaceId); previews.delete(op.workspaceId); editorSeen.delete(op.workspaceId);
                        return json({ ok: true });
                    case 'editor.readiness':
                        store.setEditor(op.workspaceId, op.state);
                        if (op.state === 'active') editorSeen.set(op.workspaceId, now());
                        else { editorSeen.delete(op.workspaceId); previews.delete(op.workspaceId); }
                        return json({ ok: true, state: op.state });
                    case 'preview.register': case 'preview.unregister': {
                        if (op.port === Number(new URL(origin).port)) throw new NativeError('invalid_preview_port');
                        const ports = previews.get(op.workspaceId) ?? new Set<number>();
                        if (op.op === 'preview.register') {
                            if (store.get(op.workspaceId).editorState !== 'active') throw new NativeError('editor_not_ready', 409);
                            if (ports.size >= 16 && !ports.has(op.port)) throw new NativeError('preview_limit', 409);
                            ports.add(op.port); previews.set(op.workspaceId, ports);
                        } else ports.delete(op.port);
                        return json({ ok: true, port: op.port });
                    }
                    case 'surface.open': case 'surface.focus': {
                        // Until Electron proves exit, an attempted Code launch is uncertain.
                        // A queued/in-flight launch must never race successful removal.
                        if (op.surface === 'code' && store.get(op.workspaceId).editorState === 'closed') store.setEditor(op.workspaceId, 'unknown');
                        const state = await handoffs.open({ workspaceId: op.workspaceId, surface: op.surface, action: op.op === 'surface.open' ? 'open' : 'focus',
                            ...store.paths(op.workspaceId), previewPorts: [...(previews.get(op.workspaceId) ?? [])] });
                        return json({ ok: true, state });
                    }
                }
            } catch (err) {
                // Never reflect parser errors, paths, headers, env, URLs, or adapter errors.
                return json({ ok: false, error: err instanceof NativeError ? err.code : 'native_failure' }, err instanceof NativeError ? err.status : 500);
            }
        },
    };
}

export function startNativeServer(options: NativeOptions) {
    const runtime = createNativeRuntime(options);
    let origin = '';
    try {
        const server = Bun.serve({
            hostname: '127.0.0.1', port: 0, maxRequestBodySize: MAX_BODY, idleTimeout: 15,
            fetch: req => runtime.fetch(req, origin),
            error: () => json({ ok: false, error: 'native_failure' }, 500),
        });
        origin = `http://127.0.0.1:${server.port}`;
        return { port: server.port!, origin, async stop() { runtime.stop(); await server.stop(true); } };
    } catch (err) { runtime.stop(); throw err; }
}
