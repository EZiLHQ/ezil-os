// Webview entry: renders UiState into the DOM and relays user intent to the
// extension host via postMessage. No network access; CSP forbids it anyway.
import type { ChatMessage, FileDiff, MessagePart, ModelId, PermissionRequest, Question, QuestionAnswer, ToolCall } from '../opencode/adapter';
import { modelKey } from '../opencode/adapter';
import type { HostToWebview, Mention, WebviewToHost } from '../protocol';
import { groupModels, initialState, lastUsage, reduce, type UiState } from './reducer';

const vscode = acquireVsCodeApi();
const post = (message: WebviewToHost): void => { vscode.postMessage(message); };

let state: UiState = initialState();
let stickToBottom = true;
let renderQueued = false;

type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | ((event: Event) => void)> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (typeof value === 'function') node.addEventListener(key.replace(/^on/, ''), value);
        else if (typeof value === 'boolean') { if (value) node.setAttribute(key, ''); }
        else if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value);
    }
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
}

// ---- static skeleton -------------------------------------------------------
const statusDot = el('span', { class: 'status-dot', 'data-status': 'stopped', title: 'OpenCode server stopped', onclick: () => { if (state.server.status === 'error' || state.server.status === 'stopped') post({ type: 'restartServer' }); } });
const sessionSelect = el('select', { title: 'Session', onchange: () => { if (sessionSelect.value) post({ type: 'selectSession', sessionId: sessionSelect.value }); } });
const newButton = el('button', { title: 'New session', text: '+ New', onclick: () => post({ type: 'newSession' }) });
const banner = el('div');
const main = el('main', { onscroll: () => { stickToBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 40; } });
const chips = el('div', { class: 'chips' });
const suggest = el('div', { class: 'suggest', role: 'listbox' });
const textarea = el('textarea', { placeholder: 'Ask EZiL… Type @ to mention a file. Enter sends, Shift+Enter is a newline.', rows: '3' });
const agentSelect = el('select', { title: 'Agent', onchange: () => post({ type: 'setAgent', agent: agentSelect.value }) });
const modelSelect = el('select', { title: 'Model', onchange: () => changeModel() });
const variantSelect = el('select', { title: 'Reasoning variant', onchange: () => changeModel() });
const sendButton = el('button', { class: 'primary', text: 'Send', onclick: () => sendOrStop() });
const usage = el('div', { class: 'usage' });

document.getElementById('app')?.append(
    el('header', {}, statusDot, sessionSelect, newButton),
    banner,
    main,
    el('footer', {},
        chips,
        el('div', { class: 'composer' }, suggest, textarea),
        el('div', { class: 'toolbar' }, agentSelect, modelSelect, variantSelect, el('span', { class: 'spacer' }), sendButton),
        usage,
    ),
);

// ---- composer ---------------------------------------------------------------
let mentions: Mention[] = [];
let suggestItems: string[] = [];
let suggestActive = 0;
let suggestRequest = 0;
let suggestToken: { start: number; end: number } | undefined;

function sendOrStop(): void {
    if (state.busy) { post({ type: 'stop' }); return; }
    const text = textarea.value.trim();
    if (!text && mentions.length === 0) return;
    post({ type: 'send', text, mentions });
    textarea.value = '';
    mentions = [];
    closeSuggest();
    renderChips();
}

function changeModel(): void {
    const key = modelSelect.value;
    const model = state.models.find(item => modelKey(item) === key);
    if (!model) return;
    const ref: ModelId = { providerID: model.providerID, modelID: model.modelID };
    if (variantSelect.value) ref.variant = variantSelect.value;
    post({ type: 'setModel', model: ref });
}

function mentionToken(): { start: number; end: number; query: string } | undefined {
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, caret);
    const match = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!match) return undefined;
    const start = caret - (match[2]?.length ?? 0) - 1;
    return { start, end: caret, query: match[2] ?? '' };
}

function closeSuggest(): void { suggest.classList.remove('open'); suggestItems = []; suggestToken = undefined; }

function openSuggest(files: string[]): void {
    suggestItems = files; suggestActive = 0;
    suggest.replaceChildren(...files.map((file, index) => el('div', { class: index === 0 ? 'active' : '', text: file, onmousedown: event => { event.preventDefault(); acceptSuggest(index); } })));
    suggest.classList.toggle('open', files.length > 0);
}

function acceptSuggest(index: number): void {
    const path = suggestItems[index];
    if (!path || !suggestToken) return;
    const replacement = `@${path} `;
    textarea.setRangeText(replacement, suggestToken.start, textarea.selectionStart, 'end');
    addMention({ path, label: path });
    closeSuggest();
    textarea.focus();
}

