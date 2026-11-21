// EZiL Chat bridge, extension side (EZiL MCP CONTRACT.md v3.0; workbench side: worker/copilot-chat/chat-bridge.js).
//
// One loop per editor window: sync with OS through the code host (`POST /editor-bridge/v1/sync`, authenticated
// by this boot's EZIL_EDITOR_BRIDGE_TOKEN, which the Worker verifies; never the AI proxy token), then act on what OS handed out through the
// workbench's internal command `_ezil.chatBridge.v1`, and report what happened on the next sync.
//
// OS is the authority: it grants one window per computer an epoch, and this client passes that epoch to the
// workbench bridge (`claim`) so a window that lost ownership is refused there too. Delivery is at most once:
// anything whose outcome this client cannot prove is reported `uncertain`, never retried. Only a definite
// "not sent" (busy, not open, refused before delivery) goes back as `not_delivered`. Every report names the
// attempt OS handed out, and every sync carries a strictly increasing seq, so OS never takes a stale or replayed
// report for a later attempt. The token is never logged.
//
// Protocol 2 (proposal: docs/EDITOR-BRIDGE-PROTOCOL-2.md) is used only when OS answers a sync with `protocol: 2`
// and this window's workbench speaks it; until then every body, delivery and report is exactly protocol 1. It adds
// the picker's models (`catalog`) and each open session's selected model to the sync, and two deliveries: `create`
// (a new, empty chat) and `configure` (one idle session's model). Their reports carry only what the runtime read
// back after the change. Effort is not a session setting in this editor: a requested effort is refused.

export const BRIDGE_COMMAND = '_ezil.chatBridge.v1';
export const SYNC_PATH = '/editor-bridge/v1/sync';
const SYNC_TIMEOUT_MS = 20_000;
const IDLE_MS = 15_000;
const SESSIONS_EVERY = 5;
const MAX_REPORTS = 32;
const MAX_RESPONSE_CHARS = 16_000;
const OWNER = /^[A-Za-z0-9_.:-]{1,128}$/;

export type ReportStatus = 'not_delivered' | 'expired' | 'rejected' | 'running' | 'cancel_requested' | 'completed' | 'cancelled'
    | 'finished_unverified' | 'failed' | 'uncertain' | 'applied';

/** A report before it is tied to its attempt. */
export interface Report {
    operationId: string;
    status: ReportStatus;
    reason?: string;
    requestId?: string;
    mode?: string;
    selectedModelId?: string;
    responseText?: string;
    /** Protocol 2, `applied` only: the session and the model the runtime reports after the change. */
    sessionResource?: string;
    model?: string | null;
    requestCount?: number;
    observedAt?: number;
}

export interface Delivery {
    operationId: string;
    attemptId: string;
    deliverWithinMs: number;
    kind: 'send' | 'cancel' | 'create' | 'configure';
    /** Absent for `create`. */
    sessionResource: string;
    text?: string;
    targetOperationId?: string;
    model?: string;
    effort?: string;
    /** Protocol 2: OS created this session, so the editor may show its tab again to act on it. */
    reveal?: boolean;
}

type SyncReply =
    | { ok: true; protocol?: number; owner: 'self'; epoch: number; pollMs: number; deliver: Delivery[] }
    | { ok: true; protocol?: number; owner: 'other'; pollMs: number };

/**
 * One catalog row, in the MCP proposal's shape. Effort is per model here: `efforts` is empty, `configuredEffort` is
 * read-only. `availability: "available"` only on fresh evidence that the EZiL Gateway allows this computer's account to
 * use the model; a row without it (a static configured model, or no fresh evidence) is listed, not attested.
 */
export interface CatalogModel { id: string; label: string; engine: 'ezil-chat'; efforts: string[]; defaultEffort: null; configuredEffort: string | null;
    availability?: 'available' }

type View = Record<string, unknown>;

