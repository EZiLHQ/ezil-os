// VS Code injects `acquireVsCodeApi` into webview scripts.
interface VsCodeWebviewApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeWebviewApi;