function addMention(mention: Mention): void {
    if (mentions.some(item => item.path === mention.path && item.start === mention.start && item.end === mention.end)) return;
    mentions = [...mentions, mention];
    renderChips();
}

textarea.addEventListener('input', () => {
    const token = mentionToken();
    if (!token) { closeSuggest(); return; }
    suggestToken = { start: token.start, end: token.end };
    suggestRequest += 1;
    post({ type: 'searchFiles', requestId: suggestRequest, query: token.query });
});

textarea.addEventListener('keydown', event => {
    if (suggest.classList.contains('open')) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            suggestActive = (suggestActive + (event.key === 'ArrowDown' ? 1 : suggestItems.length - 1)) % Math.max(1, suggestItems.length);
            [...suggest.children].forEach((child, index) => child.classList.toggle('active', index === suggestActive));
            return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); acceptSuggest(suggestActive); return; }
        if (event.key === 'Escape') { event.preventDefault(); closeSuggest(); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendOrStop(); }
});

function renderChips(): void {
    chips.replaceChildren(...mentions.map((mention, index) => el('span', { class: 'chip', title: mention.path },
        mention.label,
        el('button', { title: 'Remove', text: '×', onclick: () => { mentions = mentions.filter((_, i) => i !== index); renderChips(); } }),
    )));
}

// ---- rendering --------------------------------------------------------------
function scheduleRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render(): void {
    renderHeader();
    renderBanner();
    renderMessages();
    renderToolbar();
    renderUsage();
    if (stickToBottom) main.scrollTop = main.scrollHeight;
}

function serverText(): string {
    const server = state.server;
    switch (server.status) {
        case 'ready': return `OpenCode ${server.version} at ${server.baseUrl}`;
        case 'starting': return `Starting OpenCode (attempt ${server.attempt})…`;
        case 'error': return `OpenCode error: ${server.message}. Click to restart.`;
        default: return 'OpenCode server stopped. Click to start.';
    }
}

function renderHeader(): void {
    statusDot.dataset.status = state.server.status;
    statusDot.title = serverText();
    const options = state.sessions.map(session => el('option', { value: session.id, text: session.title || 'Untitled session' }));
    sessionSelect.replaceChildren(...(state.sessions.length ? options : [el('option', { value: '', text: 'No sessions yet' })]));
    sessionSelect.value = state.currentSessionId ?? '';
}

function renderBanner(): void {
    banner.replaceChildren();
    if (state.error) {
        banner.append(el('div', { class: 'banner' }, el('span', { text: state.error }), el('button', { text: 'Dismiss', onclick: () => { state = { ...state, error: undefined }; scheduleRender(); } })));
    } else if (state.server.status === 'starting') {
        banner.append(el('div', { class: 'banner info' }, el('span', { text: serverText() })));
    }
}

function renderMessages(): void {
    const nodes: Node[] = [];
    if (state.messages.length === 0 && state.permissions.length === 0) {
        nodes.push(el('div', { class: 'empty' },
            state.currentSessionId ? 'Send a message to start this session.' : 'EZiL Chat runs OpenCode in this workspace. Start a new session or pick one above.',
        ));
    }
    for (const message of state.messages) nodes.push(renderMessage(message));
    for (const request of state.permissions) nodes.push(renderPermission(request));
    for (const question of state.questions) nodes.push(renderQuestion(question));
    main.replaceChildren(...nodes);
}

function renderMessage(message: ChatMessage): HTMLElement {
    const node = el('div', { class: `message ${message.role}` });
    if (message.role === 'user' || message.role === 'system') {
        node.append(...message.parts.map(part => part.type === 'tool' ? renderTool(part.tool) : document.createTextNode(part.text)));
        return node;
    }
    message.parts.forEach((part, index) => node.append(renderPart(part, message.streaming && index === message.parts.length - 1)));
    if (message.streaming && message.parts.length === 0) node.append(el('div', { class: 'text cursor', text: '' }));
    if (message.error) node.append(el('div', { class: 'error', text: message.error }));
    const meta: string[] = [];
    if (message.agent) meta.push(message.agent);
    if (message.model) meta.push(`${message.model.modelID}${message.model.variant ? ` · ${message.model.variant}` : ''}`);
    if (message.tokens) meta.push(`in ${message.tokens.input} · out ${message.tokens.output} · cache r ${message.tokens.cacheRead} / w ${message.tokens.cacheWrite}`);
    if (message.cost) meta.push(`$${message.cost.toFixed(4)}`);
    if (meta.length) node.append(el('div', { class: 'meta' }, ...meta.map(item => el('span', { text: item }))));
    return node;
}