export interface BridgeClientDeps {
    /** `https://<code host>/editor-bridge/v1/sync`. */
    syncUrl: string;
    token: string;
    ownerId: string;
    /** `vscode.commands.executeCommand(BRIDGE_COMMAND, request)`. */
    execute: (request: Record<string, unknown>) => Promise<unknown>;
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    log: (line: string) => void;
    /**
     * Make sure the chat agent is active before a send (activates GitHub.copilot-chat). Observed in a running
     * 4.141.0 workbench: a send that was the window's first chat request, made while the agent was still
     * activating, ended canceled. False: not sent now (not_delivered, agent_not_ready), retried until expiry.
     */
    ensureAgent?: () => Promise<boolean>;
    /** The fixed `thinking.effort` this extension sends for one of its own models (picker metadata id), or null. */
    effortOf?: (modelId: string) => string | null;
    /** Of these picker metadata ids (this extension's own models), those with fresh Gateway evidence for this account. */
    availableIds?: (modelIds: string[]) => Promise<Set<string>>;
}

/** The code host's sync URL, from EZIL_AI_BASE_URL (`https://8443-<id>-code.<zone>/ai/v1`), or null. */
export function syncUrlFrom(aiBaseUrl: string | undefined): string | null {
    if (!aiBaseUrl) return null;
    try {
        const url = new URL(aiBaseUrl);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /(^|\.)localhost$|^127\.0\.0\.1$/.test(url.hostname))) return null;
        return `${url.origin}${SYNC_PATH}`;
    } catch {
        return null;
    }
}

const reasonOf = (value: unknown, fallback: string) =>
    typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : fallback;

/** Map the workbench's answer to a submit onto what OS may record. Exported for tests. */
export function submitReport(operationId: string, view: unknown): Report {
    if (!view || typeof view !== 'object') return { operationId, status: 'uncertain', reason: 'bad_response' };
    const v = view as View;
    if (v.ok === false) {
        // These refusals happen before the workbench touches the session: definitely not sent.
        if (v.error === 'stale_owner' || v.error === 'no_owner' || v.error === 'disconnected') return { operationId, status: 'not_delivered', reason: String(v.error) };
        if (v.error === 'bad_request' || v.error === 'command_conflict') return { operationId, status: 'rejected', reason: String(v.error) };
        return { operationId, status: 'uncertain', reason: reasonOf(v.error, 'bridge_error') };
    }
    const base = {
        operationId,
        ...(typeof v.requestId === 'string' ? { requestId: v.requestId.slice(0, 256) } : {}),
        ...(typeof v.mode === 'string' ? { mode: v.mode.slice(0, 64) } : {}),
        ...(typeof v.selectedModelId === 'string' ? { selectedModelId: v.selectedModelId.slice(0, 256) } : {}),
    };
    switch (v.status) {
        case 'busy': return { operationId, status: 'not_delivered', reason: 'busy' };
        case 'not_open': return { operationId, status: 'not_delivered', reason: 'not_open' };
        case 'unknown_session': return { operationId, status: 'rejected', reason: 'unknown_session' };
        case 'unsupported_session': return { operationId, status: 'rejected', reason: 'unsupported_session' };
        case 'rejected': return { operationId, status: 'rejected', reason: 'chat_rejected' };
        // Refused at the last check before sending because its delivery deadline had passed: not sent.
        case 'expired': return { operationId, status: 'expired', reason: 'deadline_passed' };
        case 'in_progress': return { ...base, status: 'running' };
        case 'cancel_requested': return { ...base, status: 'cancel_requested' };
        case 'completed': return { ...base, status: 'completed' };
        case 'cancelled': return { ...base, status: 'cancelled' };
        case 'finished_unverified': return { ...base, status: 'finished_unverified' };
        case 'failed': return { ...base, status: 'failed', reason: 'model_error' };
        default: return { operationId, status: 'uncertain', reason: v.status === 'uncertain' ? 'send_outcome_unknown' : 'bad_response' };
    }
}

