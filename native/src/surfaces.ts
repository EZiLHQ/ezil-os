import { exact, NativeError, object, previewPort, workspaceId } from './contract.ts';

/** CSS pixels relative to the shell viewport. Electron must convert for zoom/DPI. */
export interface SurfaceBounds { x: number; y: number; width: number; height: number }
export interface SurfaceIdentity { workspaceId: string; surfaceId: string; generation: number; sequence: number }
export type SurfaceOperation = SurfaceIdentity & (
    | { op: 'code.open' | 'code.status' | 'code.close' }
    | { op: 'preview.open'; port: number }
    | { op: 'preview.status' | 'preview.close' }
    | { op: 'browser.attach' | 'browser.focus' | 'browser.detach' | 'browser.snapshot' | 'browser.status' }
    | { op: 'browser.navigate'; url: string }
    | { op: 'browser.back' | 'browser.forward' | 'browser.reload' }
    | { op: 'browser.layout'; bounds: SurfaceBounds; visible: boolean; occluded: boolean }
);
export interface BrowserState {
    revision: number; url: string; title: string; loading: boolean;
    error: string | null; canGoBack: boolean; canGoForward: boolean;
}
export type SurfaceResult = { ok: true; browserState?: BrowserState } & SurfaceIdentity & (
    | { state: 'starting' | 'closed' | 'ready' | 'unavailable' | 'failed' }
    | { state: 'ready'; url: string }
    | { state: 'ready'; snapshot: string }
);
export const NATIVE_EVENTS = ['code_starting', 'code_ready', 'code_failed', 'browser_attached', 'browser_detached',
    'browser_failed', 'preview_ready', 'preview_failed', 'workspace_changed'] as const;
export interface NativeDiagnosticEvent { event: typeof NATIVE_EVENTS[number]; t: number; durationMs?: number }
/** The host owns processes, frame URLs and native views; no executable/path/URL input comes from the renderer. */
export interface NativeHostAdapter {
    surface(operation: SurfaceOperation): Promise<SurfaceResult>;
    diagnostics?(workspaceId: string): Promise<NativeDiagnosticEvent[]>;
}
export function surfaceBounds(value: unknown): SurfaceBounds {
    const b = object(value); exact(b, ['x', 'y', 'width', 'height']);
    for (const key of ['x', 'y', 'width', 'height']) {
        if (typeof b[key] !== 'number' || !Number.isFinite(b[key]) || Math.abs(b[key]) > 32768) throw new NativeError('invalid_bounds');
    }
    if (Number(b.width) < 0 || Number(b.height) < 0) throw new NativeError('invalid_bounds');
    return b as unknown as SurfaceBounds;
}
export function parseSurfaceOperation(value: unknown): SurfaceOperation {
    const b = object(value);
    workspaceId(b.workspaceId); workspaceId(b.surfaceId);
    if (!Number.isSafeInteger(b.generation) || Number(b.generation) < 1 || !Number.isSafeInteger(b.sequence) || Number(b.sequence) < 1) throw new NativeError('invalid_sequence');
    const keys = ['op', 'workspaceId', 'surfaceId', 'generation', 'sequence'];
    switch (b.op) {
        case 'code.open': case 'code.status': case 'code.close':
        case 'preview.status': case 'preview.close':
        case 'browser.attach': case 'browser.focus': case 'browser.detach': case 'browser.snapshot': case 'browser.status':
        case 'browser.back': case 'browser.forward': case 'browser.reload': break;
        case 'browser.navigate': {
            keys.push('url');
            if (typeof b.url !== 'string' || b.url.length > 4096) throw new NativeError('invalid_surface_url');
            let url: URL; try { url = new URL(b.url); } catch { throw new NativeError('invalid_surface_url'); }
            if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)
                || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new NativeError('invalid_surface_url');
            break;
        }
        case 'preview.open': keys.push('port'); previewPort(b.port); break;
        case 'browser.layout':
            keys.push('bounds', 'visible', 'occluded'); surfaceBounds(b.bounds);
            if (typeof b.visible !== 'boolean' || typeof b.occluded !== 'boolean') throw new NativeError('invalid_visibility');
            break;
        default: throw new NativeError('unknown_operation');
    }
    exact(b, keys);
    return b as unknown as SurfaceOperation;
}
/** Never accept credentials, query strings, fragments or arbitrary network hosts in frame URLs. */
export function nativeFrameUrl(value: unknown): string {
    if (typeof value !== 'string') throw new NativeError('invalid_surface_url');
    let url: URL;
    try { url = new URL(value); } catch { throw new NativeError('invalid_surface_url'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash) throw new NativeError('invalid_surface_url');
    previewPort(Number(url.port));
    return url.href;
}
export function nativeEvents(value: unknown): NativeDiagnosticEvent[] {
    if (!Array.isArray(value)) return [];
    return value.slice(-100).flatMap(e => {
        if (!e || !NATIVE_EVENTS.includes(e.event) || !Number.isFinite(e.t) || e.t < 0) return [];
        return [{ event: e.event, t: e.t, ...(Number.isFinite(e.durationMs) && e.durationMs >= 0 && e.durationMs <= 3600000 ? { durationMs: e.durationMs } : {}) }];
    });
}

/** Reserves sequence numbers before awaiting the host, including close tombstones. */
export class SurfaceLifecycle {
    private entries = new Map<string, { generation: number; sequence: number; kind: string; closed: boolean; port?: number }>();
    accept(op: SurfaceOperation): void {
        const key = `${op.workspaceId}:${op.surfaceId}`;
        const prev = this.entries.get(key);
        const kind = op.op.split('.')[0]!;
        const opens = ['code.open', 'preview.open', 'browser.attach'].includes(op.op);
        if (prev && (op.generation < prev.generation || (op.generation === prev.generation && (op.sequence <= prev.sequence || prev.closed || prev.kind !== kind)))) throw new NativeError('stale_surface', 409);
        if ((!prev || op.generation > prev.generation) && !opens) throw new NativeError('surface_required', 409);
        this.entries.set(key, { generation: op.generation, sequence: op.sequence, kind,
            closed: /\.(close|detach)$/.test(op.op), port: op.op === 'preview.open' ? op.port : prev?.port });
    }
    port(op: SurfaceIdentity): number | undefined { return this.entries.get(`${op.workspaceId}:${op.surfaceId}`)?.port; }
    current(op: SurfaceIdentity): boolean {
        const entry = this.entries.get(`${op.workspaceId}:${op.surfaceId}`);
        return entry?.generation === op.generation && entry?.sequence === op.sequence;
    }
    hasWorkspace(id: string): boolean { return [...this.entries].some(([key, entry]) => key.startsWith(`${id}:`) && !entry.closed); }
}
