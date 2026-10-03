import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { HostToWebview } from '../protocol';
import type { ChatController } from './controller';

export const VIEW_ID = 'ezil-chat.panel';

/** Hosts the webview and forwards messages both ways; the controller validates and does the work. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;
    private readonly queue: HostToWebview[] = [];

    constructor(private readonly extensionUri: vscode.Uri, private readonly controller: ChatController) {}

    /** Deliver a message now, or once the view resolves. */
    post(message: HostToWebview): void {
        if (this.view) void this.view.webview.postMessage(message);
        else this.queue.push(message);
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
        view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
        view.webview.html = renderHtml(view.webview, dist);
        // Untyped on purpose: the controller runtime-checks the shape before acting on it.
        view.webview.onDidReceiveMessage((message: unknown) => { void this.controller.handle(message); });
        view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
        for (const message of this.queue.splice(0)) void view.webview.postMessage(message);
    }
}

export function nonce(): string { return randomBytes(16).toString('base64'); }

export function renderHtml(webview: vscode.Webview, dist: vscode.Uri): string {
    const token = nonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    // default-src 'none': the webview may only load our own nonce'd script and stylesheet.
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${token}'; script-src 'nonce-${token}'; font-src ${webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" nonce="${token}" href="${style.toString()}">
<title>EZiL Chat</title>
</head>
<body>
<div id="app"></div>
<script type="module" nonce="${token}" src="${script.toString()}"></script>
</body>
</html>`;
}
