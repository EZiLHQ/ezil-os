import { describe, expect, it } from 'vitest';
import * as app from './assignment-work-auth';
// The shell's copy of the child responder (the bundle cannot import app/src); both must behave identically.
import * as shell from '../../../shell/ezil/assignment-video/work-protocol.js';

const id = 'ba4cf399-1f9b-43e5-be10-45e403bc0190', challenge = '2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a';
const universe = 'https://universe-staging.ezil.work', os = 'https://os-staging.ezil.work';
const protocol = 'ezil.assignment.work/v2';
const repo = 'https://github.ezil.work/default/u-0123456789abcdef-a-' + id + '.git';
type Responder = (attemptId: string, win: Window, current: () => string, onDiscover?: () => void) => { dispose(): void; push(): void };

function frame({ origin = os, ancestors, nested = false, topLevel = false }: { origin?: string; ancestors?: string[]; nested?: boolean; topLevel?: boolean } = {}) {
    const posted: unknown[][] = [], listeners = new Set<(event: unknown) => void>();
    const top = { postMessage: (...args: unknown[]) => posted.push(['top', ...args]) };
    const parent = nested ? { postMessage: (...args: unknown[]) => posted.push(['parent', ...args]) } : top;
    const win: Record<string, unknown> = { location: { origin, ...(ancestors ? { ancestorOrigins: ancestors } : {}) }, top, parent,
        addEventListener: (type: string, fn: (event: unknown) => void) => { if (type === 'message') listeners.add(fn); },
        removeEventListener: (_type: string, fn: (event: unknown) => void) => listeners.delete(fn) };
    if (topLevel) { win.top = win; win.parent = win; }
    const send = (overrides: Record<string, unknown> = {}, source: unknown = win.parent, from = universe) =>
        [...listeners].forEach(fn => fn({ source, origin: from, data: { protocol, type: 'discover', attemptId: id, challenge, ...overrides } }));
    return { win: win as unknown as Window, posted, send, listeners };
}

describe.each([['shell', shell.respondToWorkDiscover as Responder], ['app', app.respondToWorkDiscover as Responder]])(
    'ezil.assignment.work/v2 child responder (%s)', (_name, respond) => {
        it('answers only the actual top-level Universe parent, for this attempt, with its exact challenge', () => {
            let state = 'preparing';
            const f = frame();
            const responder = respond(id, f.win, () => state);
            responder.push();
            expect(f.posted).toEqual([]);
            f.send({}, {});
            f.send({}, (f.win as unknown as { parent: unknown }).parent, 'https://other.ezil.work');
            f.send({}, (f.win as unknown as { parent: unknown }).parent, 'https://universe-staging.ezil.work.evil.example');
            for (const bad of [{ protocol: 'ezil.assignment.work/v1' }, { type: 'ready' }, { attemptId: challenge },
                { challenge: 'not-a-uuid' }, { challenge: challenge.toUpperCase() }, { challenge: 7 }]) f.send(bad);
            expect(f.posted).toEqual([]);
            f.send();
            expect(f.posted).toEqual([['top', { protocol, type: 'preparing', attemptId: id, challenge }, universe]]);
            state = 'ready';
            responder.push();
            expect(f.posted.at(-1)).toEqual(['top', { protocol, type: 'ready', attemptId: id, challenge }, universe]);
            state = 'something_else';
            responder.push();
            expect(f.posted).toHaveLength(2);
            responder.dispose();
            state = 'ready';
            f.send();
            expect(f.posted).toHaveLength(2);
            expect(f.listeners.size).toBe(0);
        });
        it('replies against the latest challenge and carries nothing else', () => {
            const f = frame(), next = '11111111-1111-4111-8111-111111111111';
            let discovered = 0;
            const responder = respond(id, f.win, () => 'authentication_required', () => discovered++);
            f.send(); f.send({ challenge: next }); responder.push();
            expect(discovered).toBe(2);
            expect(f.posted.map(([, data]) => (data as { challenge: string }).challenge)).toEqual([challenge, next, next]);
            for (const [to, data, origin] of f.posted) {
                expect([to, origin]).toEqual(['top', universe]);
                expect(Object.keys(data as object).sort()).toEqual(['attemptId', 'challenge', 'protocol', 'type']);
            }
            responder.dispose();
        });
        it.each([{ topLevel: true }, { nested: true }, { origin: 'https://os.ezil.work' }, { origin: 'https://os-prod.ezil.work' },
            { ancestors: ['https://evil.example'] }, { ancestors: [universe, universe] }, { ancestors: [] as string[] }])(
            'never listens outside a direct staging child of a Universe page: %j', options => {
                const f = frame(options);
                const responder = respond(id, f.win, () => 'ready');
                f.send(); responder.push();
                expect(f.posted).toEqual([]);
                expect(f.listeners.size).toBe(0);
            });
        it('accepts the matching ancestor list and refuses a malformed attempt', () => {
            const f = frame({ ancestors: [universe] });
            respond('not-an-attempt', f.win, () => 'ready');
            f.send();
            expect(f.posted).toEqual([]);
            respond(id, f.win, () => 'ready');
            f.send();
            expect(f.posted).toHaveLength(1);
        });
    });

