import { FrameMessages } from './messages';
import { persistedState, PreviewHistory, safeUrl, viewport } from './state';
import { record, validateMintReply } from './contract';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; setState(state: unknown): void };
const vscode = acquireVsCodeApi();
const frame = document.getElementById('app') as HTMLIFrameElement;
const element = (id: string) => document.getElementById(id)!;
const button = (id: string) => element(id) as HTMLButtonElement;
const origin = frame.dataset.origin!;
const initialUrl = frame.dataset.url!;
delete frame.dataset.url;
let state = persistedState({ path: frame.dataset.path, viewport: frame.dataset.viewport });
const history = new PreviewHistory(state.path);
const messages = new FrameMessages(origin);
let nonce = '';
let waiting: ReturnType<typeof setTimeout> | undefined;
let ready = false;
let diagnostic = false;
const post = (message: unknown) => vscode.postMessage(message);
const status = (text: string, retry = false) => { element('status').textContent = text; button('retry').hidden = !retry; };
const save = () => vscode.setState(persistedState(state));
function controls(): void {
    element('address').textContent = origin ? safeUrl(origin, state.path) : '';
    button('back').disabled = !ready || !history.back;
    button('forward').disabled = !ready || !history.forward;
    button('copy').disabled = button('external').disabled = !origin;
}
function size(): void {
    const dimensions = state.viewport === 'responsive' ? undefined : state.viewport.split('x');
    frame.style.width = dimensions ? `${dimensions[0]}px` : '100%';
    frame.style.height = dimensions ? `${dimensions[1]}px` : '100%';
    (element('viewport') as HTMLSelectElement).value = state.viewport;
}
function invalidate(): void {
    messages.invalidate(); nonce = ''; ready = false; diagnostic = false; clearTimeout(waiting); controls();
}
function load(url: string): void {
    // Extension messages cannot expand the CSP or the origin pinned by the first mint.
    if (!validateMintReply({ url, expiresAt: 1 }) || new URL(url).origin !== origin) return;
    invalidate(); post({ type: 'loading' });
    status('Loading preview…');
    frame.src = url;
}
function mode(select: boolean): void {
    messages.selecting = select;
    button('select').setAttribute('aria-pressed', String(select));
    button('interact').setAttribute('aria-pressed', String(!select));
    post({ type: 'mode', mode: select ? 'select' : 'interact' });
    if (nonce) frame.contentWindow?.postMessage({ type: 'ezil.preview.mode', v: 1, nonce, mode: select ? 'select' : 'interact' }, origin);
}
frame.addEventListener('load', () => {
    if (!origin || !frame.hasAttribute('src')) return;
    // A new load, including navigation initiated by the app, must establish a fresh hello.
    invalidate(); post({ type: 'loading' });
    nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    messages.hello(nonce);
    frame.contentWindow?.postMessage({ type: 'ezil.preview.hello', v: 1, nonce }, origin);
    mode(messages.selecting);
    waiting = setTimeout(() => { if (!ready && !diagnostic) status('Waiting for the app…', true); }, 10_000);
});
window.addEventListener('message', event => {
    if (event.source === frame.contentWindow) {
        const message = messages.accept(event, frame.contentWindow);
        if (!message) return;
        if (message.type === 'ready') { ready = true; diagnostic = false; clearTimeout(waiting); status('Preview ready.'); }
        if (message.type === 'state') { ready = false; diagnostic = true; clearTimeout(waiting); status(message.state, true); controls(); }
        if ('doc' in message) { state.path = message.doc.path; history.observed(state.path); save(); controls(); }
        post(message);
        return;
    }
    // VS Code delivers host messages with a synthetic MessageEvent; no other child window is trusted.
    if (event.source !== null && event.source !== window) return;
    const message: unknown = event.data;
    if (!record(message)) return;
    if (message.type === 'load' && typeof message.url === 'string') load(message.url);
    else if (message.type === 'invalidate') invalidate();
    else if (message.type === 'status' && typeof message.text === 'string') status(message.text, message.retry === true);
});
for (const id of ['reload', 'retry', 'copy', 'external']) button(id).addEventListener('click', () => post({ type: id }));
for (const [id, direction] of [['back', -1], ['forward', 1]] as const) button(id).addEventListener('click', () => {
    const path = history.move(direction);
    if (path !== undefined) { ready = false; post({ type: 'history', path }); controls(); }
});
button('select').addEventListener('click', () => mode(true));
button('interact').addEventListener('click', () => mode(false));
element('viewport').addEventListener('change', event => {
    state.viewport = viewport((event.target as HTMLSelectElement).value);
    size(); save(); post({ type: 'viewport', viewport: state.viewport });
});
controls(); size(); save(); post({ type: 'boot' });
if (initialUrl) load(initialUrl);
