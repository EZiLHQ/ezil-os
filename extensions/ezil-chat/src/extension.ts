import * as vscode from 'vscode';
import * as path from 'node:path';
import { PINNED_OPENCODE_VERSION, readSettings, type Settings } from './config';
import { DiffReviewer } from './edits/diff';
import { errorMessage } from './errors';
import { openWorkspaceFile, searchWorkspaceFiles, selectionMention } from './mentions';
import { modelKey } from './opencode/adapter';
import { V2Client } from './opencode/v2';
import { ChatController, type ControllerHost, type ServerLike } from './panel/controller';
import { ChatViewProvider, VIEW_ID } from './panel/provider';
import { reapOrphan, ServerManager, type ServerManagerOptions, type ServerState, type SpawnRecord } from './server/manager';

const REVEALED_KEY = 'ezil-chat.revealed';
/** Last spawned `opencode serve`, so a server orphaned by an extension-host crash is reaped on the next activation. */
const SPAWN_KEY = 'ezil-chat.spawn';
const NO_FOLDER = 'Open a folder to use EZiL Chat: OpenCode runs inside the workspace folder.';

type Server = ServerLike & { dispose(): Promise<void> };

/** Stand-in server when there is no workspace folder: every start reports the reason instead of spawning at `/`. */
function noFolderServer(): Server {
    const state: ServerState = { status: 'error', message: NO_FOLDER };
    const refuse = (): Promise<never> => Promise.reject(new Error(NO_FOLDER));
    return { state, start: refuse, restart: refuse, onDidChangeState: () => ({ dispose() {} }), dispose: async () => {} };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel('EZiL Chat', { log: true });
    context.subscriptions.push(output);
    const log = (line: string): void => output.appendLine(line);
    const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.scheme === 'file');
    const directory = folder?.uri.fsPath ?? '';
    const settings = readSettings();

    const server: Server = directory ? await createManager(context, directory, settings, log) : noFolderServer();
    const reviewer = new DiffReviewer(directory, log);
    context.subscriptions.push(reviewer, { dispose: () => { void server.dispose(); } });

    let provider: ChatViewProvider | undefined;
    const host: ControllerHost = {
        post: message => provider?.post(message),
        searchFiles: searchWorkspaceFiles,
        openFile: (file, line) => openWorkspaceFile(directory, file, line),
        showDiff: (file, patch) => reviewer.review({ file, patch, additions: 0, deletions: 0, status: 'modified' }, { offerRevert: false }),
        filesEdited: async (_sessionId, files) => { for (const file of files) await reviewer.review(file); },
        log,
        defaults: () => {
            const current = readSettings();
            const defaults: ReturnType<ControllerHost['defaults']> = { agent: current.defaultAgent };
            if (current.defaultModel) defaults.model = current.defaultModel;
            return defaults;
        },
    };
    const controller = new ChatController(host, server, endpoint => {
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
        vscode.commands.registerCommand('ezil-chat.restartServer', () => server.restart().catch(error => notify(error))),
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

    if (!directory) {
        log(`EZiL Chat activated without a workspace folder; not starting OpenCode (pinned ${PINNED_OPENCODE_VERSION})`);
        void vscode.window.showWarningMessage(NO_FOLDER, 'Open Folder').then(choice => { if (choice === 'Open Folder') void vscode.commands.executeCommand('vscode.openFolder'); });
        return;
    }
    log(`EZiL Chat activated for ${directory} (pinned opencode ${PINNED_OPENCODE_VERSION}, binary ${settings.opencodePath})`);
    if (settings.autoStart) {
        server.start().catch(error => {
            log(`server start failed: ${errorMessage(error)}`);
            void vscode.window.showWarningMessage(`EZiL Chat could not start OpenCode (${path.basename(settings.opencodePath)}): ${errorMessage(error)}`, 'Open Log', 'Retry')
                .then(choice => { if (choice === 'Open Log') output.show(); else if (choice === 'Retry') void server.restart(); });
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

/** Build the ServerManager for `directory`, first reaping a server a previous host left behind, and keep the spawn record current. */
async function createManager(context: vscode.ExtensionContext, directory: string, settings: Settings, log: (line: string) => void): Promise<Server> {
    const stale = context.workspaceState.get<SpawnRecord>(SPAWN_KEY);
    if (stale) {
        await reapOrphan(stale, { log }).catch(error => log(`orphan check failed: ${errorMessage(error)}`));
        await context.workspaceState.update(SPAWN_KEY, undefined);
    }
    const options: ServerManagerOptions = { command: settings.opencodePath, cwd: directory, expectedVersion: PINNED_OPENCODE_VERSION, log };
    if (settings.configPath) options.configPath = settings.configPath;
    if (settings.serverUrl) {
        options.externalUrl = settings.serverUrl;
        if (settings.serverPassword) options.externalPassword = settings.serverPassword;
    }
    const manager = new ServerManager(options);
    manager.onDidChangeState(state => {
        if (state.status === 'ready' && state.endpoint.managed && state.endpoint.pid !== undefined && state.endpoint.password) {
            const record: SpawnRecord = { pid: state.endpoint.pid, baseUrl: state.endpoint.baseUrl, password: state.endpoint.password };
            void context.workspaceState.update(SPAWN_KEY, record);
        } else if (state.status === 'stopped') {
            void context.workspaceState.update(SPAWN_KEY, undefined);
        }
    });
    return manager;
}

export function deactivate(): void { /* disposables registered on the context handle shutdown */ }

function notify(error: unknown): void {
    void vscode.window.showErrorMessage(`EZiL Chat: ${errorMessage(error)}`);
}
