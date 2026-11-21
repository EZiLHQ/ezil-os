import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginInferenceActivity, INFERENCE_ACTIVITY_REFRESH_MS } from '../src/inference-activity';
import { gatewayChat } from '../src/gateway';
import { KIMI } from '../src/gateway-messages';
import { ask, gw } from './fixtures/gateway';
import { messageJson } from './fixtures/gateway-response';

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'ezil-ai-activity-test-'));
    temporary.push(root);
    return { root, directory: join(root, 'activity'), target: join(root, 'unrelated') };
}

describe.skipIf(process.platform !== 'linux')('Linux inference marker', () => {
    test('leases are empty, private and independent, and abort removes only its own file', () => {
        const { directory } = fixture();
        const first = new AbortController(), second = new AbortController();
        const endFirst = beginInferenceActivity(first.signal, directory);
        let endSecond: (() => void) | undefined;
        try {
            expect(endFirst).toBeFunction();
            const [firstName] = readdirSync(directory);
            endSecond = beginInferenceActivity(second.signal, directory);
            expect(endSecond).toBeFunction();
            expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
            const names = readdirSync(directory);
            expect(names).toHaveLength(2);
            for (const name of names) {
                expect(name).toMatch(new RegExp(`^${process.pid}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`));
                const stat = lstatSync(join(directory, name));
                expect(stat.isFile()).toBe(true);
                expect(stat.mode & 0o7777).toBe(0o600);
                expect(stat.size).toBe(0);
            }
            first.abort();
            expect(readdirSync(directory)).toEqual(names.filter(name => name !== firstName));
            endFirst?.();
            endSecond?.();
            expect(readdirSync(directory)).toEqual([]);
            expect(beginInferenceActivity(first.signal, directory)).toBeUndefined();
            expect(readdirSync(directory)).toEqual([]);
        } finally { endFirst?.(); endSecond?.(); }
    });

    test('refreshes its held inode on the 15-second timer and cannot touch a replacement symlink', () => {
        const { directory, target } = fixture();
        let renew: () => void = () => { throw new Error('renewal was not registered'); };
        const timer = { unref: mock(() => {}) };
        const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number) => {
            expect(ms).toBe(15_000);
            renew = callback;
            return timer;
        }) as unknown as typeof setInterval);
        const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
        const end = beginInferenceActivity(new AbortController().signal, directory);
        try {
            expect(end).toBeFunction();
            expect(INFERENCE_ACTIVITY_REFRESH_MS).toBe(15_000);
            expect(timer.unref).toHaveBeenCalledTimes(1);
            const path = join(directory, readdirSync(directory)[0]!);
            const expired = new Date(Date.now() - 120_000);
            utimesSync(path, expired, expired);
            renew();
            expect(statSync(path).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
            writeFileSync(target, 'untouched outside the marker');
            utimesSync(target, expired, expired);
            const before = statSync(target).mtimeMs;
            unlinkSync(path);
            symlinkSync(target, path);
            renew();
            end?.();
            renew();
            expect(statSync(target).mtimeMs).toBe(before);
            expect(lstatSync(path).isSymbolicLink()).toBe(true);
            expect(clear).toHaveBeenCalledTimes(1);
            expect(clear).toHaveBeenCalledWith(timer);
        } finally { end?.(); interval.mockRestore(); clear.mockRestore(); }
    });

    test('refuses a symlink or nonprivate directory without creating an activity file', () => {
        const { directory, target } = fixture();
        const signal = new AbortController().signal;
        mkdirSync(target, { mode: 0o700 });
        symlinkSync(target, directory);
        expect(beginInferenceActivity(signal, directory)).toBeUndefined();
        expect(readdirSync(target)).toEqual([]);
        unlinkSync(directory);
        mkdirSync(directory, { mode: 0o755 });
        chmodSync(directory, 0o755);
        expect(beginInferenceActivity(signal, directory)).toBeUndefined();
        expect(readdirSync(directory)).toEqual([]);
    });

    test('a setup failure closes both descriptors and removes the incomplete lease', () => {
        const { directory } = fixture();
        const interval = spyOn(globalThis, 'setInterval').mockImplementation(
            (() => { throw new Error('injected timer failure'); }) as unknown as typeof setInterval);
        try { expect(beginInferenceActivity(new AbortController().signal, directory)).toBeUndefined(); }
        finally { interval.mockRestore(); }
        expect(readdirSync(directory)).toEqual([]);
        const found = readdirSync('/proc/self/fd').some(name => {
            try { return readlinkSync(`/proc/self/fd/${name}`).startsWith(directory); } catch { return false; }
        });
        expect(found).toBe(false);
    });

    test('a retry releases its marker before backoff and the final Kimi reply clears the second marker', async () => {
        const { directory } = fixture();
        let sends = 0;
        const found: string[] = [];
        const controller = new AbortController();
        const fetch = (async () => {
            sends++;
            const names = readdirSync(directory);
            expect(names).toHaveLength(1);
            found.push(names[0]!);
            return sends === 1 ? Response.json({ error: { code: 'rate_limited' } }, { status: 429 })
                : Response.json(messageJson());
        }) as unknown as typeof globalThis.fetch;
        const sleep = mock(async () => { expect(readdirSync(directory)).toEqual([]); });
        try {
            for await (const part of gatewayChat(gw(KIMI), ask(), { signal: controller.signal, fetch, sleep,
                onInferenceStart: () => beginInferenceActivity(controller.signal, directory) })) {
                if (part.type === 'text') expect(readdirSync(directory)).toHaveLength(1);
            }
            expect(sends).toBe(2);
            expect(sleep).toHaveBeenCalledTimes(1);
            expect(new Set(found).size).toBe(2);
            expect(readdirSync(directory)).toEqual([]);
        } finally { controller.abort(); }
    });

    test('inference failures clean up, and a locally rejected request never creates a marker', async () => {
        const { directory } = fixture();
        const signal = new AbortController().signal;
        const doFetch = mock(async () => Response.json({ error: { code: 'upstream_timeout' } }, { status: 504 }));
        const run = async (options = {}) => {
            for await (const _ of gatewayChat(gw(KIMI), { ...ask(), modelOptions: options }, {
                signal, fetch: doFetch as unknown as typeof fetch,
                onInferenceStart: () => beginInferenceActivity(signal, directory),
            })) { /* Drain the request. */ }
        };
        await expect(run({ maxTokens: 0 })).rejects.toThrow();
        expect(existsSync(directory)).toBe(false);
        expect(doFetch).not.toHaveBeenCalled();
        await expect(run()).rejects.toThrow();
        expect(doFetch).toHaveBeenCalledTimes(1);
        expect(readdirSync(directory)).toEqual([]);
    });
});
