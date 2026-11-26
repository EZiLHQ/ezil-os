import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SILENT_MARKER_KEY, SILENT_MARKER_TTL_MS, SILENT_TIMEOUT_MS, silentWorkSignIn } from './silent-sign-in';

const os = 'https://os-staging.ezil.work', universe = 'https://universe-staging.ezil.work';
const id = 'ba4cf399-1f9b-43e5-be10-45e403bc0190', owner = '0123456789abcdef', request = '6f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
const repo = `https://github.ezil.work/default/u-${owner}-a-${id}.git`;
const challenge = '11111111-1111-4111-8111-111111111111';
const work = 'ezil.assignment.work/v2', auth = 'ezil.assignment.work-auth/v1';
type Listener = (event: unknown) => void;

function memory(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, data };
}

/** The OS frame's window as the code sees it: a direct child of the Universe tab unless told otherwise. */
function frameWindow(options: { search?: string; pathname?: string; nested?: boolean; ancestors?: string[]; storage?: unknown } = {}) {
    const top = { postMessage: vi.fn() };
    const listeners = new Set<Listener>();
    const children: Array<Record<string, unknown> & { contentWindow: object; remove: ReturnType<typeof vi.fn> }> = [];
    const appended: object[] = [];
    const storage = options.storage === undefined ? memory() : options.storage;
    const win = {
        top, parent: options.nested ? { postMessage: vi.fn() } : top,
        location: { origin: os, pathname: options.pathname ?? '/app/code', reload: vi.fn(),
            search: options.search ?? '?' + new URLSearchParams({ repo, assignment: id }),
            ...(options.ancestors ? { ancestorOrigins: options.ancestors } : {}) },
        addEventListener: (type: string, fn: Listener) => { if (type === 'message') listeners.add(fn); },
        removeEventListener: (type: string, fn: Listener) => { if (type === 'message') listeners.delete(fn); },
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (handle: number) => clearTimeout(handle),
        crypto: { randomUUID: vi.fn(() => request) },
        document: {
            createElement: vi.fn(() => { const child = { style: {}, setAttribute: vi.fn(), remove: vi.fn(), contentWindow: {} }; children.push(child); return child; }),
            body: { append: vi.fn((node: object) => { appended.push(node); }) },
        },
    };
    Object.defineProperty(win, 'sessionStorage', { get() { if (storage === 'throws') throw new Error('SecurityError'); return storage; } });
    const send = (event: object) => { for (const fn of [...listeners]) fn(event); };
    const discover = (overrides: Record<string, unknown> = {}, source: object = top, origin = universe) =>
        send({ source, origin, data: { protocol: work, type: 'discover', attemptId: id, challenge, ...overrides } });
    const answer = (outcome: unknown, overrides: Record<string, unknown> = {}, source: object | undefined = children[0]?.contentWindow, origin = os) =>
        send({ source, origin, data: { protocol: auth, request, attemptId: id, outcome, ...overrides } });
    const replies = () => top.postMessage.mock.calls.map(call => (call[0] as { type: string }).type);
    return { win: win as unknown as Window, top, listeners, children, appended, storage: storage as ReturnType<typeof memory>, discover, answer, replies, reload: win.location.reload };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-26T06:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('a cold OS frame waits for its actual Universe parent before anything else', () => {
    it('creates no child, writes no marker and says nothing until a trusted discover arrives', () => {
        const frame = frameWindow();
        silentWorkSignIn(id, frame.win);
        vi.advanceTimersByTime(SILENT_TIMEOUT_MS * 2);
        expect(frame.children).toHaveLength(0);
        expect(frame.storage.data.size).toBe(0);
        expect(frame.top.postMessage).not.toHaveBeenCalled();
    });
    it('🔴 ignores a discover from another window, another origin, another attempt or with a malformed challenge', () => {
        const frame = frameWindow();
        silentWorkSignIn(id, frame.win);
        frame.discover({}, {});
        frame.discover({}, frame.top, 'https://universe.ezil.work');
        frame.discover({}, frame.top, os);
        frame.discover({ attemptId: '00000000-0000-4000-8000-000000000001' });
        frame.discover({ challenge: 'not-a-uuid' });
        frame.discover({ type: 'bind' });
        frame.discover({ protocol: 'ezil.assignment.work/v1' });
        expect(frame.children).toHaveLength(0);
        expect(frame.top.postMessage).not.toHaveBeenCalled();
    });
    it.each([
        ['nested below another frame', { nested: true }],
        ['under another top-level origin', { ancestors: ['https://elsewhere.example'] }],
        ['under a longer ancestor chain', { ancestors: [universe, universe] }],
    ])('🔴 never starts when %s', (_name, options) => {
        const frame = frameWindow(options);
        silentWorkSignIn(id, frame.win);
        frame.discover();
        frame.discover({}, frame.win.parent as unknown as object);
        expect(frame.children).toHaveLength(0);
        expect(frame.storage.data.size).toBe(0);
        expect(frame.top.postMessage).not.toHaveBeenCalled();
    });
});

describe('one hidden child, while the frame answers preparing', () => {
    it('inserts exactly one hidden same-origin child for this attempt, owner and a fresh request id', () => {
        const frame = frameWindow({ ancestors: [universe] });
        const pending = vi.fn();
        silentWorkSignIn(id, frame.win, pending);
        frame.discover();
        expect(frame.children).toHaveLength(1);
        expect(frame.appended).toEqual([frame.children[0]]);
        const child = frame.children[0]!;
        expect(child.src).toBe('/assignment/work-auth?' + new URLSearchParams({ attempt: id, owner, request }));
        expect(child).toMatchObject({ hidden: true, tabIndex: -1, referrerPolicy: 'no-referrer', style: { display: 'none' } });
        expect(child.setAttribute).toHaveBeenCalledWith('aria-hidden', 'true');
        expect(frame.top.postMessage).toHaveBeenCalledExactlyOnceWith({ protocol: work, type: 'preparing', attemptId: id, challenge }, universe);
        expect(pending.mock.calls).toEqual([[true]]);
        expect(JSON.parse(frame.storage.data.get(SILENT_MARKER_KEY)!)).toEqual({ attempt: id, at: Date.now() });
        // Later discovers are answered, and never start a second child.
        frame.discover({ challenge: '22222222-2222-4222-8222-222222222222' });
        frame.discover();
        expect(frame.children).toHaveLength(1);
        expect(frame.replies()).toEqual(['preparing', 'preparing', 'preparing']);
    });
    it('🔴 counts an answer only from that child\'s own window, at this origin, with this request id and a known outcome', () => {
        const frame = frameWindow();
        silentWorkSignIn(id, frame.win);
        frame.discover();
        frame.answer('signed_in', {}, {});
        frame.answer('signed_in', {}, frame.top);
        frame.answer('signed_in', {}, frame.children[0]!.contentWindow, universe);
        frame.answer('signed_in', { request: '00000000-0000-4000-8000-000000000009' });
        frame.answer('signed_in', { request: null });
        frame.answer('signed_in', { protocol: work });
        frame.answer('ok');
        frame.answer(undefined);
        expect(frame.reload).not.toHaveBeenCalled();
        expect(frame.children[0]!.remove).not.toHaveBeenCalled();
        expect(frame.replies()).toEqual(['preparing']);
    });
});

describe('success reloads only this frame', () => {
    it('removes the child once, reloads once, and never reports a sign-in requirement', () => {
        const frame = frameWindow();
        const pending = vi.fn();
        silentWorkSignIn(id, frame.win, pending);
        frame.discover();
        frame.answer('signed_in');
        frame.answer('signed_in');
        frame.answer('unavailable');
        vi.advanceTimersByTime(SILENT_TIMEOUT_MS * 2);
        expect(frame.reload).toHaveBeenCalledOnce();
        expect(frame.children[0]!.remove).toHaveBeenCalledOnce();
        // Until the new document answers for itself, this one keeps saying preparing.
        frame.discover();
        expect(frame.replies()).toEqual(['preparing', 'preparing']);
        expect(pending.mock.calls).toEqual([[true]]);
        expect((frame.win.top as unknown as { location?: unknown }).location).toBeUndefined();
    });
    it('a success that names another attempt is not a success', () => {
        const frame = frameWindow();
        silentWorkSignIn(id, frame.win);
        frame.discover();
        frame.answer('signed_in', { attemptId: '00000000-0000-4000-8000-000000000001' });
        expect(frame.reload).not.toHaveBeenCalled();
        expect(frame.replies()).toEqual(['preparing', 'authentication_required']);
    });
});

describe('failure cleans up once and hands over to the existing top-level sign-in', () => {
    it.each(['sign_in_required', 'account_mismatch', 'unavailable'])('%s removes the child and answers authentication_required', outcome => {
        const frame = frameWindow();
        const pending = vi.fn();
        silentWorkSignIn(id, frame.win, pending);
        frame.discover();
        frame.answer(outcome, { attemptId: null });
        expect(frame.children[0]!.remove).toHaveBeenCalledOnce();
        expect(frame.reload).not.toHaveBeenCalled();
        expect(frame.top.postMessage).toHaveBeenLastCalledWith({ protocol: work, type: 'authentication_required', attemptId: id, challenge }, universe);
        expect(pending.mock.calls).toEqual([[true], [false]]);
        // Settled: nothing more is created, reloaded or removed, whatever arrives next.
        frame.answer('signed_in');
        frame.discover();
        vi.advanceTimersByTime(SILENT_TIMEOUT_MS * 2);
        expect(frame.children).toHaveLength(1);
        expect(frame.children[0]!.remove).toHaveBeenCalledOnce();
        expect(frame.reload).not.toHaveBeenCalled();
        expect(frame.replies()).toEqual(['preparing', 'authentication_required', 'authentication_required']);
    });
    it('🔴 a child that never answers (blocked cookies, a refused frame) is removed after the time limit', () => {
        const frame = frameWindow();
        silentWorkSignIn(id, frame.win);
        frame.discover();
        vi.advanceTimersByTime(SILENT_TIMEOUT_MS - 1);
        expect(frame.replies()).toEqual(['preparing']);
        vi.advanceTimersByTime(1);
        expect(frame.children[0]!.remove).toHaveBeenCalledOnce();
        expect(frame.replies()).toEqual(['preparing', 'authentication_required']);
        frame.answer('signed_in');
        expect(frame.reload).not.toHaveBeenCalled();
    });
    it('leaving the page removes the child, its listener and its timer', () => {
        const frame = frameWindow();
        const dispose = silentWorkSignIn(id, frame.win);
        frame.discover();
        dispose();
        expect(frame.children[0]!.remove).toHaveBeenCalledOnce();
        expect(frame.listeners.size).toBe(0);
        frame.answer('signed_in');
        vi.advanceTimersByTime(SILENT_TIMEOUT_MS * 2);
        expect(frame.reload).not.toHaveBeenCalled();
        expect(frame.replies()).toEqual(['preparing']);
    });
});

describe('one attempt per assignment per tab, across this frame\'s own reload', () => {
    it('🔴 the reloaded document does not try again: a sign-in that left no session cannot loop', () => {
        const storage = memory();
        const first = frameWindow({ storage });
        silentWorkSignIn(id, first.win);
        first.discover();
        first.answer('signed_in');
        expect(first.reload).toHaveBeenCalledOnce();
        const reloaded = frameWindow({ storage });
        silentWorkSignIn(id, reloaded.win);
        reloaded.discover();
        expect(reloaded.children).toHaveLength(0);
        expect(reloaded.replies()).toEqual(['authentication_required']);
        // Bounded: after the marker's lifetime, or for another assignment, one more attempt is allowed.
        vi.advanceTimersByTime(SILENT_MARKER_TTL_MS);
        const later = frameWindow({ storage });
        silentWorkSignIn(id, later.win);
        later.discover();
        expect(later.children).toHaveLength(1);
    });
    it('🔴 one document never starts a second child, even after the marker has aged out', () => {
        const frame = frameWindow();
        silentWorkSignIn(id, frame.win);
        frame.discover();
        frame.answer('sign_in_required');
        vi.advanceTimersByTime(SILENT_MARKER_TTL_MS + 1);
        frame.discover();
        frame.discover();
        expect(frame.children).toHaveLength(1);
        expect(frame.replies()).toEqual(['preparing', 'authentication_required', 'authentication_required', 'authentication_required']);
    });
    it('a marker for another assignment, or from the future, does not block this one', () => {
        for (const seen of [{ attempt: '00000000-0000-4000-8000-000000000001', at: Date.now() }, { attempt: id, at: Date.now() + 60_000 }, { attempt: id }]) {
            const frame = frameWindow({ storage: memory({ [SILENT_MARKER_KEY]: JSON.stringify(seen) }) });
            silentWorkSignIn(id, frame.win);
            frame.discover();
            expect(frame.children).toHaveLength(1);
        }
    });
    it.each([
        ['sessionStorage throws', { storage: 'throws' }],
        ['sessionStorage drops writes', { storage: { getItem: () => null, setItem: () => {} } }],
        ['the marker is unreadable', { storage: memory({ [SILENT_MARKER_KEY]: '{' }) }],
        ['the address is not the Code entry', { pathname: '/app/assignment-enrollment' }],
        ['the address names no repository', { search: '?assignment=' + id }],
        ['the repository belongs to another attempt', { search: '?' + new URLSearchParams({ repo: repo.replace(id, '00000000-0000-4000-8000-000000000001'), assignment: id }) }],
        ['the repository is not the canonical one', { search: '?' + new URLSearchParams({ repo: 'https://github.com/example/other.git', assignment: id }) }],
    ])('🔴 falls back to the ordinary sign-in when %s', (_name, options) => {
        const frame = frameWindow(options);
        const pending = vi.fn();
        silentWorkSignIn(id, frame.win, pending);
        frame.discover();
        frame.discover();
        expect(frame.children).toHaveLength(0);
        expect(frame.replies()).toEqual(['authentication_required', 'authentication_required']);
        expect(pending).not.toHaveBeenCalled();
        expect(frame.reload).not.toHaveBeenCalled();
    });
    it('a browser without randomUUID falls back the same way and leaves nothing behind', () => {
        const frame = frameWindow();
        (frame.win.crypto as unknown as { randomUUID: () => string }).randomUUID = () => { throw new TypeError('unsupported'); };
        silentWorkSignIn(id, frame.win);
        frame.discover();
        expect(frame.children).toHaveLength(0);
        expect(frame.replies()).toEqual(['authentication_required']);
    });
});
