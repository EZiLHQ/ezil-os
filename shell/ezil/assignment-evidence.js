import { validateInferenceTrace } from '../../app/src/server/ai-traces/contract.js';
import { assessmentChatContent } from '../../app/src/server/assignment-evidence/chat-content.js';
import { assessmentTerminalCommands } from '../../app/src/server/assignment-evidence/terminal-commands.js';

const endpoint = '/api/shell/assignment-evidence';
const consentVersion = 'assignment-evidence-v2';
const maxBatch = 20;
const maxBatchBytes = 128 * 1024;
const maxPending = 120;
const transitions = new Set(['app.opened', 'app.focused', 'app.minimized', 'app.restored', 'app.closed']);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const modelAlias = /^[a-z][a-z0-9_.:-]{0,127}$/i;
const chatId = /^request_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sensitiveAlias = /secret|token|passw|bearer|credential|cookie|session|api.?key|[a-z0-9]{32,}/i;
const canonicalRepository = /^https:\/\/github\.ezil\.work\/[a-z0-9-]+\/[a-z0-9._-]+\.git$/;
const subscribers = new Set();
let current = null;
let pauseDrain = Promise.resolve();

function matches(left, right) {
    return left?.computerId === right?.computerId && left?.repositoryUrl === right?.repositoryUrl;
}

export function isAssignmentEvidenceActive(scope) {
    return Boolean(current?.active && scope && matches(current.scope, scope));
}

export function subscribeAssignmentEvidence(scope, callback) {
    let last;
    const update = () => {
        const active = isAssignmentEvidenceActive(scope);
        if ( active === last ) return;
        last = active;
        try { callback(active, active ? current.permissions() : {}); } catch { /* Evidence must not interrupt the shell. */ }
    };
    subscribers.add(update);
    update();
    return () => subscribers.delete(update);
}

function notify() {
    for (const update of subscribers) update();
}

function safePath(value) {
    return typeof value === 'string' && value.length <= 240 && !value.includes('..')
        && value.split('/').every(part => /^[A-Za-z0-9._-][A-Za-z0-9 ._-]{0,95}$/.exec(part)?.[0] === part
            && part !== '.' && !/^(?:\.(?:git(?:[.-]|$)|env)|id_(?:rsa|dsa|ecdsa|ed25519))/i.test(part)
            && !/credentials|secrets?|\.(?:pem|p12|pfx|key|crt|cer|der|kdbx)/i.test(part));
}

