// The one MCP definition provider this extension contributes (`ezil-browser`): the Browser tool
// when the sandbox launched it, plus the owner-granted workspace attach (workspace-mcp.ts).
import * as path from 'node:path';
import * as vscode from 'vscode';
import { hasBrowserCapability } from './browser-mcp-stdio';
import { WorkspaceMcpEndpoint, WorkspaceMcpGrant } from './workspace-mcp';

export const GRANT_COMMAND = 'ezil-models.grantWorkspaceMcp';
export const REVOKE_COMMAND = 'ezil-models.revokeWorkspaceMcp';
export const GRANT_CHOICE = 'Attach for this window';

function localFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.scheme === 'file' && !folder.uri.authority ? folder.uri.fsPath : '');
}

/** The single trusted local folder a grant may name, or undefined. */
export function grantableFolder(): string | undefined {
    const folders = localFolders();
    return vscode.workspace.isTrusted && folders.length === 1 && folders[0] && path.isAbsolute(folders[0]) ? folders[0] : undefined;
}

export function registerCodeMcp(context: vscode.ExtensionContext): void {
    if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function' || typeof vscode.McpStdioServerDefinition !== 'function') return;
    const grant = new WorkspaceMcpGrant();
    let endpoint: WorkspaceMcpEndpoint | undefined;
    const changed = new vscode.EventEmitter<void>();
    const detach = async () => {
        grant.revoke();
        const closing = endpoint; endpoint = undefined;
        await closing?.close();
    };
    context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('ezil-browser', {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions() {
            const definitions: vscode.McpStdioServerDefinition[] = [];
            if (hasBrowserCapability(process.env)) {
                const adapter = path.join(context.extensionPath, 'dist', 'browser-mcp-server.js');
                // The workspace extension host and this stdio child inherit the sandbox boot environment.
                // Keep the capability out of the definition, which also crosses to the workbench.
                definitions.push(new vscode.McpStdioServerDefinition('EZiL Browser', process.execPath, [adapter], undefined, '1'));
            }
            // Served only while granted; the socket path is the sole argument and stops working on revoke.
            if (endpoint?.open && grant.live()) {
                const adapter = path.join(context.extensionPath, 'dist', 'workspace-mcp-server.js');
                definitions.push(new vscode.McpStdioServerDefinition('EZiL Workspace', process.execPath, [adapter, endpoint.socketPath], undefined, path.basename(path.dirname(endpoint.socketPath))));
            }
            return definitions;
        },
    }));
    context.subscriptions.push(
        changed,
        { dispose: () => { void detach(); } },
        vscode.workspace.onDidChangeWorkspaceFolders(() => { void detach().then(() => changed.fire()); }),
        vscode.commands.registerCommand(GRANT_COMMAND, async () => {
            const folder = grantableFolder();
            if (!folder) { void vscode.window.showInformationMessage('EZiL Workspace MCP: attach needs one trusted local workspace folder.'); return false; }
            const choice = await vscode.window.showWarningMessage(
                `Attach the read-only EZiL Workspace tool to ${folder} for this Code window?`,
                { modal: true, detail: 'Chat tools can then read this folder\'s name, path and top-level entry names (no file contents). Nothing from the repository is run or read as configuration. The attach ends when you revoke it, close the window or restart Code.' },
                GRANT_CHOICE);
            if (choice !== GRANT_CHOICE) return false;
            await detach();
            if (!grant.grant(folder)) { void vscode.window.showInformationMessage('EZiL Workspace MCP: the folder is not a directory you own.'); return false; }
            try { endpoint = await WorkspaceMcpEndpoint.open(grant); }
            catch { grant.revoke(); void vscode.window.showInformationMessage('EZiL Workspace MCP: could not open the local endpoint.'); return false; }
            changed.fire();
            void vscode.window.showInformationMessage('EZiL Workspace MCP attached for this window.');
            return true;
        }),
        vscode.commands.registerCommand(REVOKE_COMMAND, async () => {
            const was = endpoint !== undefined;
            await detach();
            if (was) changed.fire();
            void vscode.window.showInformationMessage(was ? 'EZiL Workspace MCP detached.' : 'EZiL Workspace MCP was not attached.');
            return was;
        }),
    );
}
