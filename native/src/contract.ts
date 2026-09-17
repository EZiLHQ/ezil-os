/** Native execution is trusted host execution, not a containment boundary. */
export const NATIVE_RUNTIME = Object.freeze({
    contractVersion: 1,
    executionTarget: 'macos-host',
    isolation: 'trusted-native',
    editor: 'external-vscode',
    browser: 'native-chromium',
    cloudSync: false,
} as const);
export type NativeRuntime = typeof NATIVE_RUNTIME;
export type Surface = 'code' | 'browser';
export type EditorState = 'active' | 'closed' | 'unknown';
export type NativeOperation =
    | { op: 'workspace.list' }
    | { op: 'workspace.create'; name: string }
    | { op: 'workspace.get' | 'workspace.select' | 'workspace.remove'; workspaceId: string }
    | { op: 'surface.open' | 'surface.focus'; workspaceId: string; surface: Surface }
    | { op: 'editor.readiness'; workspaceId: string; state: EditorState }
    | { op: 'preview.register' | 'preview.unregister'; workspaceId: string; port: number };

export class NativeError extends Error {
    constructor(readonly code: string, readonly status = 400) { super(code); }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeError('invalid_request');
    return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, keys: string[]): void {
    if (Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !(k in value))) throw new NativeError('invalid_request');
}
export function workspaceId(value: unknown): string {
    if (typeof value !== 'string' || !UUID.test(value)) throw new NativeError('invalid_workspace');
    return value;
}
export function previewPort(value: unknown): number {
    if (!Number.isInteger(value) || Number(value) < 1024 || Number(value) > 65535) throw new NativeError('invalid_preview_port');
    return Number(value);
}
export function parseOperation(value: unknown): NativeOperation {
    const body = object(value);
    const op = body.op;
    if (op === 'workspace.list') exact(body, ['op']);
    else if (op === 'workspace.create') {
        exact(body, ['op', 'name']);
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80 || /[\x00-\x1f\x7f]/.test(body.name)) throw new NativeError('invalid_name');
    } else {
        workspaceId(body.workspaceId);
        switch (op) {
            case 'workspace.get': case 'workspace.select': case 'workspace.remove': exact(body, ['op', 'workspaceId']); break;
            case 'surface.open': case 'surface.focus':
                exact(body, ['op', 'workspaceId', 'surface']);
                if (body.surface !== 'code' && body.surface !== 'browser') throw new NativeError('invalid_surface');
                break;
            case 'editor.readiness':
                exact(body, ['op', 'workspaceId', 'state']);
                if (!['active', 'closed', 'unknown'].includes(String(body.state))) throw new NativeError('invalid_editor_state');
                break;
            case 'preview.register': case 'preview.unregister':
                exact(body, ['op', 'workspaceId', 'port']); previewPort(body.port); break;
            default: throw new NativeError('unknown_operation');
        }
    }
    return body as NativeOperation;
}
