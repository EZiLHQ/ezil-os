/**
 * The tools, called directly with a stub client.
 *
 * Two properties matter more than the happy paths here: a destructive tool must
 * refuse without explicit confirmation, and a failure must come back as advice
 * a MODEL can act on rather than a stack trace it will blindly retry.
 */
import { describe, expect, it } from 'bun:test';
import superjson from 'superjson';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EzilError, type Computer, type EzilClient } from '@ezil-os/sdk';

import { createServer } from './server';
import { BROWSER_ALIASES, buildTools, describeError } from './tools';

const COMPUTER = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'u1',
    name: 'Studio',
    slot: 1,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    lastOpenedAt: null,
    deletedAt: null,
    metadata: null,
} as Computer;

const stubClient = (over: Record<string, unknown> = {}): EzilClient => {
    const calls: string[] = [];
    const rec = <T>(name: string, value: T) => async (...args: unknown[]) => {
        calls.push(`${name}(${args.filter((a) => a !== undefined).map(String).join(',')})`);
        if (typeof value === 'function') return (value as (...a: unknown[]) => unknown)(...args);
        return value;
    };
    const client = {
        calls,
        computers: {
            list: rec('list', [COMPUTER]),
            get: rec('get', COMPUTER),
            create: rec('create', COMPUTER),
            getOrCreateDefault: rec('getOrCreateDefault', COMPUTER),
            rename: rec('rename', { ...COMPUTER, name: 'Renamed' }),
            delete: rec('delete', { id: COMPUTER.id }),
        },
        desktop: {
            status: rec('status', { ok: true, running: false }),
            open: rec('open', { ok: true, url: 'https://desktop.example/x?token=abc' }),
            appPreviewUrl: rec('appPreviewUrl', { ok: true, url: 'https://app.example' }),
            codeUrl: rec('codeUrl', { ok: true, url: 'https://code.example' }),
            restart: rec('restart', { ok: true }),
            terminate: rec('terminate', { ok: true }),
        },
        isConfigured: rec('isConfigured', { configured: true }),
        ...over,
    };
    return client as unknown as EzilClient;
};

const byName = (client: EzilClient) => Object.fromEntries(buildTools(client).map((t) => [t.name, t]));