function renderPart(part: MessagePart, streaming: boolean): HTMLElement {
    if (part.type === 'text') {
        const node = renderText(part.text);
        if (streaming) node.classList.add('cursor');
        return node;
    }
    if (part.type === 'reasoning') {
        return el('details', { class: 'reasoning' }, el('summary', {}, el('span', { class: 'name', text: 'Thinking' }), el('span', { class: 'hint', text: part.text.slice(0, 80) })), el('div', { class: 'body' }, el('pre', { text: part.text })));
    }
    return renderTool(part.tool);
}

/** Paragraphs, fenced code blocks and inline code; everything else stays literal text. */
function renderText(text: string): HTMLElement {
    const node = el('div', { class: 'text' });
    const segments = text.split(/```/);
    segments.forEach((segment, index) => {
        if (index % 2 === 1) {
            const newline = segment.indexOf('\n');
            const code = newline === -1 ? segment : segment.slice(newline + 1);
            node.append(el('pre', { text: code.replace(/\n$/, '') }));
            return;
        }
        for (const paragraph of segment.split(/\n{2,}/)) {
            if (!paragraph.trim()) continue;
            const p = el('p');
            paragraph.split(/(`[^`\n]+`)/).forEach(chunk => {
                if (chunk.startsWith('`') && chunk.endsWith('`') && chunk.length > 2) p.append(el('code', { text: chunk.slice(1, -1) }));
                else if (chunk) p.append(chunk);
            });
            node.append(p);
        }
    });
    return node;
}

function toolHint(tool: ToolCall): string {
    const input = tool.input;
    if (typeof input === 'string') return input.slice(0, 120);
    if (input && typeof input === 'object') {
        const record = input as Record<string, unknown>;
        for (const key of ['path', 'filePath', 'command', 'pattern', 'query', 'url', 'description']) {
            const value = record[key];
            if (typeof value === 'string') return value.slice(0, 120);
        }
    }
    return '';
}

function renderTool(tool: ToolCall): HTMLElement {
    const body = el('div', { class: 'body' });
    if (tool.input !== undefined) body.append(el('div', { text: 'Input' }), el('pre', { text: typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2) }));
    if (tool.output) body.append(el('div', { text: 'Output' }), el('pre', { text: tool.output.length > 4000 ? `${tool.output.slice(0, 4000)}\n… (${tool.output.length - 4000} more characters)` : tool.output }));
    if (tool.error) body.append(el('div', { class: 'error', text: tool.error }));
    for (const file of tool.files ?? []) body.append(renderFileRow(file));
    return el('details', { class: 'tool', open: tool.status === 'error' },
        el('summary', {},
            el('span', { class: 'tool-status', 'data-status': tool.status }),
            el('span', { class: 'name', text: tool.name }),
            el('span', { class: 'hint', text: toolHint(tool) }),
        ),
        body,
    );
}

function renderFileRow(file: FileDiff): HTMLElement {
    return el('div', { class: 'file-row' },
        el('span', { class: 'path', text: file.file }),
        el('span', { class: 'add', text: `+${file.additions}` }),
        el('span', { class: 'del', text: `−${file.deletions}` }),
        el('button', { class: 'link', text: 'Open diff', onclick: () => post({ type: 'showDiff', file: file.file, patch: file.patch }) }),
        el('button', { class: 'link', text: 'Open file', onclick: () => post({ type: 'openFile', path: file.file }) }),
    );
}

function renderPermission(request: PermissionRequest): HTMLElement {
    const reply = (decision: 'once' | 'always' | 'reject') => () => post({ type: 'permission', sessionId: request.sessionId, requestId: request.id, decision });
    const card = el('div', { class: 'card' },
        el('div', { class: 'title', text: `Permission: ${request.action}` }),
        request.message ? el('div', { text: request.message }) : null,
        el('div', { class: 'resources', text: request.resources.join('\n') }),
    );
    for (const file of request.files ?? []) card.append(renderFileRow(file), el('pre', { text: file.patch }));
    card.append(el('div', { class: 'actions' },
        el('button', { class: 'primary', text: 'Allow once', onclick: reply('once') }),
        el('button', { text: request.save?.length ? 'Always allow' : 'Allow for session', onclick: reply('always') }),
        el('button', { class: 'danger', text: 'Reject', onclick: reply('reject') }),
    ));
    return card;
}