/** Map the workbench's answer to a `create` or `setModel` onto what OS may record (protocol 2). Exported for tests. */
export function controlReport(operationId: string, view: unknown): Report {
    if (!view || typeof view !== 'object') return { operationId, status: 'uncertain', reason: 'bad_response' };
    const v = view as View;
    if (v.ok === false) {
        if (v.error === 'stale_owner' || v.error === 'no_owner' || v.error === 'disconnected') return { operationId, status: 'not_delivered', reason: String(v.error) };
        if (v.error === 'bad_request' || v.error === 'command_conflict') return { operationId, status: 'rejected', reason: String(v.error) };
        return { operationId, status: 'uncertain', reason: reasonOf(v.error, 'bridge_error') };
    }
    switch (v.status) {
        case 'created': case 'applied': {
            if (typeof v.sessionResource !== 'string' || !v.sessionResource || v.sessionResource.length > 2048 || !Number.isSafeInteger(v.observedAt)) {
                return { operationId, status: 'uncertain', reason: 'bad_response' };
            }
            return {
                operationId, status: 'applied', sessionResource: v.sessionResource, model: typeof v.model === 'string' ? v.model.slice(0, 256) : null,
                ...(Number.isSafeInteger(v.requestCount) ? { requestCount: v.requestCount as number } : {}), observedAt: v.observedAt as number,
                ...(v.reason === 'model_not_applied' ? { reason: 'model_not_applied' } : {}),
            };
        }
        case 'busy': return { operationId, status: 'not_delivered', reason: 'busy' };
        case 'not_open': return { operationId, status: 'not_delivered', reason: 'not_open' };
        case 'unknown_session': return { operationId, status: 'rejected', reason: 'unknown_session' };
        case 'unsupported_session': return { operationId, status: 'rejected', reason: 'unsupported_session' };
        case 'rejected': return { operationId, status: 'rejected', reason: reasonOf(v.reason, 'rejected') };
        case 'expired': return { operationId, status: 'expired', reason: 'deadline_passed' };
        case 'failed': return { operationId, status: 'failed', reason: reasonOf(v.reason, 'unspecified') };
        default: return { operationId, status: 'uncertain', reason: reasonOf(v.reason, 'bad_response') };
    }
}

const FINAL = new Set<ReportStatus>(['completed', 'cancelled', 'finished_unverified', 'failed', 'uncertain', 'rejected', 'expired']);

interface Tracked { operationId: string; attemptId: string; sessionResource: string; last: ReportStatus }

export class ChatBridgeClient {
    private epoch = 0;
    private seq = 0;
    /** What the workbench speaks (hello) and what OS last answered with; protocol 2 needs both. */
    private workbench = 1;
    private os = 1;
    private claimedEpoch = 0;
    private ticks = 0;
    private reports: (Report & { attemptId: string })[] = [];
    private readonly tracked = new Map<string, Tracked>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private stopped = false;
    private running = false;

    constructor(private readonly deps: BridgeClientDeps) {
        if (!OWNER.test(deps.ownerId)) throw new Error('invalid bridge owner id');
    }

    start(): void {
        this.schedule(0);
    }

    stop(): void {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
    }

