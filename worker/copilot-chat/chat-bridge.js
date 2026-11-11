/* EZiL Chat bridge, workbench side, protocol 3 (PATCHES.md "Chat bridge").
 * Injected by patch-copilot-chat.sh [chat-bridge] into ChatViewPane, which registers it as the
 * internal command "_ezil.chatBridge.v1" only when the setting ezil.chatBridge.enabled is true.
 * Lets a remote owner (the EZiL extension, fenced by an OS-issued epoch) put an instruction into
 * the SAME local EZiL Chat session a person has open, and read that session back, using the
 * workbench's own IChatService. A fixed set of operations, plain JSON in and out, no command names
 * from the caller, never "whichever chat is focused", and nothing written to session files.
 * Delivery is at most once: a send whose outcome is unknown is reported "uncertain", never retried.
 * Protocol 2 adds three controls, under the same fence, command ids and deadlines: the models the session's
 * own picker offers (`models`), a genuinely new local chat opened in an editor tab (`create`), and a model
 * change for one open, idle session (`setModel`), each read back from the runtime after the change.
 * Protocol 3 effort requires the pinned native session-isolation hook and Agent mode. Mode is never set here.
 * This window's memory alone cannot guarantee that across eviction or restart; the end-to-end guarantee is
 * OS's (each operation is handed out again only after a definite "not sent" for its previous attempt).
 * The owner epoch only ORDERS callers inside this window (any extension here could call the command);
 * authority is the OS lease, and the transport must authenticate its own client before calling this.
 * This file is one function expression; tests evaluate it with fake services (chat-bridge.test.cjs). */
