import * as path from 'node:path';
import * as vscode from 'vscode';
import { hasBrowserCapability } from './browser-mcp-stdio';

export function registerBrowserMcp(context: vscode.ExtensionContext): void {
    if (!hasBrowserCapability(process.env) || typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function'
        || typeof vscode.McpStdioServerDefinition !== 'function') return;
    context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('ezil-browser', {
        provideMcpServerDefinitions() {
            const adapter = path.join(context.extensionPath, 'dist', 'browser-mcp-server.js');
            // The workspace extension host and this stdio child inherit the sandbox boot environment.
            // Keep the capability out of the definition, which also crosses to the workbench.
            return [new vscode.McpStdioServerDefinition('EZiL Browser', process.execPath, [adapter], undefined, '1')];
        },
    }));
}