describe('identityPending: the sign-in document\'s additive bit on preparing', () => {
    type Pending = (attemptId: string, win: Window, current: () => string, onDiscover: undefined, pending: () => unknown) => { push(): void };
    const sent = (posted: unknown[][]) => posted.map(entry => entry[1] as Record<string, unknown>);
    it('🔴 is exactly true on preparing while the document says so, and absent from every other reply', () => {
        let state = 'preparing', pending: unknown = true;
        const f = frame();
        const responder = (app.respondToWorkDiscover as unknown as Pending)(id, f.win, () => state, undefined, () => pending);
        f.send();
        expect(f.posted).toEqual([['top', { protocol, type: 'preparing', attemptId: id, challenge, identityPending: true }, universe]]);
        expect(Object.keys(sent(f.posted)[0]!)).toEqual(['protocol', 'type', 'attemptId', 'challenge', 'identityPending']);
        // Every other state omits it even while the document still says pending.
        for (const other of ['authentication_required', 'ready', 'unavailable']) { state = other; responder.push(); }
        // And preparing omits it unless the answer is the boolean true.
        state = 'preparing';
        for (const value of [false, undefined, null, 'true', 1, {}]) { pending = value; responder.push(); }
        for (const message of sent(f.posted).slice(1)) expect(Object.keys(message)).toEqual(['protocol', 'type', 'attemptId', 'challenge']);
        expect(sent(f.posted).slice(1).map(message => message.type)).toEqual(['authentication_required', 'ready', 'unavailable', ...Array(6).fill('preparing')]);
        // Same trust checks as any reply: nothing for another window, origin, attempt or challenge shape.
        const before = f.posted.length;
        pending = true;
        f.send({}, {}); f.send({}, (f.win as unknown as { parent: unknown }).parent, os); f.send({ attemptId: challenge }); f.send({ challenge: 'x' });
        expect(f.posted).toHaveLength(before);
    });
    it('🔴 the ordinary responders never send it: without the argument, through the notice, and from the shell copy', () => {
        for (const state of ['preparing', 'ready', 'unavailable', 'authentication_required']) {
            const a = frame(), s = frame(), forced = frame();
            app.respondToWorkDiscover(id, a.win, () => state as app.WorkState);
            shell.respondToWorkDiscover(id, s.win, () => state);
            // The shell's copy takes no such argument: one passed anyway changes nothing.
            (shell.respondToWorkDiscover as unknown as Pending)(id, forced.win, () => state, undefined, () => true);
            a.send(); s.send(); forced.send();
            for (const f of [a, s, forced]) expect(f.posted).toEqual([['top', { protocol, type: state, attemptId: id, challenge }, universe]]);
        }
        const notice = frame();
        app.listenForWorkSignIn(id, notice.win);
        notice.send();
        expect(Object.keys(sent(notice.posted)[0]!)).toEqual(['protocol', 'type', 'attemptId', 'challenge']);
    });
});

describe('shared embed predicates', () => {
    it.each([{}, { ancestors: [universe] }, { topLevel: true }, { nested: true }, { origin: 'https://os.ezil.work' }, { ancestors: ['https://evil.example'] }])(
        'the shell frame predicate and both responders agree: %j', options => {
            const s = frame(options), a = frame(options);
            shell.respondToWorkDiscover(id, s.win, () => 'preparing');
            app.respondToWorkDiscover(id, a.win, () => 'preparing');
            s.send(); a.send();
            expect(s.posted).toEqual(a.posted);
            expect(shell.embeddedWorkFrame(s.win)).toBe(s.listeners.size === 1);
        });
    it('the signed-out notice still answers only authentication_required', () => {
        const f = frame();
        const dispose = app.listenForWorkSignIn(id, f.win);
        f.send();
        expect(f.posted).toEqual([['top', { protocol, type: 'authentication_required', attemptId: id, challenge }, universe]]);
        dispose(); f.send();
        expect(f.posted).toHaveLength(1);
    });
});

describe('framing policy for the embedded assignment Code entry', () => {
    const at = (path: string) => new URL(path, os);
    const entry = '/app/code?repo=' + encodeURIComponent(repo) + '&assignment=' + id;
    it('lets only the Universe staging origin frame the exact canonical entry on os-staging', () => {
        expect(app.assignmentEmbedFramePolicy(os, at(entry))).toBe('frame-ancestors ' + universe);
        expect(app.assignmentEmbedFramePolicy(os, at(entry + '&computer=11111111-1111-4111-8111-111111111111'))).toBe('frame-ancestors ' + universe);
    });
    it.each([
        ['production', 'https://os.ezil.work', entry],
        ['os-prod', 'https://os-prod.ezil.work', entry],
        ['plain Code', os, '/app/code'],
        ['ordinary repository', os, '/app/code?repo=' + encodeURIComponent('https://github.ezil.work/default/ordinary.git')],
        ['the desktop', os, '/os?repo=' + encodeURIComponent(repo) + '&assignment=' + id],
        ['another app', os, '/app/browser?repo=' + encodeURIComponent(repo) + '&assignment=' + id],
        ['a mismatched attempt', os, entry.replace('assignment=' + id, 'assignment=11111111-1111-4111-8111-111111111111')],
        ['a duplicated repository', os, entry + '&repo=' + encodeURIComponent(repo)],
        ['a duplicated assignment', os, entry + '&assignment=' + id],
        ['an attempt parameter', os, entry + '&attempt=' + id],
        ['no assignment', os, '/app/code?repo=' + encodeURIComponent(repo)],
    ])('adds no policy for %s', (_name, origin, path) => {
        expect(app.assignmentEmbedFramePolicy(origin, at(path))).toBeNull();
    });
});
