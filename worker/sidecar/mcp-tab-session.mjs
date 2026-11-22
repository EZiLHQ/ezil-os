import { createHash, randomBytes } from 'node:crypto';
import { tierOf } from './origin-policy.mjs';
import { applyPublicAction, browserTabPolicy, discardRefs, neutralTab, pageVisibility, readPublicTab, v1Text, validUiInput } from './mcp-tab-actions.mjs';
import {
    applyOwnerAppAction, describeTiered, OWNER_APP_READ_KINDS, ownerAppActionMayNavigate, policyOf, readOwnerApp,
} from './mcp-owner-app.mjs';
import { fitBrowserUiResult } from './mcp-observation-payload.mjs';

const MAX_TABS = 12;
const MAX_SESSIONS = 16;
const MAX_ACTIONS = 128;
const SESSION_MS = 120_000;
const VIEWER_MAX_AGE_MS = 15 * 60_000;
const RECORD_MS = VIEWER_MAX_AGE_MS + SESSION_MS;
const failure = error => ({ ok: false, error });
/** Approved public pages keep the v1 action set (browser verbs v2 §4). */
const PUBLIC_ACTIONS = new Set(['navigate', 'click', 'type']);

/**
 * One owner-bound Browser tab session over the existing Browser.
 *
 * Three adapters, chosen by the page (browser verbs v2 §4):
 *   - the neutral start page answers `browser_ready` and nothing else;
 *   - an `owner_app` or `idp_transit` page goes to `mcp-owner-app.mjs`
 *     (default context, through `VERBS`, no request interception);
 *   - an approved example.* or fixture page keeps `mcp-tab-actions.mjs`,
 *     unchanged: its v1 actions and text bound, its request filter and CSP.
 * The Universe legacy kinds (`readLegacy`) still answer when Universe is not
 * an owner-app origin. requestId dedupe and the uncertain-outcome model are
 * the same for every adapter.
 */
