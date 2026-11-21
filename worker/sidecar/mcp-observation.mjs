import { randomBytes } from 'node:crypto';

export const OBSERVE_PATH = '/internal/mcp-browser-observe';
export const UNIVERSE_STAGING_ORIGIN = 'https://universe-staging.ezil.work';
const SESSION_MS = 120_000;
const MAX_SESSIONS = 16;
const MAX_TABS = 12;
const MAX_IN_FLIGHT = 4;
const READ_MS = 5_000;
const ID = /^[A-Za-z0-9_-]{43}$/;

function failure (error) {
    return { ok: false, error };
}

/** Only this closed metadata shape bypasses legacy browser secret collection. */
export function observationPayload (value) {
    if (value?.ok === false && ['browser_invalid_request', 'browser_session_stale', 'browser_page_unavailable',
        'browser_unavailable'].includes(value.error)) return failure(value.error);
    if (value?.ok === true && typeof value.browserSessionId === 'string' && ID.test(value.browserSessionId)
        && typeof value.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.expiresAt)
        && ['profile_builder', 'interactive_sign_in_required'].includes(value.observed)
        && typeof value.profileHeadingVisible === 'boolean'
        && (value.observed === 'profile_builder' || !value.profileHeadingVisible)) {
        return {
            ok: true, browserSessionId: value.browserSessionId, expiresAt: value.expiresAt,
            observed: value.observed, profileHeadingVisible: value.profileHeadingVisible, universeIdentity: 'unverified',
        };
    }
    return failure('browser_unavailable');
}

function pageKind (url, origin) {
    try {
        const { origin: actual, pathname, searchParams } = new URL(url);
        if (actual !== origin) return null;
        if (pathname === '/builder/profile-builder' || pathname === '/builder/profile-builder/') return 'profile_builder';
        if (pathname === '/auth/ezil-id/login' || pathname === '/auth/ezil-id/login/'
            || pathname === '/builder/login' || pathname === '/builder/login/'
            || (pathname === '/' && searchParams.getAll('role').join(',') === 'builder')) {
            return 'interactive_sign_in_required';
        }
    } catch { /* A closing, blank or privileged tab is outside this surface. */ }
    return null;
}

/** A short-lived handle binds an observation to the same actual Playwright page. */
export function createMcpObservation (surface, { origin = UNIVERSE_STAGING_ORIGIN, now = Date.now } = {}) {
    const sessions = new Map();
    const revisions = new WeakMap();
    let inFlight = 0;

    function revision (page) {
        if (!revisions.has(page)) {
            revisions.set(page, 0);
            page.on('framenavigated', frame => {
                if (frame === page.mainFrame()) revisions.set(page, revisions.get(page) + 1);
            });
        }
        return revisions.get(page);
    }

    async function readPage (page) {
        if (page.isClosed()) return null;
        const expected = pageKind(page.url(), origin);
        if (!expected) return null;
        const before = revision(page);
        // Run a fixed DOM observation only on a pinned origin and route. It reads
        // visibility plus presence of a landmark heading, never form or account data.
        const info = await page.evaluate(({ origin, expected }) => {
            if (location.origin !== origin || document.visibilityState !== 'visible') return null;
            const path = location.pathname.replace(/\/$/, '');
            if (expected === 'interactive_sign_in_required') {
                const roles = new URLSearchParams(location.search).getAll('role');
                const knownHandoff = path === '/auth/ezil-id/login' || path === '/builder/login'
                    || (path === '' && roles.length === 1 && roles[0] === 'builder');
                return knownHandoff ? { profileHeadingVisible: false } : null;
            }
            if (path !== '/builder/profile-builder') return null;
            const heading = document.querySelector('main h1, [role="main"] h1');
            return { profileHeadingVisible: !!heading?.getClientRects().length };
        }, { origin, expected });
        if (!info || typeof info.profileHeadingVisible !== 'boolean' || page.isClosed()
            || revision(page) !== before || pageKind(page.url(), origin) !== expected) return null;
        return { observed: expected, profileHeadingVisible: info.profileHeadingVisible, revision: before };
    }

    async function observeBound (input, deadline) {
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || !Object.keys(input).every(key => key === 'binding' || key === 'browserSessionId')
            || typeof input.binding !== 'string' || !/^[0-9a-f]{64}$/.test(input.binding)
            || (input.browserSessionId !== undefined && (typeof input.browserSessionId !== 'string' || !ID.test(input.browserSessionId)))) {
            return failure('browser_invalid_request');
        }

        for (const [id, session] of sessions) {
            if (session.expires <= now() || session.page.isClosed()) sessions.delete(id);
        }
        const id = input.browserSessionId;
        try {
            if (id !== undefined) {
                const session = sessions.get(id);
                if (!session || session.binding !== input.binding || revision(session.page) !== session.revision) {
                    return failure('browser_session_stale');
                }
                const read = await readPage(session.page);
                if (!read || read.revision !== session.revision || session.expires <= now() || Date.now() >= deadline) return failure('browser_session_stale');
                return {
                    ok: true, browserSessionId: id, expiresAt: new Date(session.expires).toISOString(),
                    observed: read.observed, profileHeadingVisible: read.profileHeadingVisible, universeIdentity: 'unverified',
                };
            }

            const browser = await surface.connect();
            const pages = browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed());
            if (pages.length > MAX_TABS) return failure('browser_page_unavailable');
            const eligible = pages.filter(page => pageKind(page.url(), origin));
            const visible = await Promise.all(eligible.map(async page => ({ page, read: await readPage(page) })));
            const matches = visible.filter(candidate => candidate.read !== null);
            if (matches.length !== 1) return failure('browser_page_unavailable');
            if (sessions.size >= MAX_SESSIONS || Date.now() >= deadline) return failure('browser_unavailable');
            const { page, read } = matches[0];
            const browserSessionId = randomBytes(32).toString('base64url');
            const expires = now() + SESSION_MS;
            sessions.set(browserSessionId, { binding: input.binding, page, revision: read.revision, expires });
            return {
                ok: true, browserSessionId, expiresAt: new Date(expires).toISOString(),
                observed: read.observed, profileHeadingVisible: read.profileHeadingVisible, universeIdentity: 'unverified',
            };
        } catch {
            return failure('browser_unavailable');
        }
    }

    return async function observe (input) {
        if (inFlight >= MAX_IN_FLIGHT) return failure('browser_unavailable');
        inFlight += 1;
        const task = observeBound(input, Date.now() + READ_MS).finally(() => { inFlight -= 1; });
        let timer;
        try {
            return await Promise.race([
                task,
                new Promise(resolve => {
                    timer = setTimeout(() => resolve(failure('browser_unavailable')), READ_MS);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    };
}
