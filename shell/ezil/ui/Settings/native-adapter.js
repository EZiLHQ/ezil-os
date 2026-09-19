import { selectRuntimeAdapter } from '../../native-runtime.js';

/** Only the existing Computers actions are mapped. The preload owns local workspace selection. */
export async function nativeSettingsRequest (path, input, ctx) {
    const runtime = selectRuntimeAdapter(ctx);
    if (!runtime) return null;
    const id = input?.id;
    const operations = {
        'computer.list': { op: 'workspace.list' },
        'computer.create': { op: 'workspace.create', name: 'Computer' },
        'computer.import': { op: 'workspace.attach' },
        'computer.relink': { op: 'workspace.relink', workspaceId: id },
        'computer.reveal': { op: 'workspace.reveal', workspaceId: id },
        'computer.openVSCode': { op: 'workspace.openVSCode', workspaceId: id },
        'computer.openXcode': { op: 'workspace.openXcode', workspaceId: id },
        'computer.rename': { op: 'workspace.rename', workspaceId: id, name: input?.name },
        'computer.delete': { op: 'workspace.remove', workspaceId: id },
        'computer.select': { op: 'workspace.select', workspaceId: id },
    };
    if (!Object.hasOwn(operations, path)) return { ok: false, code: 'UNSUPPORTED', message: 'Unavailable on this Mac.' };
    const result = await runtime.operation(operations[path]);
    if (result?.ok !== true) return { ok: false, code: 'NATIVE_UNAVAILABLE', message: result?.error === 'external_editor_running' ? 'Close the EZiL VS Code window before removing this workspace.' : result?.error === 'canceled' ? 'Operation canceled.' : 'The local workspace operation could not be completed.' };
    if (result.canceled) return { ok: true, canceled: true, data: null };
    if (['computer.reveal', 'computer.openVSCode', 'computer.openXcode'].includes(path)) return result.opened ? { ok: true, data: null } : { ok: false, code: 'NATIVE_UNAVAILABLE', message: result.reason === 'unavailable' ? 'Install Xcode to use this action.' : result.reason === 'no_project' ? 'No Xcode project or Swift package was found in this folder.' : 'The application could not be opened.' };
    const computer = (record, index = 0) => ({ id: record.id, name: record.name, slot: index + 1,
        createdAt: record.createdAt, lastOpenedAt: null, isNew: false, kind: record.kind, available: record.available !== false });
    if (path === 'computer.list') return { ok: true, data: Array.isArray(result.workspaces) ? result.workspaces.map(computer) : [] };
    if (path === 'computer.import' && result.canceled) return { ok: true, data: null };
    return { ok: true, data: result.workspace ? computer(result.workspace) : null };
}