export function createBrowserTabSession (surface, sessions, revision, readLegacy, options) {
    const { now } = options;
    const permitted = browserTabPolicy(options);
    const actions = new Map();
    const activePages = new WeakSet();
    // Read per use: the surface owns its origin policy, and a test double may have none.
    const policy = () => policyOf(surface);

    async function release (id, current) {
        sessions.delete(id);
        await discardRefs(current.refs);
    }

    async function prune () {
        const time = now();
        for (const [id, session] of sessions) {
            if ((session.expires <= time || session.page.isClosed()) && !activePages.has(session.page)) {
                await release(id, session);
            }
        }
        for (const [key, item] of actions) {
            if (item.result && item.expires <= time) actions.delete(key);
        }
    }

    async function describe (page) {
        const current = page.url();
        if (neutralTab(current)) {
            return await pageVisibility(page, current)
                ? { observed: 'browser_ready', pageUrl: null, profileHeadingVisible: false }
                : null;
        }
        // The origin tier decides first: an owner-app or IdP page is never read by another adapter.
        const tiered = await describeTiered(page, current, policy());
        if (tiered !== undefined) return tiered;
        const approved = permitted(current);
        if (approved) {
            return await pageVisibility(page, current)
                ? { observed: 'approved_page', pageUrl: approved.origin + approved.pathname, profileHeadingVisible: false }
                : null;
        }
        const legacy = await readLegacy(page);
        if (!legacy) return null;
        const url = new URL(current);
        return { observed: legacy.observed, pageUrl: url.origin + url.pathname, profileHeadingVisible: legacy.profileHeadingVisible };
    }

    /** Is this display an owner-app read on a page that is in the owner-app tier right now? */
    function ownerAppRead (page, display) {
        return OWNER_APP_READ_KINDS.has(display.observed) && tierOf(page.url(), policy()) === 'owner_app';
    }

    async function projection (id, session, display, { includeFrame = false, refs = false } = {}) {
        const { page } = session;
        let inspected;
        let frame = null;
        let title = null;
        let elements = [];
        let email = null;
        if (display.observed === 'approved_page') {
            inspected = await readPublicTab(page, permitted, {
                includeFrame, collectElements: refs && session.controlledRevision === session.revision,
            });
            if (!inspected) return null;
            frame = inspected.viewerFrame;
            title = inspected.pageTitle;
            if (refs && !includeFrame) {
                await discardRefs(session.refs);
                session.refs = inspected.refs;
                elements = inspected.elements;
            } else {
                await discardRefs(inspected.refs);
            }
        } else if (ownerAppRead(page, display)) {
            inspected = await readOwnerApp(surface, page, policy(), {
                includeFrame, collectElements: refs, email: display.observed === 'profile_builder',
            });
            if (!inspected) return null;
            if (session.revision !== revision(page)) return null;
            frame = inspected.viewerFrame;
            title = inspected.pageTitle;
            email = inspected.ownerAppAccountEmail;
            if (refs) {
                await discardRefs(session.refs);
                session.refs = inspected.refs;
                elements = inspected.elements;
                // Non-navigate actions need a read of THIS document first (contract §4).
                session.readRevision = session.revision;
            }
        }
        const time = now();
        if (session.expires <= time || session.revision !== revision(page) || page.isClosed()) return null;
        // The whole answer stays under 160 KiB: trim the elements (spending
        // their handles), then the frame, never more. expiresAt has a fixed
        // width, so it is set after the fit without changing the size.
        const fitted = fitBrowserUiResult({
            ok: true, browserSessionId: id, expiresAt: new Date(session.expires).toISOString(), ...display,
            universeIdentity: 'unverified', pageTitle: title, elements, viewerFrame: frame, ownerAppAccountEmail: email,
        }, session.refs);
        if (!fitted) return null;
        // Polling the same authenticated live view can preserve its handle. A
        // hidden tab, missing frame, expired lease or another document cannot.
        if (fitted.viewerFrame) {
            const createdAt = session.createdAt ??= session.expires - SESSION_MS;
            session.expires = Math.min(time + SESSION_MS, createdAt + VIEWER_MAX_AGE_MS);
        }
        return { ...fitted, expiresAt: new Date(session.expires).toISOString() };
    }

    async function locate (id, input) {
        if (id !== undefined) {
            const current = sessions.get(id);
            if (!current || current.binding !== input.binding || current.revision !== revision(current.page)) return null;
            return { id, current };
        }
        const browser = await surface.connect();
        const pages = browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed());
        if (pages.length > MAX_TABS) return null;
        // Observe only the single eligible visible tab; a hidden or foreign tab cannot be selected by the caller.
        const candidates = await Promise.all(pages.map(async page => {
            const initialRevision = revision(page);
            const display = await describe(page).catch(() => null);
            return display && initialRevision === revision(page) ? { page, revision: initialRevision } : null;
        }));
        const eligible = candidates.filter(Boolean);
        if (eligible.length !== 1 || sessions.size >= MAX_SESSIONS) return null;
        const idNew = randomBytes(32).toString('base64url');
        const createdAt = now();
        const current = { binding: input.binding, ...eligible[0], createdAt, expires: createdAt + SESSION_MS };
        sessions.set(idNew, current);
        return { id: idNew, current };
    }

    /**
     * Which adapter acts, or the failure that says why none may. Navigate may
     * target an owner-app origin or an already-approved one, never an IdP.
     * Anything else needs the read kind of this document: approved (prepared
     * by this handle), or an owner-app read of this very document.
     */
    function adapterFor (page, display, action, current) {
        if (action.kind === 'navigate') {
            const target = tierOf(action.url, policy());
            if (target === 'idp_transit') return { error: 'browser_action_unavailable' };
            return target === 'owner_app' ? 'owner' : 'public';
        }
        if (ownerAppRead(page, display)) {
            return current.readRevision === current.revision ? 'owner' : { error: 'browser_action_unavailable' };
        }
        // The IdP is transit only: nothing is read, typed or clicked there.
        if (tierOf(page.url(), policy()) === 'idp_transit') return { error: 'origin_read_only' };
        if (display.observed === 'approved_page' && current.controlledRevision === current.revision
            && PUBLIC_ACTIONS.has(action.kind) && (action.kind !== 'type' || v1Text(action.text))) return 'public';
        return { error: 'browser_action_unavailable' };
    }

    return async function perform (input, deadline, signal) {
        if (!validUiInput(input)) return failure('browser_invalid_request');
        await prune();
        const stopped = () => Date.now() >= deadline || Boolean(signal?.aborted);
        const requestedAction = input.action.kind !== 'read';
        const action = input.action;
        const key = requestedAction ? input.binding + ':' + input.requestId : null;
        // Every member of the action is in the digest: the same requestId with a different action is a conflict.
        const digest = requestedAction ? createHash('sha256').update(JSON.stringify([
            input.browserSessionId, action.kind, action.url ?? null, action.ref ?? null, action.text ?? null,
            action.fields ?? null, action.values ?? null, action.dy ?? null, action.key ?? null,
        ])).digest('hex') : null;
        const old = key && actions.get(key);
        if (old) {
            if (old.digest !== digest) return failure('browser_action_conflict');
            const stillThere = sessions.get(input.browserSessionId);
            if (!stillThere || stillThere.binding !== input.binding || stillThere.expires <= now()
                || stillThere.page.isClosed() || stillThere.revision !== revision(stillThere.page)) return failure('browser_session_stale');
            return old.result ?? failure('browser_action_pending');
        }
        const handle = await locate(input.browserSessionId, input);
        if (!handle) return failure(input.browserSessionId === undefined ? 'browser_page_unavailable' : 'browser_session_stale');
        const { id, current } = handle;
        const { page } = current;
        if (activePages.has(page) || stopped()) return failure('browser_unavailable');
        activePages.add(page);
        let run;
        let dispatched = false;
        try {
            const display = await describe(page);
            if (!display || current.revision !== revision(page) || current.expires <= now() || stopped()) return failure('browser_session_stale');
            if (!requestedAction) return await projection(id, current, display, { includeFrame: action.includeFrame === true, refs: true })
                ?? failure('browser_session_stale');

            const adapter = adapterFor(page, display, action, current);
            if (typeof adapter !== 'string') return failure(adapter.error);
            // Another request on the same key may have resolved after attach; reserve exactly once before any input.
            if (actions.has(key)) return failure('browser_action_pending');
            if (actions.size >= MAX_ACTIONS) return failure('browser_unavailable');
            run = { digest, result: null, expires: now() + RECORD_MS };
            actions.set(key, run);
            const activeUrl = page.url();
            const stillBound = async () => !stopped() && current.expires > now()
                && current.revision === revision(page) && await pageVisibility(page, activeUrl);
            const canNavigate = adapter === 'owner'
                ? ownerAppActionMayNavigate(action)
                : action.kind === 'navigate' || action.kind === 'click' && current.refs?.get(action.ref)?.kind === 'link';
            if (adapter === 'owner') {
                const outcome = await applyOwnerAppAction(surface, page, action, current.refs, policy(), () => { dispatched = true; }, stillBound);
                if (outcome.error) return (run.result = failure(outcome.error));
            } else {
                const applied = await applyPublicAction(page, action, current.refs, permitted, () => { dispatched = true; }, stillBound);
                if (!applied) return (run.result = failure('browser_action_unavailable'));
            }
            const newRevision = revision(page);
            // A typed input or a non-link click is never authority for a navigation.
            if (!canNavigate && current.revision !== newRevision) throw new Error('unexpected page change');
            current.revision = newRevision;
            // Only the approved-page adapter prepares a document (its request filter and CSP) for later input.
            current.controlledRevision = adapter === 'public' ? newRevision : null;
            await discardRefs(current.refs);
            const next = await describe(page);
            if (!next || stopped()) throw new Error('outcome not verified');
            const projected = await projection(id, current, next);
            return (run.result = projected ?? failure('browser_action_uncertain'));
        } catch {
            const result = failure(dispatched ? 'browser_action_uncertain' : 'browser_unavailable');
            if (run) run.result = result;
            return result;
        } finally {
            if (run) run.expires = now() + RECORD_MS;
            activePages.delete(page);
        }
    };
}