describe('tools', () => {
    it('exposes computer-lifecycle tools and NO browser automation', () => {
        const names = buildTools(stubClient()).map((t) => t.name);
        expect(names).toContain('list_computers');
        expect(names).toContain('open_desktop');
        // 🔴 That surface belongs to ezil-works-browser, over a pinned contract.
        // Two servers exposing the same verbs is how one contract becomes two.
        for (const forbidden of ['navigate', 'click', 'type', 'snapshot', 'screenshot', 'evaluate']) {
            expect(names.some((n) => n.includes(forbidden))).toBe(false);
        }
    });

    it('gives every tool a title, a description and annotations', () => {
        for (const t of buildTools(stubClient())) {
            expect(t.config.title.length).toBeGreaterThan(0);
            expect(t.config.description.length).toBeGreaterThan(20);
            expect(t.config.annotations).toBeDefined();
        }
    });

    it('marks read-only tools read-only and destructive tools destructive', () => {
        const t = byName(stubClient());
        expect(t.list_computers!.config.annotations.readOnlyHint).toBe(true);
        expect(t.desktop_status!.config.annotations.readOnlyHint).toBe(true);
        expect(t.delete_computer!.config.annotations.destructiveHint).toBe(true);
        expect(t.restart_desktop!.config.annotations.destructiveHint).toBe(true);
        expect(t.open_desktop!.config.annotations.readOnlyHint).not.toBe(true);
    });

    it('lists computers as JSON the model can read', async () => {
        const res = await byName(stubClient()).list_computers!.handler({});
        const parsed = JSON.parse(res.content[0]!.text) as { id: string; everOpened: boolean }[];
        expect(parsed[0]!.id).toBe(COMPUTER.id);
        expect(parsed[0]!.everOpened).toBe(false);
    });

    it('says what to do next when the user has no computers, instead of returning []', async () => {
        const client = stubClient({ computers: { ...stubClient().computers, list: async () => [] } });
        const res = await byName(client).list_computers!.handler({});
        expect(res.content[0]!.text).toContain('create_computer');
    });

    // 🔴 The tool that can destroy a user's machine must not fire on a model's
    // enthusiasm alone.
    it('refuses to delete without explicit confirmation', async () => {
        const t = byName(stubClient()).delete_computer!;
        const res = await t.handler({ computerId: COMPUTER.id });
        expect(res.isError).toBe(true);
        expect(res.content[0]!.text).toContain('confirm');
    });

    it('deletes when confirmation is explicit', async () => {
        const res = await byName(stubClient()).delete_computer!.handler({ computerId: COMPUTER.id, confirm: true });
        expect(res.isError).toBeUndefined();
        expect(res.content[0]!.text).toContain('deleted');
    });

    it('requires confirm to be literally true in the schema, not merely truthy', () => {
        const schema = byName(stubClient()).delete_computer!.config.inputSchema!;
        const confirm = schema.confirm as unknown as z.ZodType;
        expect(confirm.safeParse(true).success).toBe(true);
        expect(confirm.safeParse('yes').success).toBe(false);
        expect(confirm.safeParse(1).success).toBe(false);
    });

    it('warns about the five-minute TTL on every tool that mints a URL', () => {
        const t = byName(stubClient());
        for (const name of ['open_desktop', 'open_browser', 'open_editor', 'open_app_preview']) {
            expect(t[name]!.config.description).toContain('five minutes');
        }
    });

    it('warns that open_desktop / open_browser is a cold boot', () => {
        const t = byName(stubClient());
        expect(t.open_desktop!.config.description).toMatch(/COLD BOOT/);
        expect(t.open_browser!.config.description).toMatch(/COLD BOOT/);
    });

    it('warns that restart does not pick up a new image', () => {
        const t = byName(stubClient());
        expect(t.restart_desktop!.config.description).toMatch(/does NOT pick up a new container image/);
        expect(t.restart_browser!.config.description).toMatch(/does NOT pick up a new container image/);
    });
});

