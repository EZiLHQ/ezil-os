import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../protocol';
import type { ChatController } from './controller';

export const VIEW_ID = 'ezil-chat.panel';

/** Hosts the webview and forwards messages both ways; the controller does the work. */
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
        view.webview.onDidReceiveMessage((message: WebviewToHost) => { void this.controller.handle(message); });
        view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
        for (const message of this.queue.splice(0)) void view.webview.postMessage(message);
    }
}

export function nonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let index = 0; index < 32; index++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    return out;
}

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
