import { describe, expect, it } from 'vitest';
import * as app from './assignment-work-auth';
// The shell's copy of the child responder (the bundle cannot import app/src); both must behave identically.
import * as shell from '../../../shell/ezil/assignment-video/work-protocol.js';

const id = 'ba4cf399-1f9b-43e5-be10-45e403bc0190', challenge = '2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a';
const prodOs = 'https://os.ezil.work', prodUniverse = 'https://universe.ezil.work';
const stageOs = 'https://os-staging.ezil.work', stageUniverse = 'https://universe-staging.ezil.work';
const pairs = [[prodOs, prodUniverse], [stageOs, stageUniverse]] as const;
const protocol = 'ezil.assignment.work/v2';
const repo = 'https://github.ezil.work/default/u-0123456789abcdef-a-' + id + '.git';
type Responder = (attemptId: string, win: Window, current: () => string, onDiscover?: () => void) => { dispose(): void; push(): void };
type Options = { origin?: string; universe?: string; ancestors?: string[]; nested?: boolean; topLevel?: boolean };

/** A framed OS document at `origin` whose parent speaks from `universe` (the origin a `discover` arrives from by default). */
function frame({ origin = prodOs, universe = prodUniverse, ancestors, nested = false, topLevel = false }: Options = {}) {
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

const responders = [['shell', shell.respondToWorkDiscover as Responder], ['app', app.respondToWorkDiscover as Responder]] as const;
describe.each(responders.flatMap(([name, respond]) => pairs.map(([os, universe]) => [name, os, universe, respond] as const)))(
    'ezil.assignment.work/v2 child responder (%s on %s)', (_name, os, universe, respond) => {
        const other = pairs.find(pair => pair[0] !== os)![1];
        const here = (options: Options = {}) => frame({ origin: os, universe, ...options });
        it('answers only the actual top-level parent at its own paired Universe origin, for this attempt, with its exact challenge', () => {
            let state = 'preparing';
            const f = here();
            const responder = respond(id, f.win, () => state);
            responder.push();
            expect(f.posted).toEqual([]);
            const parent = (f.win as unknown as { parent: unknown }).parent;
            f.send({}, {});
            // The other deployment's Universe is never this OS origin's parent, however valid its message.
            for (const from of ['https://other.ezil.work', other, universe + '.evil.example', os, 'null']) f.send({}, parent, from);
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
            const f = here(), next = '11111111-1111-4111-8111-111111111111';
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
        it.each([{ topLevel: true }, { nested: true }, { ancestors: ['https://evil.example'] }, { ancestors: [other] },
            { ancestors: [universe, universe] }, { ancestors: [universe, other] }, { ancestors: [] as string[] }])(
            'never listens outside a direct child of its own paired Universe page: %j', options => {
                const f = here(options);
                const responder = respond(id, f.win, () => 'ready');
                f.send(); responder.push();
                expect(f.posted).toEqual([]);
                expect(f.listeners.size).toBe(0);
            });
        it('accepts the matching ancestor list and refuses a malformed attempt', () => {
            const f = here({ ancestors: [universe] });
            respond('not-an-attempt', f.win, () => 'ready');
            f.send();
            expect(f.posted).toEqual([]);
            respond(id, f.win, () => 'ready');
            f.send();
            expect(f.posted).toHaveLength(1);
        });
    });

describe('shared embed predicates', () => {
    it.each(['https://os-prod.ezil.work', 'https://os.ezil.org', 'https://universe.ezil.work', 'http://os.ezil.work', 'https://os.ezil.work.evil.example'])(
        'no other OS host ever answers, whichever Universe asks: %s', origin => {
            for (const respond of [shell.respondToWorkDiscover as Responder, app.respondToWorkDiscover as Responder]) {
                for (const universe of [prodUniverse, stageUniverse]) {
                    const f = frame({ origin, universe });
                    respond(id, f.win, () => 'ready').push();
                    f.send();
                    expect(f.posted).toEqual([]);
                    expect(f.listeners.size).toBe(0);
                    expect(shell.embeddedWorkFrame(f.win)).toBe(false);
                }
            }
            expect(app.workHostFor(origin)).toBeNull();
            expect(shell.workHostFor(origin)).toBeNull();
        });
    it.each(pairs.flatMap(([origin, universe]) => [{}, { ancestors: [universe] }, { topLevel: true }, { nested: true }, { ancestors: ['https://evil.example'] }]
        .map(options => ({ origin, universe, ...options }))))('the shell frame predicate and both responders agree: %j', options => {
        const s = frame(options), a = frame(options);
        shell.respondToWorkDiscover(id, s.win, () => 'preparing');
        app.respondToWorkDiscover(id, a.win, () => 'preparing');
        s.send(); a.send();
        expect(s.posted).toEqual(a.posted);
        expect(shell.embeddedWorkFrame(s.win)).toBe(s.listeners.size === 1);
        expect(shell.workHostFor(options.origin)).toBe(app.workHostFor(options.origin));
        expect(shell.WORK_PROTOCOL).toBe(protocol);
    });
    it('the signed-out notice still answers only authentication_required', () => {
        for (const [origin, universe] of pairs) {
            const f = frame({ origin, universe });
            const dispose = app.listenForWorkSignIn(id, f.win);
            f.send();
            expect(f.posted).toEqual([['top', { protocol, type: 'authentication_required', attemptId: id, challenge }, universe]]);
            dispose(); f.send();
            expect(f.posted).toHaveLength(1);
        }
    });
});

describe('return path of a sign-in started from the embedded workspace', () => {
    const returned = '/assignment/work-return?attempt=' + id;
    it('reads the attempt with and without the exact workspace suffix, on the work-return path only', () => {
        expect(app.workReturnAttempt(returned)).toBe(id);
        expect(app.workReturnAttempt(returned + app.embeddedWorkReturnSuffix)).toBe(id);
        expect(app.workReturnAttempt('/app/assignment-enrollment?attempt=' + id, '/app/assignment-enrollment')).toBe(id);
        for (const value of [returned + '&workspace=0', returned + '&workspace=1&workspace=1', returned + '&workspace=1&x=1',
            returned + '&workspace=1#x', '/assignment/work-return?workspace=1&attempt=' + id])
            expect(app.workReturnAttempt(value)).toBeNull();
        expect(app.workReturnAttempt('/app/assignment-enrollment?attempt=' + id + '&workspace=1', '/app/assignment-enrollment')).toBeNull();
    });
});

describe('framing policy for the embedded assignment Code entry', () => {
    const entry = '/app/code?repo=' + encodeURIComponent(repo) + '&assignment=' + id;
    it.each(pairs)('lets only the paired Universe origin frame the exact canonical entry on %s', (os, universe) => {
        const at = (path: string) => new URL(path, os);
        expect(app.assignmentEmbedFramePolicy(os, at(entry))).toBe('frame-ancestors ' + universe);
        expect(app.assignmentEmbedFramePolicy(os, at(entry + '&computer=11111111-1111-4111-8111-111111111111'))).toBe('frame-ancestors ' + universe);
    });
    it.each([
        ['os-prod', 'https://os-prod.ezil.work', entry],
        ['the landing host', 'https://os.ezil.org', entry],
        ['Universe itself', prodUniverse, entry],
        ['plain HTTP', 'http://os.ezil.work', entry],
        ['plain Code', prodOs, '/app/code'],
        ['ordinary repository', prodOs, '/app/code?repo=' + encodeURIComponent('https://github.ezil.work/default/ordinary.git')],
        ['the desktop', prodOs, '/os?repo=' + encodeURIComponent(repo) + '&assignment=' + id],
        ['another app', prodOs, '/app/browser?repo=' + encodeURIComponent(repo) + '&assignment=' + id],
        ['a mismatched attempt', prodOs, entry.replace('assignment=' + id, 'assignment=11111111-1111-4111-8111-111111111111')],
        ['a duplicated repository', prodOs, entry + '&repo=' + encodeURIComponent(repo)],
        ['a duplicated assignment', prodOs, entry + '&assignment=' + id],
        ['an attempt parameter', prodOs, entry + '&attempt=' + id],
        ['no assignment', prodOs, '/app/code?repo=' + encodeURIComponent(repo)],
        ['a prototype key', '__proto__', entry],
    ])('adds no policy for %s', (_name, origin, path) => {
        expect(app.assignmentEmbedFramePolicy(origin, new URL(path, prodOs))).toBeNull();
    });
});