describe('browser_* aliases (browser verbs v2, §4)', () => {
    const PAIRS = [
        ['desktop_status', 'browser_status'],
        ['open_desktop', 'open_browser'],
        ['restart_desktop', 'restart_browser'],
    ] as const;

    it('adds exactly the three aliases and keeps every old name', () => {
        const names = buildTools(stubClient()).map((t) => t.name);
        expect(BROWSER_ALIASES).toEqual(Object.fromEntries(PAIRS));
        for (const [base, alias] of PAIRS) {
            expect(names).toContain(base);
            expect(names).toContain(alias);
            // Listed right after the tool it names.
            expect(names.indexOf(alias)).toBe(names.indexOf(base) + 1);
        }
        expect(names).toHaveLength(13);
        expect(new Set(names).size).toBe(names.length);
    });

    it('an alias SHARES its base tool\'s handler, input schema and annotations (same objects)', () => {
        const t = byName(stubClient());
        for (const [base, alias] of PAIRS) {
            expect(t[alias]!.handler).toBe(t[base]!.handler);
            expect(t[alias]!.config.inputSchema).toBe(t[base]!.config.inputSchema);
            expect(t[alias]!.config.annotations).toBe(t[base]!.config.annotations);
        }
        // So the read-only / destructive hints carry over exactly.
        expect(t.browser_status!.config.annotations.readOnlyHint).toBe(true);
        expect(t.restart_browser!.config.annotations.destructiveHint).toBe(true);
        expect(t.open_browser!.config.annotations.readOnlyHint).not.toBe(true);
    });

    it('titles and descriptions say Browser; each alias description names the old tool', () => {
        const t = byName(stubClient());
        for (const [base, alias] of PAIRS) {
            for (const name of [base, alias]) {
                expect(t[name]!.config.title).toContain('Browser');
                expect(t[name]!.config.description).toContain('Browser');
            }
            expect(t[alias]!.config.title).toBe(t[base]!.config.title);
            expect(t[alias]!.config.description).toContain(`Same tool as ${base}, its older name.`);
            expect(t[base]!.config.description).not.toContain('Same tool as');
        }
    });

    it('calling an alias reaches the same client method with the same answer', async () => {
        const id = COMPUTER.id;
        for (const [base, alias, method] of [
            ['desktop_status', 'browser_status', 'status'],
            ['open_desktop', 'open_browser', 'open'],
            ['restart_desktop', 'restart_browser', 'restart'],
        ] as const) {
            const viaBase = stubClient();
            const viaAlias = stubClient();
            const a = await byName(viaBase)[base]!.handler({ computerId: id });
            const b = await byName(viaAlias)[alias]!.handler({ computerId: id });
            expect(b).toEqual(a);
            expect((viaAlias as unknown as { calls: string[] }).calls).toEqual([`${method}(${id})`]);
        }
    });

    it('an alias is lifecycle, not automation: its schema is the computer id alone', () => {
        const t = byName(stubClient());
        for (const [, alias] of PAIRS) {
            expect(Object.keys(t[alias]!.config.inputSchema ?? {})).toEqual(['computerId']);
        }
    });

    // The registration itself, over a REAL MCP client and transport: an alias
    // whose schema object is shared with its base must still register, list
    // and answer. Only `fetch` is stubbed.
    it('registers and answers over a real MCP transport', async () => {
        const seen: string[] = [];
        const fetchImpl = (async (url: string | URL) => {
            const path = new URL(String(url)).pathname.replace('/api/trpc/', '');
            seen.push(path);
            const data = path === 'cloudflareGuacamole.status' ? { ok: true, running: true } : { ok: true };
            return new Response(JSON.stringify({ result: { data: superjson.serialize(data) } }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        }) as unknown as typeof globalThis.fetch;
        const server = createServer({ baseUrl: 'https://ezil.example', token: 'tok', timeoutMs: 5000 }, fetchImpl);
        const client = new Client({ name: 'alias-harness', version: '0.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        try {
            const { tools } = await client.listTools();
            const names = tools.map((t) => t.name);
            for (const [base, alias] of PAIRS) {
                expect(names).toContain(base);
                expect(names).toContain(alias);
                const a = tools.find((t) => t.name === alias)!;
                const b = tools.find((t) => t.name === base)!;
                expect(a.inputSchema).toEqual(b.inputSchema);
                expect(a.annotations).toEqual(b.annotations);
            }
            const res = await client.callTool({ name: 'browser_status', arguments: { computerId: COMPUTER.id } });
            expect(res.isError).toBeFalsy();
            expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toEqual({ ok: true, running: true });
            expect(seen).toEqual(['cloudflareGuacamole.status']);
            const bad = await client.callTool({ name: 'open_browser', arguments: { computerId: 'not-a-uuid' } });
            expect(bad.isError).toBe(true);
            expect(seen).toEqual(['cloudflareGuacamole.status']);
        } finally {
            await server.close();
        }
    });
});

describe('describeError', () => {
    it('tells the model that retrying an auth failure is pointless', () => {
        const res = describeError(new EzilError('no session', { code: 'UNAUTHORIZED', status: 401 }));
        expect(res.isError).toBe(true);
        expect(res.content[0]!.text).toContain('will not help');
    });

    it('points a not-found at list_computers rather than at a retry', () => {
        const res = describeError(new EzilError('gone', { code: 'NOT_FOUND', status: 404 }));
        expect(res.content[0]!.text).toContain('list_computers');
    });

    // 🔴 A timeout during a cold boot does NOT mean the boot failed. Retrying
    // boots a second container.
    it('tells the model to poll rather than re-open after a timeout', () => {
        const res = describeError(new EzilError('computer.list timed out after 300000ms', { path: 'computer.list' }));
        expect(res.content[0]!.text).toContain('desktop_status');
        expect(res.content[0]!.text).toContain('second time');
    });

    it('never leaks a raw non-EzilError as a success', () => {
        const res = describeError(new Error('kaboom'));
        expect(res.isError).toBe(true);
    });

    it('turns a thrown client error into an isError result rather than propagating', async () => {
        const client = stubClient({
            computers: {
                ...stubClient().computers,
                list: async () => { throw new EzilError('nope', { code: 'UNAUTHORIZED', status: 401 }); },
            },
        });
        const res = await byName(client).list_computers!.handler({});
        expect(res.isError).toBe(true);
    });
});