function evidenceDetail(kind, detail) {
    if ( !detail || typeof detail !== 'object' ) return null;
    if ( transitions.has(kind) && detail.app === 'code' ) return { app: 'code' };
    if ( kind === 'activity.resumed' ) return {};
    if ( kind === 'activity.visibility' && ['foreground', 'background'].includes(detail.state) ) {
        return { state: detail.state };
    }
    if ( kind === 'code.file_opened' && safePath(detail.path) ) return { path: detail.path };
    if ( kind === 'code.file_reviewed' && safePath(detail.path) && Number.isInteger(detail.startLine)
        && Number.isInteger(detail.endLine) && detail.startLine > 0 && detail.endLine >= detail.startLine
        && detail.endLine <= 1_000_000 ) {
        return { path: detail.path, startLine: detail.startLine, endLine: detail.endLine };
    }
    if ( kind === 'model.completed' ) {
        const { requestId, model, outcome } = detail;
        if ( typeof requestId === 'string' && uuid.exec(requestId)?.[0] === requestId && requestId === requestId.toLowerCase()
            && typeof model === 'string' && modelAlias.exec(model)?.[0] === model && !sensitiveAlias.test(model)
            && ['completed', 'failed', 'cancelled'].includes(outcome) ) {
            if ( detail.trace === undefined ) return { requestId, model, outcome };
            const trace = validateInferenceTrace(detail.trace);
            if ( trace?.requestId === requestId && trace.modelAlias === model && trace.outcome === outcome ) {
                return { requestId, model, outcome, trace };
            }
        }
    }
    if ( /^chat\./.test(kind) && typeof detail.chatRequestId === 'string' && chatId.exec(detail.chatRequestId)?.[0] === detail.chatRequestId ) {
        const chatRequestId = detail.chatRequestId;
        if ( kind === 'chat.request_retried' && typeof detail.retryChatRequestId === 'string'
            && chatId.exec(detail.retryChatRequestId)?.[0] === detail.retryChatRequestId && detail.retryChatRequestId !== chatRequestId ) {
            return { chatRequestId, retryChatRequestId: detail.retryChatRequestId };
        }
        if ( kind === 'chat.gateway_linked' && typeof detail.requestId === 'string' && uuid.exec(detail.requestId)?.[0] === detail.requestId ) {
            return { chatRequestId, requestId: detail.requestId.toLowerCase() };
        }
        if ( ['chat.prompt_submitted', 'chat.response_completed'].includes(kind) ) {
            if ( detail.contentStatus === 'captured' ) return { chatRequestId, ...assessmentChatContent(detail.text) };
            if ( ['unavailable', 'over_limit', 'withheld'].includes(detail.contentStatus) ) return { chatRequestId, contentStatus: detail.contentStatus };
        }
    }
    if ( kind === 'terminal.command_finished' && typeof detail.executionId === 'string' && uuid.exec(detail.executionId)?.[0] === detail.executionId ) {
        return {
            executionId: detail.executionId.toLowerCase(),
            command: assessmentTerminalCommands.includes(detail.command) ? detail.command : null,
            exitCode: Number.isInteger(detail.exitCode) && detail.exitCode >= -2147483648 && detail.exitCode <= 2147483647 ? detail.exitCode : null,
            durationMs: Number.isInteger(detail.durationMs) && detail.durationMs >= 0 && detail.durationMs <= 21600000 ? detail.durationMs : null,
        };
    }
    return null;
}

export function recordAssignmentEvent(kind, detail, scope) {
    const controller = current;
    if ( !controller?.active || typeof kind !== 'string' || (scope && !matches(controller.scope, scope)) ) return false;
    if ( !scope && /^(?:code|model|chat|terminal)\./.test(kind) ) return false;
    const permissions = controller.permissions();
    if ( kind.startsWith('chat.') && !permissions.chat || kind.startsWith('terminal.') && !permissions.terminal ) return false;
    const allowed = evidenceDetail(kind, detail);
    return Boolean(allowed && controller.record(kind, allowed));
}

/** Record semantic actions from the exact Code window that owns consent. */
export function recordAssignmentWindow(kind, element) {
    if ( !current?.active || !element || element !== current.owner ) return;
    if ( element.getAttribute('data-ezil-computer-id') !== current.scope.computerId
        || element.getAttribute('data-app') !== 'code' ) return;
    recordAssignmentEvent(kind, { app: 'code' }, current.scope);
}

async function requestJson(options) {
    const response = await fetch(endpoint, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(8_000),
        ...(options ? {
            method: 'POST',
            body: JSON.stringify(options),
            headers: { 'content-type': 'application/json' },
        } : {}),
    });
    if ( !response.ok ) throw Object.assign(new Error('assignment evidence unavailable'), { status: response.status });
    return response.json();
}

function validAttempt(value) {
    return Boolean(value && typeof value.id === 'string' && uuid.test(value.id)
        && ['active', 'ended', 'expired'].includes(value.state)
        && Number.isFinite(Date.parse(value.startedAt)) && Number.isFinite(Date.parse(value.expiresAt)));
}

