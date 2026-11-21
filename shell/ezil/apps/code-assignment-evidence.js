// This adapter only observes the authenticated Code frame the server mounted
// for the configured assignment. The collector owns consent and persistence.
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const REPOSITORY = /^https:\/\/github\.ezil\.work\/[a-z0-9][a-z0-9-]{0,63}\/([a-z0-9][a-z0-9._-]{0,99})\.git$/;
const FOLDER = /^\/workspace\/projects\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const STAGING_SHELL = 'https://os-staging.ezil.work';
const STAGING_CODE_HOST = /^[a-z0-9-]+-(?:code|aws)\.ezil\.work$/;

function exact (value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function matches (value, pattern) {
    return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}

function safePath (path) {
    return typeof path === 'string' && path.length <= 240 && !path.includes('..')
        && path.split('/').every(part => matches(part, /^[A-Za-z0-9._-][A-Za-z0-9 ._-]{0,95}$/)
            && part !== '.' && !/^\.(?:git$|env|(?:aws|ssh|gnupg|npmrc|netrc|pypirc)$)|^\.?(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials|secrets)(?:\.|$)|\.(?:pem|p12|pfx|key|crt|cer|der|kdbx)$/i.test(part));
}

function eventDetail (kind, detail) {
    if (kind === 'code.file_opened' && exact(detail, ['path']) && safePath(detail.path)) return { path: detail.path };
    if (kind === 'code.file_reviewed' && exact(detail, ['path', 'startLine', 'endLine']) && safePath(detail.path)) {
        const { path, startLine, endLine } = detail;
        if (Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine) && startLine > 0
            && endLine >= startLine && endLine <= 1_000_000) return { path, startLine, endLine };
    }
    if (kind === 'model.completed' && exact(detail, ['requestId', 'model', 'outcome'])) {
        const { requestId, model, outcome } = detail;
        if (matches(requestId, UUID) && matches(model, /^(?:unknown|[a-z][a-z0-9_.:-]{0,127})$/i)
            && !/secret|token|passw|bearer|credential|cookie|session|api.?key|[a-z0-9]{32,}/i.test(model)
            && ['completed', 'failed', 'cancelled'].includes(outcome)) return { requestId, model, outcome };
    }
    return null;
}

function token (host) {
    const bytes = host.crypto.getRandomValues(new Uint8Array(16));
    return host.btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function attachAssignmentCodeEvidence ({ iframe, frameUrl, repositoryFolder, repositoryName, scope, subscribe, record }) {
    const stop = () => {};
    const host = iframe?.ownerDocument?.defaultView;
    if (host?.location.origin !== STAGING_SHELL) return stop;
    const repo = REPOSITORY.exec(scope?.repositoryUrl ?? '');
    if (!repo || repo[0] !== scope.repositoryUrl || repo[1].includes('..') || !scope.computerId
        || repositoryName !== repo[0].slice('https://github.ezil.work/'.length, -'.git'.length)
        || !matches(repositoryFolder, FOLDER)) return stop;
    let url;
    try { url = new URL(frameUrl); } catch { return stop; }
    const mint = url.searchParams.get('ezil_mint');
    if (url.protocol !== 'https:' || !matches(url.hostname, STAGING_CODE_HOST) || url.username || url.password || url.port
        || url.searchParams.has('workspace') || url.searchParams.getAll('folder').length !== 1
        || url.searchParams.get('folder') !== repositoryFolder || url.searchParams.getAll('ezil_mint').length !== 1
        || !matches(mint, TOKEN)) return stop;
    const root = repositoryFolder + '/' + repo[1];
    let nonce = null;
    let active = false;
    const live = () => iframe.isConnected && iframe.src === frameUrl;
    const post = (message) => {
        try { iframe.contentWindow?.postMessage(message, url.origin); } catch { /* Frame navigated or closed. */ }
    };
    const disarm = () => {
        if (nonce) post({ type: 'ezil.code.assignment.stop', v: 1, nonce });
        nonce = null;
    };
    const arm = () => {
        disarm();
        if (!active || !live()) return;
        nonce = token(host);
        post({ type: 'ezil.code.assignment.start', v: 1, nonce, mint, root });
    };
    const message = (event) => {
        if (!active || !nonce || !live() || !event.source || event.source !== iframe.contentWindow || event.origin !== url.origin) return;
        const data = event.data;
        if (!exact(data, ['type', 'v', 'nonce', 'kind', 'detail']) || data.type !== 'ezil.code.assignment.event'
            || data.v !== 1 || data.nonce !== nonce) return;
        if (data.kind !== 'model.completed' && (host.document.visibilityState !== 'visible' || !iframe.getClientRects().length)) return;
        const detail = eventDetail(data.kind, data.detail);
        if (detail) record(data.kind, detail, scope);
    };
    iframe.addEventListener('load', arm);
    host.addEventListener('message', message);
    const unsubscribe = subscribe(scope, (value) => {
        if (active === value) return;
        active = value === true;
        arm();
    });
    return () => {
        disarm();
        unsubscribe();
        host.removeEventListener('message', message);
        iframe.removeEventListener('load', arm);
    };
}
