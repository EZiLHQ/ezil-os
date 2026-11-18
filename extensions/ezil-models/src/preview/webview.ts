import { FrameMessages } from './messages';
import { frameTarget, persistedState, PreviewHistory, safeUrl, viewport } from './state';
import { record, sameDoc, validToken, validateAgentAction, validateDoc, type PreviewDoc } from './contract';

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
let documentState: PreviewDoc | undefined;
let shared = false;
let sharing: { id: string; doc: PreviewDoc } | undefined;
let agentRequest: { id: string; doc: PreviewDoc } | undefined;
let nonce = '';
let waiting: ReturnType<typeof setTimeout> | undefined;
let ready = false;
let diagnostic = false;
const post = (message: unknown) => vscode.postMessage(message);
const status = (text: string, retry = false) => { element('status').textContent = text; button('retry').hidden = !retry; };
const save = () => vscode.setState(persistedState(state));
const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromPreloader(event: MessageEvent): boolean {
    const source = event.source;
    if (!event.isTrusted || event.origin !== window.origin || !source || !('frames' in source)) return false;
    // VS Code masks window.parent in its content frame. The sender still has this frame as a direct child.
    for (let i = 0; i < source.frames.length; i++) if (source.frames[i] === window) return true;
    return false;
}
function controls(): void {
    element('address').textContent = origin ? safeUrl(origin, state.path) : '';
    button('back').disabled = !ready || !history.back;
    button('forward').disabled = !ready || !history.forward;
    button('external').disabled = !origin;
    button('share').disabled = !ready || !!sharing;
    button('share').setAttribute('aria-pressed', String(shared));
}
function size(): void {
    const dimensions = state.viewport === 'responsive' ? undefined : state.viewport.split('x');
    frame.style.width = dimensions ? `${dimensions[0]}px` : '100%';
    frame.style.height = dimensions ? `${dimensions[1]}px` : '100%';
    (element('viewport') as HTMLSelectElement).value = state.viewport;
}
function setShared(enabled: boolean): void {
    if (shared !== enabled && nonce) frame.contentWindow?.postMessage({ type: 'ezil.preview.share', v: 1, nonce, enabled }, origin);
    shared = enabled;
    sharing = undefined;
    if (!enabled) agentRequest = undefined;
    controls();
}
function invalidate(): void {
    setShared(false);
    documentState = undefined;
    messages.invalidate(); nonce = ''; ready = false; diagnostic = false; clearTimeout(waiting); controls();
}
function load(url: string): void {
    const target = frameTarget(url, origin);
    if (!target) return;
    invalidate(); post({ type: 'loading' });
    status('Loading preview…');
    frame.src = target;
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
    nonce = newToken();
    messages.hello(nonce);
    frame.contentWindow?.postMessage({ type: 'ezil.preview.hello', v: 1, nonce }, origin);
    mode(messages.selecting);
    waiting = setTimeout(() => { if (!ready && !diagnostic) status('Waiting for the app…', true); }, 10_000);
});
window.addEventListener('message', event => {
    if (frame.contentWindow && event.source === frame.contentWindow) {
        const message = messages.accept(event, frame.contentWindow);
        if (!message) return;
        if (message.type === 'agent-result') {
            if (shared && agentRequest?.id === message.id && sameDoc(agentRequest.doc, message.doc)) {
                agentRequest = undefined;
                post(message);
            }
            return;
        }
        if (message.type === 'ready') { ready = true; diagnostic = false; clearTimeout(waiting); status('Preview ready.'); }
        if (message.type === 'state') { ready = false; diagnostic = true; documentState = undefined; setShared(false); clearTimeout(waiting); status(message.state, true); }
        if ('doc' in message) {
            if (message.type === 'navigate' || (documentState && documentState.path !== message.doc.path)) setShared(false);
            documentState = message.doc;
            state.path = message.doc.path; history.observed(state.path); save(); controls();
        }
        post(message);
        return;
    }
    // The VS Code webview preloader forwards extension messages from our same-origin parent.
    // Some hosts deliver a synthetic message instead. The app frame is checked above on its own boundary.
    if (event.source !== null && event.source !== window && !fromPreloader(event)) return;
    const message: unknown = event.data;
    if (!record(message)) return;
    if (message.type === 'load' && typeof message.url === 'string') load(message.url);
    else if (message.type === 'invalidate') invalidate();
    else if (message.type === 'status' && typeof message.text === 'string') status(message.text, message.retry === true);
    else if (message.type === 'agent-available') button('share').hidden = message.available !== true;
    else if (message.type === 'agent-share') {
        if (message.enabled === false) setShared(false);
        else if (ready && sharing && sharing.id === message.id && validateDoc(message.doc) && sameDoc(sharing.doc, message.doc)
            && sameDoc(documentState, message.doc)) setShared(true);
        else if (sharing?.id === message.id) { setShared(false); post({ type: 'agent-share', enabled: false }); }
    } else if (message.type === 'agent-cancel' && agentRequest?.id === message.id) agentRequest = undefined;
    else if (message.type === 'agent' && shared && ready && nonce && !agentRequest && validToken(message.id)
        && validateDoc(message.doc) && sameDoc(documentState, message.doc) && validateAgentAction(message)) {
        agentRequest = { id: message.id, doc: message.doc };
        frame.contentWindow?.postMessage({ type: 'ezil.preview.agent', v: 1, nonce,
            id: message.id, doc: message.doc, action: message.action, ...(message.action === 'click' ? { ref: message.ref } : {}) }, origin);
    }
});
for (const id of ['reload', 'retry', 'external']) button(id).addEventListener('click', () => {
    if (id !== 'external') setShared(false);
    post({ type: id });
});
for (const [id, direction] of [['back', -1], ['forward', 1]] as const) button(id).addEventListener('click', () => {
    const path = history.move(direction);
    if (path !== undefined) { ready = false; setShared(false); post({ type: 'history', path }); }
});
button('select').addEventListener('click', () => mode(true));
button('interact').addEventListener('click', () => mode(false));
button('share').addEventListener('click', event => {
    if (!event.isTrusted || !ready || !documentState || sharing || button('share').hidden) return;
    if (shared) { setShared(false); post({ type: 'agent-share', enabled: false }); return; }
    sharing = { id: newToken(), doc: documentState };
    post({ type: 'agent-share', enabled: true, ...sharing });
    controls();
});
element('viewport').addEventListener('change', event => {
    state.viewport = viewport((event.target as HTMLSelectElement).value);
    size(); save(); post({ type: 'viewport', viewport: state.viewport });
});
controls(); size(); save(); post({ type: 'boot' });
if (initialUrl) load(initialUrl);