    private schedule(ms: number): void {
        if (this.stopped) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.tick().then((next) => this.schedule(next)); }, ms);
    }

    /** One sync round. Returns the delay before the next one. Public for tests. */
    async tick(): Promise<number> {
        if (this.running) return 1_000;
        this.running = true;
        try {
            return await this.round();
        } catch (error) {
            this.deps.log(`[chat-bridge] round failed: ${error instanceof Error ? error.name : 'error'}`);
            return IDLE_MS;
        } finally {
            this.running = false;
        }
    }

    private call(request: Record<string, unknown>): Promise<unknown> {
        return this.deps.execute(request);
    }

    private fence(): Record<string, unknown> {
        return { ownerId: this.deps.ownerId, epoch: this.epoch };
    }

    private async round(): Promise<number> {
        // No bridge in this window (setting off, or no EZiL Chat pane yet): nothing to offer OS.
        try {
            const hello = await this.call({ op: 'hello' }) as View | undefined;
            if (!hello || hello.ok !== true || (hello.protocol !== 1 && hello.protocol !== 2)) return IDLE_MS;
            this.workbench = hello.protocol;
        } catch {
            return IDLE_MS;
        }
        this.ticks += 1;
        this.seq += 1;
        const protocol = this.protocol();
        const body: Record<string, unknown> = { protocol, ownerId: this.deps.ownerId, epoch: this.epoch, seq: this.seq };
        if (this.epoch > 0 && this.claimedEpoch === this.epoch && (this.ticks % SESSIONS_EVERY === 1 || this.ticks <= 2)) {
            const sessions = await this.sessions(protocol);
            if (sessions) body.sessions = sessions;
            if (protocol === 2) body.catalog = await this.catalog();
        }
        const sending = this.reports.splice(0, MAX_REPORTS);
        if (sending.length) body.reports = sending;

        const reply = await this.sync(body);
        if (!reply) {
            // The reports may or may not have arrived; OS only takes them at the same epoch, so resending is safe.
            this.reports.unshift(...sending);
            return IDLE_MS;
        }
        this.os = reply.protocol === 2 ? 2 : 1;
        if (reply.owner === 'other') {
            this.lose();
            return Math.max(reply.pollMs, 1_000);
        }
        if (reply.epoch !== this.epoch) {
            // New ownership: whatever the old epoch held is already uncertain at OS.
            this.lose();
            this.epoch = reply.epoch;
        }
        if (this.claimedEpoch !== this.epoch) {
            const claimed = await this.call({ op: 'claim', ...this.fence() }) as View | undefined;
            if (!claimed || claimed.ok !== true) return Math.max(reply.pollMs, 1_000);
            this.claimedEpoch = this.epoch;
        }
        const receivedAt = Date.now();
        for (const delivery of reply.deliver) await this.deliver(delivery, receivedAt);
        await this.observe();
        return this.reports.length ? 200 : Math.max(reply.pollMs, 500);
    }

    /** Protocol 2 only when both OS and the workbench speak it. */
    private protocol(): 1 | 2 {
        return this.os === 2 && this.workbench === 2 ? 2 : 1;
    }

    private lose(): void {
        this.epoch = 0;
        this.claimedEpoch = 0;
        this.reports = [];
        this.tracked.clear();
    }

    private async sync(body: Record<string, unknown>): Promise<SyncReply | null> {
        let response: Response;
        try {
            response = await this.deps.fetch(this.deps.syncUrl, {
                method: 'POST',
                headers: { authorization: `Bearer ${this.deps.token}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
                redirect: 'error',
                signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
            });
        } catch {
            this.deps.log('[chat-bridge] sync unreachable');
            return null;
        }
        if (response.status !== 200) {
            this.deps.log(`[chat-bridge] sync refused: HTTP ${response.status}`);
            return null;
        }
        try {
            const reply = await response.json() as SyncReply;
            if (reply?.ok !== true || (reply.owner !== 'self' && reply.owner !== 'other')) return null;
            if (reply.owner === 'self' && (!Number.isSafeInteger(reply.epoch) || reply.epoch < 1 || !Array.isArray(reply.deliver))) return null;
            return reply;
        } catch {
            return null;
        }
    }

    private async sessions(protocol: 1 | 2): Promise<unknown[] | null> {
        try {
            const result = await this.call({ op: 'sessions', ...this.fence() }) as View | undefined;
            if (!result || result.ok !== true || !Array.isArray(result.sessions)) return null;
            return (result.sessions as View[])
                .filter((s) => typeof s.resource === 'string' && s.resource.length > 0 && s.resource.length <= 2048)
                .slice(0, 200)
                .map((s) => ({
                    resource: s.resource, title: typeof s.title === 'string' ? s.title.slice(0, 512) : '', open: s.open === true,
                    status: s.status === 'idle' || s.status === 'running' ? s.status : 'unknown',
                    // Protocol 1 sessions are exactly the four fields OS v1 accepts.
                    ...(protocol === 2 ? {
                        model: typeof s.model === 'string' ? s.model.slice(0, 256) : null,
                        requests: Number.isSafeInteger(s.requests) ? s.requests : null,
                    } : {}),
                }));
        } catch {
            return null;
        }
    }

    /** The picker's models as this window offers them now, or unavailable with a reason (never an empty list for "cannot tell"). */
    private async catalog(): Promise<Record<string, unknown>> {
        const observedAt = Date.now();
        let result: View | undefined;
        try {
            result = await this.call({ op: 'models', ...this.fence() }) as View | undefined;
        } catch {
            return { status: 'unavailable', reason: 'bridge_call_failed', observedAt };
        }
        if (!result || result.ok !== true || result.status !== 'ok' || !Array.isArray(result.models)) {
            return { status: 'unavailable', reason: reasonOf(result?.reason, 'bad_response'), observedAt };
        }
        const rows = (result.models as View[]).filter((m) => typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 256).slice(0, 100);
        const ownId = (m: View) => (m.vendor === 'ezil' && typeof m.modelId === 'string' ? m.modelId : null);
        let allowed = new Set<string>();
        try {
            if (this.deps.availableIds) allowed = await this.deps.availableIds(rows.map(ownId).filter((id): id is string => id !== null));
        } catch {
            allowed = new Set();
        }
        const models: CatalogModel[] = rows.map((m) => {
            const id = ownId(m);
            const own = id !== null && this.deps.effortOf ? this.deps.effortOf(id) : null;
            return { id: m.id as string, label: typeof m.label === 'string' ? m.label.slice(0, 128) : (m.id as string), engine: 'ezil-chat',
                efforts: [], defaultEffort: null, configuredEffort: own ?? null, ...(id !== null && allowed.has(id) ? { availability: 'available' as const } : {}) };
        });
        return { status: 'available', models, observedAt };
    }

    private report(report: Report, attemptId: string): void {
        this.reports.push({ ...report, attemptId });
    }

    private async deliver(delivery: Delivery, receivedAt: number): Promise<void> {
        const attempt = delivery.attemptId;
        if (delivery.kind === 'create' || delivery.kind === 'configure') {
            this.report(await this.control(delivery, receivedAt), attempt);
            return;
        }
        if (delivery.kind === 'send') {
            let ready = true;
            try {
                ready = this.deps.ensureAgent ? await this.deps.ensureAgent() : true;
            } catch {
                ready = false;
            }
            if (!ready) {
                this.report({ operationId: delivery.operationId, status: 'not_delivered', reason: 'agent_not_ready' }, attempt);
                return;
            }
            let report: Report;
            try {
                // The deadline travels as time left (never a wall-clock time: the workbench runs on another machine).
                const deliverWithinMs = Math.max(0, Math.floor(delivery.deliverWithinMs - (Date.now() - receivedAt)));
                report = submitReport(delivery.operationId, await this.call({
                    op: 'submit', ...this.fence(), commandId: delivery.operationId, sessionResource: delivery.sessionResource, text: delivery.text,
                    deliverWithinMs, ...(this.protocol() === 2 && delivery.reveal === true ? { reveal: true } : {}),
                }));
            } catch {
                // The call itself failed mid-flight (window closing): it may have reached the model.
                report = { operationId: delivery.operationId, status: 'uncertain', reason: 'bridge_call_failed' };
            }
            await this.finish(delivery.sessionResource, report, attempt);
            return;
        }
        const target = delivery.targetOperationId!;
        let view: View | undefined;
        try {
            view = await this.call({ op: 'cancel', ...this.fence(), commandId: target }) as View | undefined;
        } catch {
            this.report({ operationId: delivery.operationId, status: 'uncertain', reason: 'bridge_call_failed' }, attempt);
            return;
        }
        if (!view || view.ok === false) {
            const error = view?.error;
            this.report(error === 'stale_owner' || error === 'no_owner' || error === 'disconnected'
                ? { operationId: delivery.operationId, status: 'not_delivered', reason: String(error) }
                : { operationId: delivery.operationId, status: 'rejected', reason: reasonOf(error, 'bridge_error') }, attempt);
            return;
        }
        if (view.status === 'unknown_command') {
            this.report({ operationId: delivery.operationId, status: 'rejected', reason: 'unknown_command' }, attempt);
            return;
        }
        if (view.cancel === 'cannot_verify' || view.status === 'uncertain') {
            this.report({ operationId: delivery.operationId, status: 'rejected', reason: 'cannot_verify' }, attempt);
            return;
        }
        const targetReport = submitReport(target, view);
        if (targetReport.status === 'cancel_requested' || targetReport.status === 'cancelled') {
            // The cancel op first, so OS settles it from the target's outcome.
            this.report({ operationId: delivery.operationId, status: 'cancel_requested' }, attempt);
        } else {
            this.report({ operationId: delivery.operationId, status: 'rejected', reason: 'already_finished' }, attempt);
        }
        // The target's own outcome goes under the target's attempt, which this window holds if it sent it.
        const held = this.tracked.get(target);
        if (held) await this.finish(delivery.sessionResource, targetReport, held.attemptId, target);
    }

    /** A protocol-2 control, answered within this round (never tracked: it has no running state). */
    private async control(delivery: Delivery, receivedAt: number): Promise<Report> {
        const operationId = delivery.operationId;
        if (this.protocol() !== 2) return { operationId, status: 'rejected', reason: 'unsupported_kind' };
        // Effort is per model in this editor (and for the whole window), never one session's setting.
        if (delivery.effort !== undefined) return { operationId, status: 'rejected', reason: 'effort_not_per_session' };
        if (delivery.kind === 'configure' && delivery.model === undefined) return { operationId, status: 'rejected', reason: 'nothing_to_change' };
        const deliverWithinMs = Math.max(0, Math.floor(delivery.deliverWithinMs - (Date.now() - receivedAt)));
        try {
            return controlReport(operationId, await this.call(delivery.kind === 'create'
                ? { op: 'create', ...this.fence(), commandId: operationId, deliverWithinMs, ...(delivery.model !== undefined ? { model: delivery.model } : {}) }
                : { op: 'setModel', ...this.fence(), commandId: operationId, sessionResource: delivery.sessionResource, model: delivery.model, deliverWithinMs,
                    ...(delivery.reveal === true ? { reveal: true } : {}) }));
        } catch {
            // The call failed mid-flight (window closing): the change may or may not have happened.
            return { operationId, status: 'uncertain', reason: 'bridge_call_failed' };
        }
    }

    /** Report now; keep watching until final; attach the final response text of THAT request only. */
    private async finish(sessionResource: string, report: Report, attemptId: string, operationId = report.operationId): Promise<void> {
        if (report.status === 'not_delivered') {
            this.tracked.delete(operationId);
            this.report(report, attemptId);
            return;
        }
        if (FINAL.has(report.status)) {
            this.tracked.delete(operationId);
            this.report(await this.withResponse(sessionResource, report), attemptId);
            return;
        }
        const known = this.tracked.get(operationId);
        if (!known || known.last !== report.status) this.report(report, attemptId);
        this.tracked.set(operationId, { operationId, attemptId, sessionResource, last: report.status });
    }

    private async observe(): Promise<void> {
        for (const item of [...this.tracked.values()]) {
            let view: unknown;
            try {
                view = await this.call({ op: 'command', ...this.fence(), commandId: item.operationId });
            } catch {
                continue;
            }
            const v = view as View | undefined;
            if (v?.ok === true && v.status === 'unknown_command') {
                this.tracked.delete(item.operationId);
                this.report({ operationId: item.operationId, status: 'uncertain', reason: 'lost_by_workbench' }, item.attemptId);
                continue;
            }
            if (v?.ok === false) continue;
            const report = submitReport(item.operationId, view);
            if (report.status === 'not_delivered' || report.status === 'rejected') continue;
            await this.finish(item.sessionResource, report, item.attemptId, item.operationId);
        }
    }

    private async withResponse(sessionResource: string, report: Report): Promise<Report> {
        if (!report.requestId || !['completed', 'cancelled', 'finished_unverified', 'failed'].includes(report.status)) return report;
        try {
            const read = await this.call({ op: 'read', ...this.fence(), sessionResource, maxRequests: 20 }) as View | undefined;
            const requests = Array.isArray(read?.requests) ? read.requests as View[] : [];
            const ours = requests.find((r) => r.id === report.requestId);
            const text = ours && ours.response && typeof (ours.response as View).text === 'string' ? (ours.response as View).text as string : '';
            return text ? { ...report, responseText: text.length > MAX_RESPONSE_CHARS ? text.slice(-MAX_RESPONSE_CHARS) : text } : report;
        } catch {
            return report;
        }
    }
}