function renderQuestion(question: Question): HTMLElement {
    const readers: Array<() => [string, QuestionAnswer[string]] | undefined> = [];
    const card = el('div', { class: 'card' }, el('div', { class: 'title', text: question.title }));
    for (const field of question.fields) {
        const wrapper = el('div', { class: 'field' }, el('label', { text: field.title ?? field.key }), field.description ? el('div', { class: 'desc', text: field.description }) : null);
        if (field.type === 'external') { wrapper.append(el('div', { class: 'desc', text: 'Answer this in the OpenCode web UI.' })); card.append(wrapper); continue; }
        if (field.type === 'boolean') {
            const input = el('input', { type: 'checkbox' });
            if (field.defaultValue === true) input.checked = true;
            wrapper.append(el('div', { class: 'options' }, el('label', {}, input, 'Yes')));
            readers.push(() => [field.key, input.checked]);
        } else if (field.type === 'multiselect' || (field.options && field.options.length)) {
            const multi = field.type === 'multiselect';
            const name = `q-${question.id}-${field.key}`;
            const inputs = (field.options ?? []).map(option => {
                const input = el('input', { type: multi ? 'checkbox' : 'radio', name, value: option.value });
                return { input, option };
            });
            const custom = field.custom ? el('input', { type: 'text', placeholder: 'Or type your own…' }) : undefined;
            wrapper.append(el('div', { class: 'options' },
                ...inputs.map(({ input, option }) => el('label', { title: option.description ?? '' }, input, option.label)),
                custom ?? null,
            ));
            readers.push(() => {
                const picked = inputs.filter(({ input }) => input.checked).map(({ option }) => option.value);
                if (custom?.value.trim()) picked.push(custom.value.trim());
                if (multi) return [field.key, picked];
                return picked[0] !== undefined ? [field.key, picked[0]] : undefined;
            });
        } else {
            const input = el('input', { type: field.type === 'string' ? 'text' : 'number' });
            if (field.defaultValue !== undefined) input.value = String(field.defaultValue);
            wrapper.append(input);
            readers.push(() => input.value === '' ? undefined : [field.key, field.type === 'string' ? input.value : Number(input.value)]);
        }
        card.append(wrapper);
    }
    card.append(el('div', { class: 'actions' }, el('button', { class: 'primary', text: 'Answer', onclick: () => {
        const answer: QuestionAnswer = {};
        for (const read of readers) { const pair = read(); if (pair) answer[pair[0]] = pair[1]; }
        post({ type: 'question', sessionId: question.sessionId, questionId: question.id, answer });
    } })));
    return card;
}

function renderToolbar(): void {
    const agents = state.agents.filter(agent => !agent.hidden && agent.mode !== 'subagent');
    agentSelect.replaceChildren(...agents.map(agent => el('option', { value: agent.id, text: agent.name, title: agent.description ?? '' })));
    if (state.selectedAgent) agentSelect.value = state.selectedAgent;
    const groups = groupModels(state.models, state.providers);
    modelSelect.replaceChildren(...(groups.length ? groups.map(group => {
        const optgroup = el('optgroup', { label: group.name });
        optgroup.append(...group.models.map(model => el('option', { value: modelKey(model), text: model.name })));
        return optgroup;
    }) : [el('option', { value: '', text: 'No models configured' })]));
    const selectedKey = modelKey(state.selectedModel);
    if (selectedKey && state.models.some(model => modelKey(model) === selectedKey)) modelSelect.value = selectedKey;
    const current = state.models.find(model => modelKey(model) === modelSelect.value);
    const variants = current?.variants ?? [];
    variantSelect.replaceChildren(el('option', { value: '', text: 'default' }), ...variants.map(variant => el('option', { value: variant, text: variant })));
    variantSelect.value = state.selectedModel?.variant && variants.includes(state.selectedModel.variant) ? state.selectedModel.variant : '';
    variantSelect.disabled = variants.length === 0;
    sendButton.textContent = state.busy ? 'Stop' : 'Send';
    sendButton.classList.toggle('danger', state.busy);
    sendButton.classList.toggle('primary', !state.busy);
    const ready = state.server.status === 'ready';
    sendButton.disabled = !ready;
    textarea.disabled = !ready;
    agentSelect.disabled = !ready || !state.currentSessionId;
    modelSelect.disabled = !ready || !state.currentSessionId;
}

function renderUsage(): void {
    const last = lastUsage(state);
    const session = state.sessions.find(item => item.id === state.currentSessionId);
    const items: string[] = [];
    if (last) items.push(`last turn: in ${last.tokens.input} · out ${last.tokens.output} · reasoning ${last.tokens.reasoning} · cache read ${last.tokens.cacheRead} · cache write ${last.tokens.cacheWrite}`);
    if (session) items.push(`session: ${session.tokens.input + session.tokens.output} tokens · $${session.cost.toFixed(4)}`);
    usage.replaceChildren(...items.map(item => el('span', { text: item })));
}

// ---- host messages ----------------------------------------------------------
window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'fileResults') {
        if (message.requestId === suggestRequest && suggestToken) openSuggest(message.files);
        return;
    }
    if (message.type === 'mention') { addMention(message.mention); textarea.focus(); return; }
    if (message.type === 'messages' && message.sessionId !== state.currentSessionId) stickToBottom = true;
    state = reduce(state, message);
    scheduleRender();
});

render();
post({ type: 'ready' });