/** Bind the visible control to an exact repository/computer verified by the server. */
export function mountAssignmentEvidence(
    { container, computerId, repositoryUrl, owner = null },
    { request = requestJson, now = () => new Date(), newId = () => crypto.randomUUID() } = {},
) {
    const scope = { computerId, repositoryUrl };
    if ( !container || typeof computerId !== 'string' || !computerId
        || typeof repositoryUrl !== 'string' || !canonicalRepository.test(repositoryUrl) ) return null;
    if ( current && current.owner === owner && matches(current.scope, scope) ) return current;
    current?.dispose();

    const document = container.ownerDocument;
    const wrapper = document.createElement('section');
    wrapper.className = 'ezil-assignment-evidence';
    wrapper.setAttribute('aria-label', 'Assignment evidence');
    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    const start = document.createElement('button');
    start.type = 'button';
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = 'Stop assignment evidence';
    stop.hidden = true;
    wrapper.append(status, start, stop);

    let attempt = null;
    let configuredChat = false;
    let disposed = false;
    let busy = false;
    let flushTimer = null;
    let sending = null;
    let ending = null;
    let visibility;
    let expiryTimer = null;
    let queue = [];

    const controller = {
        owner, scope, active: false,
        permissions() {
            const terminal = attempt?.consentVersion === consentVersion;
            return { terminal, chat: terminal && configuredChat && attempt?.captureChat === true };
        },
        record(kind, detail) {
            if ( queue.length >= maxPending ) {
                status.textContent = 'Assignment evidence active. Waiting to send buffered events.';
                return false;
            }
            queue.push({ id: newId(), kind, occurredAt: now().toISOString(), detail });
            scheduleFlush();
            return true;
        },
        dispose() {
            if ( disposed ) return;
            disposed = true;
            wrapper.remove();
            setActive(false);
            if ( current === controller ) current = null;
            // Leaving Code pauses this producer. A later Code window can resume
            // the same attempt. Only the participant's Stop closes it.
            if ( attempt && queue.length ) pauseDrain = pauseDrain.then(drain).catch(() => {});
        },
    };
    current = controller;

    function render(message) {
        status.textContent = message;
        start.textContent = attempt ? 'Resume assignment evidence' : 'Start assignment evidence';
        start.hidden = controller.active || Boolean(ending) || (attempt !== null && busy);
        start.disabled = busy;
        stop.hidden = attempt === null;
        stop.disabled = busy;
    }

    function setActive(next) {
        if ( controller.active === next ) return;
        controller.active = next;
        if ( !next ) {
            document.removeEventListener('visibilitychange', onVisibility);
            clearTimeout(flushTimer);
            flushTimer = null;
            clearTimeout(expiryTimer);
            expiryTimer = null;
        }
        notify();
    }

    function endLocal(message) {
        setActive(false);
        attempt = null;
        queue = [];
        render(message);
    }

    function availableAttempt(value) {
        return validAttempt(value) && value.state === 'active' && Date.parse(value.expiresAt) > now().getTime();
    }

    function onVisibility() {
        const state = document.visibilityState === 'visible' ? 'foreground' : 'background';
        if ( state === visibility ) return;
        visibility = state;
        recordAssignmentEvent('activity.visibility', { state }, scope);
    }

    function scheduleFlush() {
        if ( flushTimer !== null ) return;
        flushTimer = setTimeout(async () => {
            flushTimer = null;
            const sent = await flush();
            if ( !sent && controller.active ) status.textContent = 'Assignment evidence active. Retrying delivery.';
            if ( queue.length && controller.active ) scheduleFlush();
        }, 1_000);
    }

    async function flush() {
        if ( sending ) return sending;
        if ( !attempt || queue.length === 0 ) return true;
        const events = [];
        let size = 0;
        const encoder = new TextEncoder();
        for ( const event of queue.slice(0, maxBatch) ) {
            size += encoder.encode(JSON.stringify(event)).length + 1;
            if ( size > maxBatchBytes && events.length ) break;
            events.push(event);
        }
        sending = (async () => {
            try {
                const response = await request({ action: 'append', attemptId: attempt.id, events });
                if ( !Array.isArray(response?.accepted) ) return false;
                const accepted = new Set(response.accepted);
                queue = queue.filter(event => !accepted.has(event.id));
                return events.every(event => accepted.has(event.id));
            } catch ( error ) {
                if ( [401, 403, 404, 409, 410].includes(error?.status) ) {
                    endLocal('Assignment evidence is no longer active.');
                }
                return false;
            }
        })();
        try { return await sending; } finally { sending = null; }
    }

    async function drain() {
        while ( queue.length ) if ( !await flush() ) throw new Error('pending assignment evidence');
    }

    async function startAttempt() {
        if ( busy || disposed || controller.active ) return;
        busy = true;
        render('Starting assignment evidence…');
        try {
            await pauseDrain;
            if ( disposed ) return;
            const resuming = Boolean(attempt);
            if ( attempt ) {
                const refreshed = await request();
                if ( refreshed?.enabled !== true || !matches(refreshed.assignment, scope)
                    || !availableAttempt(refreshed.attempt) || refreshed.attempt.id !== attempt.id ) {
                    attempt = null;
                    throw new Error('assignment attempt changed');
                }
                configuredChat = refreshed.assignment.captureChat === true;
                attempt = refreshed.attempt;
            } else {
                const response = await request({ action: 'start', computerId, consentVersion, ...(configuredChat ? { captureChat: true } : {}) });
                if ( !availableAttempt(response?.attempt) ) throw new Error('invalid assignment attempt');
                attempt = response.attempt;
            }
            if ( disposed ) return;
            setActive(true);
            if ( resuming ) recordAssignmentEvent('activity.resumed', {}, scope);
            expiryTimer = setTimeout(() => endLocal('Assignment evidence expired.'),
                Date.parse(attempt.expiresAt) - now().getTime());
            visibility = undefined;
            document.addEventListener('visibilitychange', onVisibility);
            onVisibility();
            render('Assignment evidence active.');
        } catch {
            if ( !disposed ) render('Assignment evidence could not start.');
        } finally {
            busy = false;
            if ( !disposed ) render(status.textContent);
        }
    }

    function stopAttempt() {
        if ( !attempt || ending ) return ending;
        setActive(false);
        busy = true;
        render('Stopping assignment evidence…');
        ending = (async () => {
            try {
                await drain();
                if ( !attempt ) return;
                const response = await request({ action: 'end', attemptId: attempt.id });
                if ( response?.attempt?.id !== attempt.id || !['ended', 'expired'].includes(response.attempt.state) ) {
                    throw new Error('invalid end receipt');
                }
                attempt = null;
                render('Assignment evidence stopped.');
            } catch {
                if ( attempt ) render('Recording paused. Select Stop to finish sending and close the attempt.');
            } finally {
                busy = false;
                ending = null;
                if ( !disposed ) render(status.textContent);
            }
        })();
        return ending;
    }

    start.addEventListener('click', () => { void startAttempt(); });
    stop.addEventListener('click', () => { void stopAttempt(); });
    void (async () => {
        try {
            const response = await request();
            if ( disposed || current !== controller ) return;
            if ( response?.enabled !== true || !matches(response.assignment, scope)
                || (response.attempt !== null && !validAttempt(response.attempt)) ) {
                controller.dispose();
                return;
            }
            configuredChat = response.assignment.captureChat === true;
            attempt = availableAttempt(response.attempt) ? response.attempt : null;
            const notice = configuredChat
                ? 'Record submitted Chat prompts, completed replies, Code activity, model request traces and safe terminal commands.'
                : 'Record Code activity, model request traces and safe terminal commands.';
            render(attempt ? 'Assignment evidence paused. Resume to continue. ' + notice : notice);
            container.append(wrapper);
        } catch { controller.dispose(); }
    })();
    return controller;
}

export function updateAssignmentEvidenceWindow(element, context) {
    if ( globalThis.window?.location?.origin !== 'https://os-staging.ezil.work' || !element ) return;
    const computerId = context.computer?.id ?? context.payload?.computer?.id;
    const repositoryUrl = context.project?.repoUrl;
    if ( current?.owner && (current.owner !== element
        || (context.project && !matches(current.scope, { computerId, repositoryUrl }))) ) current.dispose();
    if ( repositoryUrl ) {
        mountAssignmentEvidence({ container: document.body, computerId, repositoryUrl, owner: element });
    }
}

export function closeAssignmentEvidenceWindow(element) {
    if ( current?.owner === element ) current.dispose();
}
