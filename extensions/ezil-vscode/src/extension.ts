import * as vscode from 'vscode';
import { localFolder, parsePort, readBroker, readModels, sendOperation } from './broker';
import { EZiLModelProvider } from './model-provider';

let heartbeat: ReturnType<typeof setInterval> | undefined;
let report: ((operation: Record<string, unknown>) => Promise<void>) | undefined;
const ports = new Set<number>();
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    if (!vscode.workspace.isTrusted) {
        const waiting = vscode.workspace.onDidGrantWorkspaceTrust(() => {
            waiting.dispose();
            void activate(context).catch(() => { console.info('EZIL_CONNECTOR_INITIALIZATION_FAILED'); });
        });
        context.subscriptions.push(waiting);
        return;
    }
    const folders = () => (vscode.workspace.workspaceFolders ?? []).map(folder => localFolder(folder.uri));
    if (process.env.EZIL_AI_BROKER_FILE) {
        context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('ezil', new EZiLModelProvider(() => process.env.EZIL_AI_BROKER_FILE, folders)));
        context.subscriptions.push(vscode.commands.registerCommand('ezil.listModels', async () => {
            try {
                const descriptor = readBroker(process.env.EZIL_AI_BROKER_FILE, folders());
                if (!('url' in descriptor)) throw new Error('model_broker_unavailable');
                const models = await readModels(descriptor);
                void vscode.window.showInformationMessage(models.length ? `EZiL broker models: ${models.join(', ')}` : 'No EZiL broker models are configured.');
            } catch { void vscode.window.showInformationMessage('EZiL model broker is unavailable.'); }
        }));
    }
    if (!process.env.EZIL_BROKER_FILE) { console.info('EZIL_CONNECTOR_NO_DESCRIPTOR'); return; }
    try {
        if ('url' in readBroker(process.env.EZIL_BROKER_FILE, folders())) throw new Error('connector_unavailable');
    } catch {
        console.info('EZIL_CONNECTOR_INVALID_DESCRIPTOR');
        void vscode.window.showInformationMessage('EZiL connector is unavailable. You can keep using VS Code.');
        return;
    }
    report = async operation => {
        // Electron renews the short-lived connector capability atomically in this
        // private descriptor. Never cache it or store provider secrets in VS Code.
        const descriptor = readBroker(process.env.EZIL_BROKER_FILE, folders());
        if (!('origin' in descriptor)) throw new Error('connector_unavailable');
        await sendOperation(descriptor, operation);
    };
    const refresh = async () => {
        await report?.({ op: 'editor.readiness', state: 'active' });
        for (const port of ports) await report?.({ op: 'preview.register', port });
    };
    try { await refresh(); console.info('EZIL_CONNECTOR_READY'); }
    catch { void vscode.window.showInformationMessage('EZiL connector is unavailable. You can keep using VS Code.'); }
    let refreshing = false;
    heartbeat = setInterval(() => {
        if (refreshing) return;
        refreshing = true;
        void refresh().catch(() => {}).finally(() => { refreshing = false; });
    }, 15_000);
    for (const register of [true, false]) context.subscriptions.push(vscode.commands.registerCommand(
        register ? 'ezil.registerPreview' : 'ezil.unregisterPreview', async () => {
            const input = await vscode.window.showInputBox({
                title: register ? 'Register loopback preview' : 'Unregister loopback preview',
                prompt: 'Port on 127.0.0.1 (1024–65535)',
                validateInput: text => parsePort(text) === undefined ? 'Enter a port from 1024 to 65535.' : undefined,
            });
            if (input === undefined) return;
            const port = parsePort(input);
            if (port === undefined) return;
            try {
                await report?.({ op: register ? 'preview.register' : 'preview.unregister', port });
                if (register) ports.add(port); else ports.delete(port);
                void vscode.window.showInformationMessage(register ? 'Loopback preview registered.' : 'Loopback preview unregistered.');
            } catch { void vscode.window.showInformationMessage('EZiL connector is unavailable. Please reopen this workspace from EZiL OS.'); }
        },
    ));
    context.subscriptions.push({ dispose: () => { clearInterval(heartbeat); } });
}
export async function deactivate(): Promise<void> {
    clearInterval(heartbeat);
    try {
        for (const port of ports) await report?.({ op: 'preview.unregister', port });
        // Extension shutdown is not proof that the editor/process has exited.
        await report?.({ op: 'editor.readiness', state: 'unknown' });
    } catch { /* Heartbeat expiry also yields unknown; removal remains refused. */ }
    ports.clear(); report = undefined;
}