(function ezilChatBridge(deps) {
    'use strict';
    const PROTOCOL = 3;
    // editorService group ids (code-server 4.141.0): open a created chat as a tab in the active group, so the
    // chat the person has in the panel is never replaced.
    const ACTIVE_GROUP = -1;
    const MAX_TEXT = 32000;
    const MAX_COMMANDS = 256;
    const MAX_READ = 20;
    const MAX_RESPONSE_CHARS = 16000;
    const CREATED_TIMEOUT_MS = deps.createdTimeoutMs || 10000;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const OWNER = /^[A-Za-z0-9_.:-]{1,128}$/;
    const MODEL_ID = /^[A-Za-z0-9_.:\/@+-]{1,256}$/;
    const NO_CANCEL = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const chat = deps.chatService;
    const widgets = deps.chatWidgetService;
    const now = deps.now || (() => Date.now());
    const log = deps.log || (() => {});

    let owner = null;
    let disposed = false;
    const commands = new Map();
    const inflight = new Map();
    const held = new Set();
    const locks = new Map();
    const watchers = new Map();

    const fail = (error, extra) => Object.assign({ ok: false, error }, extra || {});
    const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

    function fenced(req) {
        if (disposed) return fail('disconnected');
        if (!owner) return fail('no_owner');
        if (req.ownerId !== owner.id || req.epoch !== owner.epoch) return fail('stale_owner', { epoch: owner.epoch });
        return null;
    }

    /** Local panel sessions only (that is all these two service calls return), keyed by URI string. */
    async function localSessions() {
        const lists = await Promise.all([chat.getLiveSessionItems(), chat.getHistorySessionItems()]);
        const found = new Map();
        for (const item of [].concat(lists[0] || [], lists[1] || [])) {
            const resource = item && item.sessionResource;
            if (!resource || found.has(resource.toString())) continue;
            found.set(resource.toString(), { resource, title: typeof item.title === 'string' ? item.title : '' });
        }
        // A chat this bridge created and the runtime still holds, before its first request lists it.
        for (const record of commands.values()) {
            if (record.kind !== 'create' || !record.resource || found.has(record.key) || !chat.getSession(record.resource)) continue;
            found.set(record.key, { resource: record.resource, title: '' });
        }
        return found;
    }

    /** Serialize deliveries per session so two commands cannot race into one conversation. */
    function withLock(key, run) {
        const previous = locks.get(key) || Promise.resolve();
        const next = previous.then(run, run);
        const settled = next.then(() => {}, () => {});
        locks.set(key, settled);
        settled.then(() => { if (locks.get(key) === settled) locks.delete(key); });
        return next;
    }

    function remember(record) {
        commands.set(record.commandId, record);
        while (commands.size > MAX_COMMANDS) commands.delete(commands.keys().next().value);
    }

    /** Exactly the options the widget's own submit builds for this session (chat widget _acceptInput), without attachments. */
    function sendOptions(widget) {
        const input = widget.input;
        const modeKind = input && input.currentModeKind;
        return Object.assign({},
            widget.getSelectedModelRequestOptions ? widget.getSelectedModelRequestOptions() : {},
            { location: widget.location },
            widget.getModeRequestOptions ? widget.getModeRequestOptions() : {},
            {
                modeInfo: input && input.currentModeInfo,
                parserContext: {
                    selectedAgent: widget._lastSelectedAgent,
                    mode: modeKind,
                    attachmentCapabilities: (widget._lastSelectedAgent && widget._lastSelectedAgent.capabilities) || widget.attachmentCapabilities,
                },
                instructionContext: Object.assign({ modeKind }, widget._getInstructionRouting ? widget._getInstructionRouting() : {}),
            });
    }

    function busyState(model) {
        const get = (o) => !!(o && typeof o.get === 'function' && o.get());
        return {
            inProgress: get(model.requestInProgress),
            needsInput: get(model.requestNeedsInput),
            blocked: get(model.isInputBlocked) || get(model.isReadOnly),
            pending: typeof model.getPendingRequests === 'function' ? model.getPendingRequests().length : 0,
        };
    }

    /**
     * What happened to an accepted command, read from the live response model. responseCreatedPromise
     * resolves with that model once the request is added (code-server 4.141.0); a request that never
     * adds one (a silent slash command) finishes without it and is reported finished_unverified.
     */
    function commandView(record, extra) {
        if (record.kind === 'create' || record.kind === 'configure') return controlView(record, extra);
        const response = record.response;
        let status = record.status;
        if (status === 'accepted') {
            const error = response && response.result && response.result.errorDetails;
            status = response && response.isCanceled ? 'cancelled'
                // The response model's own failed state (4.141.0 ChatResponseModel.state: an errorDetails other than "canceled").
                : response && response.isComplete && error && error.code !== 'canceled' ? 'failed'
                : response && response.isComplete ? 'completed'
                : !response && record.settled ? 'finished_unverified'
                : record.cancelRequested ? 'cancel_requested' : 'in_progress';
        }
        return Object.assign({
            ok: true, status, commandId: record.commandId, sessionResource: record.key,
            requestId: record.requestId, mode: record.mode, selectedModelId: record.selectedModelId, selectedEffort: record.selectedEffort ?? null, acceptedAt: record.acceptedAt,
        }, extra || {});
    }

    /**
     * The open widget of a session. A chat this bridge created is shown again (its tab, without taking focus) when
     * another chat editor has replaced it in the group: 4.141.0 keeps one chat editor pane per group, so an
     * inactive tab has no widget. `reveal` is the caller's statement that OS created this chat (it survives a
     * window reload, which this window's memory does not); a chat the person has is never opened for them.
     */
    async function widgetFor(session, reveal) {
        const widget = widgets.getWidgetBySessionResource(session.resource);
        if (widget) return widget;
        const made = [...commands.values()].some((r) => r.kind === 'create' && r.status === 'created' && r.key === session.resource.toString());
        if (!made && reveal !== true) return undefined;
        try {
            await widgets.openSession(session.resource, ACTIVE_GROUP, { preserveFocus: true, pinned: true });
        } catch (error) {
            return undefined;
        }
        return widgets.getWidgetBySessionResource(session.resource);
    }

    async function deliver(req, session, key, deadline) {
        // Session lookup may have yielded to a newer claim: do not even reveal/load for the old owner.
        const denied = fenced(req);
        if (denied) return denied;
        const widget = await widgetFor(session, req.reveal);
        const afterWidget = fenced(req);
        if (afterWidget) return afterWidget;
        // Only a session open here (or one this bridge created, shown again): the request then runs with that
        // pane's own mode, model and tools, and any tool confirmation appears in front of the person.
        if (!widget) return { ok: true, status: 'not_open' };
        if (widget._lockedAgent) return { ok: true, status: 'unsupported_session' };
        const ref = await chat.acquireOrLoadSession(session.resource, 'panel', NO_CANCEL, 'EZiL#chatBridge');
        if (!ref || !ref.object) return { ok: true, status: 'unknown_session' };
        const busy = busyState(ref.object);
        if (busy.inProgress || busy.needsInput || busy.blocked || busy.pending > 0) {
            ref.dispose();
            return { ok: true, status: 'busy', needsInput: busy.needsInput, blocked: busy.blocked };
        }
        // Last checks before the send, after every await above: still the current owner, still in time.
        const stale = fenced(req);
        if (stale) { ref.dispose(); return stale; }
        if (now() > deadline) { ref.dispose(); return { ok: true, status: 'expired' }; }
        const options = sendOptions(widget);
        if (options.userSelectedModelConfiguration?.reasoningEffort !== undefined
            && widget.input?.currentModeKind !== 'agent') {
            ref.dispose();
            return { ok: true, status: 'rejected', reason: 'effort_mode_unsupported' };
        }
        const record = {
            commandId: req.commandId, key, resource: session.resource, text: req.text, status: 'uncertain',
            requestId: null, response: null, mode: (widget.input && widget.input.currentModeKind) || null,
            selectedModelId: options.userSelectedModelId || null, selectedEffort: options.userSelectedModelConfiguration?.reasoningEffort ?? null, acceptedAt: now(), cancelRequested: false, settled: false,
        };
        let result;
        try {
            result = await chat.sendRequest(session.resource, req.text, options);
        } catch (error) {
            // It may or may not have reached the model: never resend, report it as unknown.
            ref.dispose();
            remember(record);
            log('submit uncertain (send threw)');
            return commandView(record);
        }
        if (!result || result.kind === 'rejected') {
            ref.dispose();
            return { ok: true, status: 'rejected', reason: String((result && result.reason) || 'rejected') };
        }
        if (result.kind !== 'sent') {
            ref.dispose();
            remember(record);
            return commandView(record);
        }
        record.status = 'accepted';
        remember(record);
        held.add(ref);
        const release = () => { record.settled = true; if (held.delete(ref)) ref.dispose(); };
        Promise.resolve(result.data.responseCompletePromise).then(release, release);
        let timer;
        const created = await Promise.race([
            Promise.resolve(result.data.responseCreatedPromise).catch(() => undefined),
            new Promise((resolve) => { timer = setTimeout(resolve, CREATED_TIMEOUT_MS); }),
        ]);
        clearTimeout(timer);
        if (created) {
            record.response = created;
            record.requestId = typeof created.requestId === 'string' ? created.requestId : null;
        }
        log('submit accepted');
        return commandView(record);
    }

    /** A control's outcome: `created`/`applied` carry the model read back from the runtime, never the request's. */
    function controlView(record, extra) {
        return Object.assign({
            ok: true, status: record.status, commandId: record.commandId, kind: record.kind, sessionResource: record.key,
            model: record.model, effort: record.effort ?? null, requestCount: record.requestCount, reason: record.reason, observedAt: record.observedAt,
        }, extra || {});
    }

    /** The models a chat input's own picker offers, as it offers them. */
    function pickerModels(widget) {
        const input = widget && widget.input;
        const list = input && typeof input.getModels === 'function' ? input.getModels() : [];
        return (list || []).filter((m) => m && typeof m.identifier === 'string' && MODEL_ID.test(m.identifier) && m.metadata
            && m.metadata.isUserSelectable !== false).map((m) => ({
            id: m.identifier, label: String(m.metadata.name || m.identifier).slice(0, 128), vendor: String(m.metadata.vendor || ''),
            modelId: String(m.metadata.id || ''), configurable: !!m.metadata.configurationSchema, ...effortSchema(input, m),
        }));
    }

    const EFFORT = /^[A-Za-z0-9._-]{1,32}$/;
    function effortSchema(input, model) {
        const schema = model.metadata.configurationSchema?.properties?.reasoningEffort;
        const values = schema?.enum;
        const usable = input.currentModeKind === 'agent' && typeof input._ezilSessionEffortV2 === 'function' && typeof input.restoreModelConfiguration === 'function' && typeof input.getModelConfiguration === 'function'
            && typeof input._inputModel?.state?.get === 'function' && input._inputModelSessionResource?.toString() === input._currentSessionKey
            && typeof input.flushInputStateToModel === 'function' && typeof input.getCurrentInputState === 'function' && schema?.type === 'string' && Array.isArray(values) && values.length > 0 && values.length <= 16
            && values.every(v => typeof v === 'string' && EFFORT.test(v)) && new Set(values).size === values.length;
        return { efforts: usable ? [...values] : [], defaultEffort: usable && values.includes(schema.default) ? schema.default : null };
    }
    function currentEffort(widget) {
        const id = currentModel(widget);
        const value = id && widget?.input?.getModelConfiguration?.(id)?.reasoningEffort;
        return typeof value === 'string' && EFFORT.test(value) ? value : null;
    }
    function effortAllowed(widget, id, effort) {
        return effort === undefined || pickerModels(widget).some(m => m.id === id && m.efforts.includes(effort));
    }
    function selectEffort(widget, effort) {
        if (effort === undefined) return true;
        const id = currentModel(widget);
        if (!effortAllowed(widget, id, effort)) return false;
        const input = widget.input;
        if (!input._ezilSessionEffortV2(widget.viewModel?.sessionResource?.toString(), id, effort)) return false;
        // Both the live input and its persisted session input state must agree.
        return currentEffort(widget) === effort && input.getCurrentInputState?.().modelConfiguration?.reasoningEffort === effort
            && input._inputModelSessionResource?.toString() === widget.viewModel?.sessionResource?.toString()
            && input._inputModel?.state?.get()?.modelConfiguration?.reasoningEffort === effort;
    }

    function currentModel(widget) {
        const id = widget && widget.input && widget.input.currentLanguageModel;
        return typeof id === 'string' && id ? id : null;
    }

    /** Any chat widget of this window, for the picker list (the panel's when nothing else is focused). */
    function someWidget() {
        if (widgets.lastFocusedWidget) return widgets.lastFocusedWidget;
        const all = typeof widgets.getAllWidgets === 'function' ? widgets.getAllWidgets() : [];
        return all && all.length ? all[0] : undefined;
    }

    /** Select a model in one session's own input: for this session only, not stored as the window's default. */
    function selectModel(widget, id) {
        const input = widget.input;
        if (!input || typeof input.switchModelByIdentifier !== 'function') return false;
        input.switchModelByIdentifier(id, false, true);
        return currentModel(widget) === id;
    }

    function reserve(req, key, value, run) {
        const existing = commands.get(req.commandId);
        if (existing) {
            if (existing.kind !== value.kind || existing.key !== (value.key === undefined ? existing.key : value.key) || existing.request !== value.request) return fail('command_conflict');
            return commandView(existing, { duplicate: true });
        }
        const reserved = inflight.get(req.commandId);
        if (reserved) return reserved.kind === value.kind && reserved.request === value.request ? fail('command_in_flight') : fail('command_conflict');
        inflight.set(req.commandId, value);
        return withLock(key, run).finally(() => inflight.delete(req.commandId));
    }

    /**
     * A new, empty local chat (no request in it), opened as an editor tab without taking focus, with the model
     * selected in its own input when one is asked for. Once the runtime has started it, it is never started again
     * for the same command: a failure after that point is `uncertain`, not retried.
     */
    async function create(req) {
        if (!UUID.test(req.commandId) || !Number.isSafeInteger(req.deliverWithinMs) || req.deliverWithinMs < 0
            || (req.model !== undefined && (typeof req.model !== 'string' || !MODEL_ID.test(req.model)))
            || (req.effort !== undefined && (typeof req.effort !== 'string' || !EFFORT.test(req.effort)))) return fail('bad_request');
        const denied = fenced(req);
        if (denied) return denied;
        const deadline = now() + req.deliverWithinMs;
        const wanted = req.model === undefined ? null : req.model;
        const selection = JSON.stringify([wanted, req.effort ?? null]);
        return reserve(req, 'create', { kind: 'create', request: selection }, async () => {
            const stale = fenced(req);
            if (stale) return stale;
            if (now() > deadline) return { ok: true, status: 'expired' };
            if (req.effort !== undefined && someWidget()?.input?.currentModeKind !== 'agent') return { ok: true, status: 'rejected', reason: 'effort_mode_unsupported' };
            if (wanted && !pickerModels(someWidget()).some((m) => m.id === wanted)) return { ok: true, status: 'rejected', reason: 'model_not_offered' };
            if (!effortAllowed(someWidget(), wanted || currentModel(someWidget()), req.effort)) return { ok: true, status: 'rejected', reason: 'effort_unavailable' };
            const record = { commandId: req.commandId, kind: 'create', request: selection, key: null, resource: null, status: 'uncertain',
                model: null, requestCount: null, reason: 'create_outcome_unknown', observedAt: null };
            remember(record);
            let ref;
            try {
                ref = chat.startNewLocalSession('panel', { canUseTools: true, debugOwner: 'EZiL#chatBridge.create' });
            } catch (error) {
                log('create uncertain (start threw)');
                return controlView(record);
            }
            const model = ref && ref.object;
            if (!model || !model.sessionResource) { if (ref) ref.dispose(); return controlView(record); }
            record.resource = model.sessionResource;
            record.key = model.sessionResource.toString();
            let widget;
            try {
                widget = await widgets.openSession(model.sessionResource, ACTIVE_GROUP, { preserveFocus: true, pinned: true });
            } catch (error) {
                widget = undefined;
            }
            widget = widget || widgets.getWidgetBySessionResource(model.sessionResource);
            // The open editor holds its own reference; without one the empty chat is gone when ours is released.
            ref.dispose();
            // Creation already began: losing authority cannot truthfully mean 'not delivered' or permit a retry.
            const afterOpen = fenced(req);
            if (afterOpen || now() > deadline) {
                record.reason = afterOpen ? afterOpen.error : 'deadline_passed';
                return controlView(record);
            }
            if (!widget) { record.status = 'failed'; record.reason = 'not_opened'; return controlView(record); }
            if (req.effort !== undefined && (widget.input?.currentModeKind !== 'agent' || typeof widget.input?._ezilSessionEffortV2 !== 'function')) {
                record.reason = widget.input?.currentModeKind !== 'agent' ? 'created_effort_mode_unsupported' : 'created_effort_isolation_unavailable';
                record.model = currentModel(widget); record.requestCount = model.getRequests().length; record.observedAt = now();
                return controlView(record);
            }
            const applied = (wanted ? selectModel(widget, wanted) : true) && selectEffort(widget, req.effort);
            record.model = currentModel(widget);
            record.effort = currentEffort(widget);
            record.requestCount = model.getRequests().length;
            record.observedAt = now();
            record.status = applied || req.protocol !== 3 ? 'created' : 'uncertain';
            record.reason = applied ? null : 'model_not_applied';
            log('created a chat');
            return controlView(record);
        });
    }

    /** Change one open, idle session's model, then read it back. Never queued: busy is answered now. */
    async function setModel(req) {
        if (!UUID.test(req.commandId) || !isText(req.sessionResource, 2048) || (req.model !== undefined && (typeof req.model !== 'string' || !MODEL_ID.test(req.model)))
            || (req.effort !== undefined && (typeof req.effort !== 'string' || !EFFORT.test(req.effort)))
            || (req.model === undefined && req.effort === undefined)
            || !Number.isSafeInteger(req.deliverWithinMs) || req.deliverWithinMs < 0) return fail('bad_request');
        const denied = fenced(req);
        if (denied) return denied;
        const deadline = now() + req.deliverWithinMs;
        return reserve(req, req.sessionResource, { kind: 'configure', key: req.sessionResource, request: JSON.stringify([req.model ?? null, req.effort ?? null]) }, async () => {
            const stale = fenced(req);
            if (stale) return stale;
            const session = (await localSessions()).get(req.sessionResource);
            const afterLookup = fenced(req);
            if (afterLookup) return afterLookup;
            if (!session) return { ok: true, status: 'unknown_session' };
            const widget = await widgetFor(session, req.reveal);
            const afterWidget = fenced(req);
            if (afterWidget) return afterWidget;
            if (!widget) return { ok: true, status: 'not_open' };
            if (widget._lockedAgent) return { ok: true, status: 'unsupported_session' };
            const model = chat.getSession(session.resource);
            if (!model) return { ok: true, status: 'not_open' };
            const busy = busyState(model);
            if (busy.inProgress || busy.needsInput || busy.blocked || busy.pending > 0) return { ok: true, status: 'busy' };
            if (req.effort !== undefined && widget.input?.currentModeKind !== 'agent') return { ok: true, status: 'rejected', reason: 'effort_mode_unsupported' };
            if (req.model !== undefined && !pickerModels(widget).some((m) => m.id === req.model)) return { ok: true, status: 'rejected', reason: 'model_not_offered' };
            if (now() > deadline) return { ok: true, status: 'expired' };
            if (!effortAllowed(widget, req.model ?? currentModel(widget), req.effort)) return { ok: true, status: 'rejected', reason: 'effort_unavailable' };
            const record = { commandId: req.commandId, kind: 'configure', request: JSON.stringify([req.model ?? null, req.effort ?? null]), key: req.sessionResource, resource: session.resource,
                status: 'uncertain', model: null, requestCount: null, reason: 'configure_outcome_unknown', observedAt: null };
            remember(record);
            const applied = (req.model === undefined || selectModel(widget, req.model)) && selectEffort(widget, req.effort);
            record.model = currentModel(widget);
            record.effort = currentEffort(widget);
            record.requestCount = model.getRequests().length;
            record.observedAt = now();
            record.status = applied ? 'applied' : req.protocol === 3 ? 'uncertain' : 'failed';
            record.reason = applied ? null : 'model_not_applied';
            return controlView(record);
        });
    }

    async function submit(req) {
        if (!UUID.test(req.commandId) || !isText(req.sessionResource, 2048) || !isText(req.text, MAX_TEXT) || !req.text.trim()
            || !Number.isSafeInteger(req.deliverWithinMs) || req.deliverWithinMs < 0) {
            return fail('bad_request');
        }
        const denied = fenced(req);
        if (denied) return denied;
        const deadline = now() + req.deliverWithinMs;
        const existing = commands.get(req.commandId);
        if (existing) {
            if (existing.kind || existing.key !== req.sessionResource || existing.text !== req.text) return fail('command_conflict');
            return commandView(existing, { duplicate: true });
        }
        // Reserve the id across ALL sessions before any await, so the same command can never be
        // sent twice (to one session, or to two sessions concurrently).
        const reserved = inflight.get(req.commandId);
        if (reserved) return !reserved.kind && reserved.key === req.sessionResource && reserved.text === req.text ? fail('command_in_flight') : fail('command_conflict');
        inflight.set(req.commandId, { key: req.sessionResource, text: req.text });
        try {
            return await withLock(req.sessionResource, async () => {
                // The owner may have changed while this waited for the session.
                const stale = fenced(req);
                if (stale) return stale;
                const session = (await localSessions()).get(req.sessionResource);
                if (!session) return { ok: true, status: 'unknown_session' };
                return deliver(req, session, req.sessionResource, deadline);
            });
        } finally {
            inflight.delete(req.commandId);
        }
    }

    async function cancel(req) {
        if (!UUID.test(req.commandId)) return fail('bad_request');
        const denied = fenced(req);
        if (denied) return denied;
        const record = commands.get(req.commandId);
        // Never reached this workbench: the caller withdraws it from its own queue.
        if (!record) return { ok: true, status: 'unknown_command' };
        if (record.kind) return fail('bad_request');
        if (record.status !== 'accepted') return commandView(record);
        const response = record.response;
        if (response && response.isCanceled) return commandView(record);
        if (response && response.isComplete) return commandView(record);
        const model = chat.getSession(record.resource);
        // Only ever cancel OUR request: cancelCurrentRequestForSession stops whatever is running.
        const ours = !!record.requestId && !!model && !!model.lastRequest && model.lastRequest.id === record.requestId
            && busyState(model).inProgress;
        if (!ours) return commandView(record, { cancel: 'cannot_verify' });
        record.cancelRequested = true;
        await chat.cancelCurrentRequestForSession(record.resource, 'ezil-chat-bridge');
        return commandView(record);
    }

    function responseText(response) {
        const body = response.entireResponse || response.response;
        const text = body ? (typeof body.getMarkdown === 'function' ? body.getMarkdown() : String(body)) : '';
        return text.length > MAX_RESPONSE_CHARS ? text.slice(text.length - MAX_RESPONSE_CHARS) : text;
    }

    /** A strictly increasing counter of observed model changes, so a reader can order snapshots. */
    function versionOf(key, model) {
        let watch = watchers.get(key);
        if (!watch || watch.model !== model) {
            if (watch) watch.listener.dispose();
            watch = { model, version: (watch ? watch.version : 0) + 1, listener: null };
            const current = watch;
            current.listener = model.onDidChange(() => { current.version += 1; });
            watchers.set(key, watch);
        }
        return watch.version;
    }

    async function read(req) {
        if (!isText(req.sessionResource, 2048)) return fail('bad_request');
        const denied = fenced(req);
        if (denied) return denied;
        const session = (await localSessions()).get(req.sessionResource);
        const afterLookup = fenced(req);
        if (afterLookup) return afterLookup;
        if (!session) return { ok: true, status: 'unknown_session' };
        let model = chat.getSession(session.resource);
        let ref = null;
        if (!model) {
            ref = await chat.acquireOrLoadSession(session.resource, 'panel', NO_CANCEL, 'EZiL#chatBridge.read');
            model = ref && ref.object;
            if (!model) return { ok: true, status: 'unknown_session' };
        }
        try {
            const afterLoad = fenced(req);
            if (afterLoad) return afterLoad;
            const max = Number.isSafeInteger(req.maxRequests) && req.maxRequests > 0 ? Math.min(req.maxRequests, MAX_READ) : MAX_READ;
            const busy = busyState(model);
            const requests = model.getRequests().slice(-max).map((request) => ({
                id: String(request.id),
                text: String((request.message && request.message.text) || '').slice(0, MAX_TEXT),
                response: request.response ? {
                    text: responseText(request.response),
                    isComplete: !!request.response.isComplete,
                    isCanceled: !!request.response.isCanceled,
                } : null,
            }));
            return {
                ok: true, status: 'ok', sessionResource: req.sessionResource, title: session.title,
                version: ref ? null : versionOf(req.sessionResource, model),
                open: !!widgets.getWidgetBySessionResource(session.resource),
                requestInProgress: busy.inProgress, needsInput: busy.needsInput, pending: busy.pending, requests,
            };
        } finally {
            if (ref) ref.dispose();
        }
    }

    async function handle(request) {
        if (disposed) return fail('disconnected');
        if (!request || typeof request !== 'object' || Array.isArray(request)) return fail('bad_request');
        try {
            switch (request.op) {
                case 'hello':
                    return { ok: true, protocol: 2, supportedProtocols: [1, 2, PROTOCOL], owner: owner && { id: owner.id, epoch: owner.epoch }, workspaceFolders: deps.workspaceFolders() };
                case 'claim': {
                    if (!OWNER.test(request.ownerId) || !Number.isSafeInteger(request.epoch) || request.epoch < 1) return fail('bad_request');
                    if (owner && (request.epoch < owner.epoch || (request.epoch === owner.epoch && request.ownerId !== owner.id))) {
                        return fail('stale_owner', { epoch: owner.epoch });
                    }
                    owner = { id: request.ownerId, epoch: request.epoch };
                    return { ok: true, owner: { id: owner.id, epoch: owner.epoch } };
                }
                case 'sessions': {
                    const denied = fenced(request);
                    if (denied) return denied;
                    const listed = await localSessions();
                    const afterLookup = fenced(request);
                    if (afterLookup) return afterLookup;
                    const sessions = [];
                    for (const [resource, session] of listed) {
                        const widget = widgets.getWidgetBySessionResource(session.resource);
                        const open = !!widget;
                        // Only a model this window already has loaded; never loads one just to look.
                        const model = open ? chat.getSession(session.resource) : undefined;
                        const status = model ? (busyState(model).inProgress ? 'running' : 'idle') : 'unknown';
                        // The model selected in that session's own input now (open sessions only), and how many requests it has.
                        sessions.push({ resource, title: session.title, open, status, model: open ? currentModel(widget) : null, effort: open ? currentEffort(widget) : null,
                            requests: model ? model.getRequests().length : null });
                    }
                    return { ok: true, sessions };
                }
                case 'models': {
                    const denied = fenced(request);
                    if (denied) return denied;
                    const widget = someWidget();
                    if (!widget) return { ok: true, status: 'unavailable', reason: 'no_chat_widget' };
                    return { ok: true, status: 'ok', models: pickerModels(widget), observedAt: now() };
                }
                case 'create': return await create(request);
                case 'setModel': return await setModel(request);
                case 'submit': return await submit(request);
                case 'cancel': return await cancel(request);
                case 'command': {
                    if (!UUID.test(request.commandId)) return fail('bad_request');
                    const denied = fenced(request);
                    if (denied) return denied;
                    const record = commands.get(request.commandId);
                    return record ? commandView(record) : { ok: true, status: 'unknown_command' };
                }
                case 'read': return await read(request);
                default: return fail('unsupported_op');
            }
        } catch (error) {
            log('operation failed: ' + String(request.op));
            return fail('internal_error');
        }
    }

    // Untagged callers are the shipped protocol-2 extension. Never send them new fields.
    async function negotiatedHandle(request) {
        const protocol = request?.protocol ?? 2;
        if (![1, 2, 3].includes(protocol)) return fail('bad_request');
        if (request?.effort !== undefined && protocol < 3) return { ok: true, status: 'rejected', reason: 'effort_not_per_session' };
        if (protocol < 2 && ['models', 'create', 'setModel'].includes(request?.op)) return fail('unsupported_op');
        const result = await handle(request);
        if (protocol === 3 || !result || request?.op === 'hello') return result;
        const strip = value => {
            const { effort, selectedEffort, efforts, defaultEffort, ...old } = value;
            return old;
        };
        const old = strip(result);
        if (Array.isArray(result.sessions)) old.sessions = result.sessions.map(value => {
            const row = strip(value);
            if (protocol === 1) { delete row.model; delete row.requests; }
            return row;
        });
        if (Array.isArray(result.models)) old.models = result.models.map(strip);
        return old;
    }
    return {
        handle: negotiatedHandle,
        dispose() {
            disposed = true;
            for (const ref of held) ref.dispose();
            held.clear();
            for (const watch of watchers.values()) watch.listener.dispose();
            watchers.clear();
        },
    };
})
