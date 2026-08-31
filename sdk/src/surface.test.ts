/**
 * Drift guard: this package's hand-written surface, against the real routers.
 *
 * `src/types.ts` and `src/client.ts` describe the server's API without
 * importing it, so that this package can stand alone. That is a deliberate
 * trade, and this test is the other half of it: it reads
 * `app/src/server/api/routers/*.ts` and fails if the SDK calls a procedure the
 * server does not have, or if the server grows one nobody decided about.
 *
 * The second half matters more than it looks. A silently-uncovered procedure is
 * how an SDK ends up describing a version of the product that no longer exists.
 * `KNOWN_UNCOVERED` is therefore a list of DECISIONS, not a backlog — adding to
 * it should feel like a choice, because it is one.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTERS = join(import.meta.dir, '../../app/src/server/api/routers');
const CLIENT = join(import.meta.dir, 'client.ts');

/** Procedure keys declared in one router file, e.g. `list: protectedProcedure`. */
const proceduresIn = (file: string): string[] => {
    const src = readFileSync(join(ROUTERS, file), 'utf8');
    return [...src.matchAll(/^\s{4}([a-zA-Z][\w]*):\s*(?:protectedProcedure|publicProcedure)/gm)].map((m) => m[1]!);
};

/** Every `'router.procedure'` string the client actually calls. */
const pathsCalledByClient = (): string[] => {
    const src = readFileSync(CLIENT, 'utf8');
    return [
        ...new Set(
            [...src.matchAll(/\b(?:query|mutate)(?:<[^>]*>)?\(\s*'([a-zA-Z]\w*\.\w+)'/g)].map((m) => m[1]!),
        ),
    ].sort();
};

const serverSurface = (): Set<string> => {
    const all = new Set<string>();
    for (const p of proceduresIn('computer.ts')) all.add(`computer.${p}`);
    for (const p of proceduresIn('cloudflare-guacamole.ts')) all.add(`cloudflareGuacamole.${p}`);
    return all;
};

/**
 * Server procedures this SDK deliberately does not expose, and why.
 * These are the shell's own plumbing: they exist to serve the in-browser
 * desktop, and a third-party client has no coherent use for them.
 */
const KNOWN_UNCOVERED: Record<string, string> = {
    'computer.touch': 'stamps lastOpenedAt for the /computer/<id> route; not a third-party concern',
    'cloudflareGuacamole.confirmFrame': 'the shell confirming its own iframe painted',
    'cloudflareGuacamole.confirmDisplay': 'the shell confirming a stream is live',
    'cloudflareGuacamole.focusApp': 'foregrounds an app in the X session; drives the in-stream switcher',
    'cloudflareGuacamole.getScreen': 'stream geometry, owned by the shell',
    'cloudflareGuacamole.setScreen': 'stream geometry, owned by the shell',
    'cloudflareGuacamole.reportActivity': 'the shell\'s presence heartbeat against the idle reaper',
};

describe('SDK surface vs. the real routers', () => {
    it('finds the routers and parses procedures out of them', () => {
        expect(proceduresIn('computer.ts').length).toBeGreaterThan(0);
        expect(proceduresIn('cloudflare-guacamole.ts').length).toBeGreaterThan(0);
    });

    it('calls at least one procedure per namespace', () => {
        const called = pathsCalledByClient();
        expect(called.some((p) => p.startsWith('computer.'))).toBe(true);
        expect(called.some((p) => p.startsWith('cloudflareGuacamole.'))).toBe(true);
    });

    // 🔴 A path the server does not have is a method that throws for every
    // caller, and nothing else in this package would catch it.
    it('never calls a procedure the server does not have', () => {
        const server = serverSurface();
        const bogus = pathsCalledByClient().filter((p) => !server.has(p));
        expect(bogus).toEqual([]);
    });

    // 🔴 The half that actually rots. A new procedure lands on the server and
    // the SDK silently keeps describing the old product.
    it('accounts for every server procedure — covered, or deliberately not', () => {
        const called = new Set(pathsCalledByClient());
        const unaccounted = [...serverSurface()]
            .filter((p) => !called.has(p) && !(p in KNOWN_UNCOVERED))
            .sort();
        expect(unaccounted).toEqual([]);
    });

    it('has no stale entries in KNOWN_UNCOVERED', () => {
        const server = serverSurface();
        const stale = Object.keys(KNOWN_UNCOVERED).filter((p) => !server.has(p)).sort();
        expect(stale).toEqual([]);
    });

    it('does not list a procedure as both covered and deliberately uncovered', () => {
        const called = new Set(pathsCalledByClient());
        expect(Object.keys(KNOWN_UNCOVERED).filter((p) => called.has(p))).toEqual([]);
    });
});
