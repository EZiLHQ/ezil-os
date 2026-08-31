/**
 * The tools, called directly with a stub client.
 *
 * Two properties matter more than the happy paths here: a destructive tool must
 * refuse without explicit confirmation, and a failure must come back as advice
 * a MODEL can act on rather than a stack trace it will blindly retry.
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { EzilError, type Computer, type EzilClient } from '@ezil-os/sdk';

import { buildTools, describeError } from './tools';

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
        for (const name of ['open_desktop', 'open_editor', 'open_app_preview']) {
            expect(t[name]!.config.description).toContain('five minutes');
        }
    });

    it('warns that open_desktop is a cold boot', () => {
        expect(byName(stubClient()).open_desktop!.config.description).toMatch(/COLD BOOT/);
    });

    it('warns that restart does not pick up a new image', () => {
        expect(byName(stubClient()).restart_desktop!.config.description).toMatch(/does NOT pick up a new container image/);
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
