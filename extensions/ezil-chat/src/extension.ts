import * as vscode from 'vscode';
import * as path from 'node:path';
import { PINNED_OPENCODE_VERSION, readSettings } from './config';
import { DiffReviewer } from './edits/diff';
import { openWorkspaceFile, searchWorkspaceFiles, selectionMention } from './mentions';
import { modelKey } from './opencode/adapter';
import { V2Client } from './opencode/v2';
import { ChatController, type ControllerHost } from './panel/controller';
import { ChatViewProvider, VIEW_ID } from './panel/provider';
import { ServerManager, type ServerManagerOptions } from './server/manager';

const REVEALED_KEY = 'ezil-chat.revealed';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel('EZiL Chat', { log: true });
    context.subscriptions.push(output);
    const folder = vscode.workspace.workspaceFolders?.[0];
    const directory = folder?.uri.scheme === 'file' ? folder.uri.fsPath : process.cwd();
    const settings = readSettings();

    const managerOptions: ServerManagerOptions = {
        command: settings.opencodePath, cwd: directory, expectedVersion: PINNED_OPENCODE_VERSION,
        log: line => output.appendLine(line),
    };
    if (settings.configPath) managerOptions.configPath = settings.configPath;
    if (settings.serverUrl) {
        managerOptions.externalUrl = settings.serverUrl;
        if (settings.serverPassword) managerOptions.externalPassword = settings.serverPassword;
    }
    const manager = new ServerManager(managerOptions);
    const reviewer = new DiffReviewer(directory);
    context.subscriptions.push(reviewer, { dispose: () => { void manager.dispose(); } });

    let provider: ChatViewProvider | undefined;
    const host: ControllerHost = {
        post: message => provider?.post(message),
        searchFiles: searchWorkspaceFiles,
        openFile: (file, line) => openWorkspaceFile(directory, file, line),
        showDiff: (file, patch) => reviewer.review({ file, patch, additions: 0, deletions: 0, status: 'modified' }, { offerRevert: false }),
        filesEdited: async (_sessionId, files) => { for (const file of files) await reviewer.review(file); },
        log: line => output.appendLine(line),
        defaults: () => {
            const current = readSettings();
            const defaults: ReturnType<ControllerHost['defaults']> = { agent: current.defaultAgent };
            if (current.defaultModel) defaults.model = current.defaultModel;
            return defaults;
        },
    };
    const controller = new ChatController(host, manager, endpoint => {
        const options: ConstructorParameters<typeof V2Client>[0] = { baseUrl: endpoint.baseUrl, directory, username: endpoint.username };
        if (endpoint.password) options.password = endpoint.password;
        return new V2Client(options);
    });
    provider = new ChatViewProvider(context.extensionUri, controller);
    context.subscriptions.push(
        { dispose: () => controller.dispose() },
        vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.commands.registerCommand('ezil-chat.open', () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
        vscode.commands.registerCommand('ezil-chat.newSession', async () => {
            await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
            await controller.newSession().catch(error => notify(error));
        }),
        vscode.commands.registerCommand('ezil-chat.addSelectionToChat', async () => {
            const mention = selectionMention(vscode.window.activeTextEditor);
            if (!mention) { void vscode.window.showInformationMessage('Select text in a file to add it to EZiL Chat.'); return; }
            controller.addMention(mention);
            await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        }),
        vscode.commands.registerCommand('ezil-chat.restartServer', () => manager.restart().catch(error => notify(error))),
        vscode.commands.registerCommand('ezil-chat.pickModel', async () => {
            const models = controller.models;
            if (!models.length) { void vscode.window.showInformationMessage('No models reported by OpenCode yet.'); return; }
            const picked = await vscode.window.showQuickPick(
                models.filter(model => model.enabled).map(model => ({ label: model.name, description: modelKey(model), model })),
                { placeHolder: 'Model for the current EZiL Chat session', matchOnDescription: true },
            );
            if (!picked) return;
            const variant = picked.model.variants.length
                ? await vscode.window.showQuickPick(['default', ...picked.model.variants], { placeHolder: 'Reasoning variant' })
                : 'default';
            if (variant === undefined) return;
            const ref = { providerID: picked.model.providerID, modelID: picked.model.modelID, ...(variant !== 'default' ? { variant } : {}) };
            await controller.setModel(ref).catch(error => notify(error));
        }),
    );

    output.appendLine(`EZiL Chat activated for ${directory} (pinned opencode ${PINNED_OPENCODE_VERSION}, binary ${settings.opencodePath})`);
    if (settings.autoStart) {
        manager.start().catch(error => {
            output.appendLine(`server start failed: ${error instanceof Error ? error.message : String(error)}`);
            void vscode.window.showWarningMessage(`EZiL Chat could not start OpenCode (${path.basename(settings.opencodePath)}): ${error instanceof Error ? error.message : String(error)}`, 'Open Log', 'Retry')
                .then(choice => { if (choice === 'Open Log') output.show(); else if (choice === 'Retry') void manager.restart(); });
        });
    }
    if (settings.revealOnStartup && !context.workspaceState.get<boolean>(REVEALED_KEY)) {
        const visibility = vscode.workspace.getConfiguration('workbench.secondarySideBar').get<string>('defaultVisibility', 'visibleInWorkspace');
        if (visibility !== 'hidden') {
            await context.workspaceState.update(REVEALED_KEY, true);
            void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        }
    }
}

export function deactivate(): void { /* disposables registered on the context handle shutdown */ }

function notify(error: unknown): void {
    void vscode.window.showErrorMessage(`EZiL Chat: ${error instanceof Error ? error.message : String(error)}`);
}
