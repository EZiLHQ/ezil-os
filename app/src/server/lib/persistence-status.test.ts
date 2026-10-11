import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    classifyWorkerHttpFailure,
    CORRELATION_HEADER,
    isRetryablePreviewErrorCode,
    mintSandboxPreviewToken,
    requestGuacamolePreview,
    requestPersistenceStatus,
    surfacePreviewErrorAsValue,
    type CloudflareGuacamoleConfig,
    type PersistenceStatus,
} from './cloudflare-guacamole-provider';

const CONFIG: CloudflareGuacamoleConfig = {
    workerUrl: 'https://worker.example.test/',
    hasHmacSecret: true,
    isConfigured: true,
};
const SECRET = 'test-only-hmac-secret';
const STATUS: PersistenceStatus = {
    system: { code: 'unchanged', outcome: 'ok', committedAgeS: 0 },
    workspace: { code: 'too_large', outcome: 'skipped', committedAgeS: null },
    savingPaused: true,
    pausedLayer: 'workspace',
    pausedReason: 'too_large',
    lastStopDiscardedUnsaved: false,
};

function stubResponse(body: unknown, status = 200) {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
}

function readStatus() {
    return requestPersistenceStatus(CONFIG, SECRET, 'sandbox/name with spaces', 'test-correlation');
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('requestPersistenceStatus', () => {
    it('returns valid metadata over a signed, uncached GET with a 30 second timeout', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
        const fetchSpy = stubResponse({ ok: true, status: STATUS });

        expect(await readStatus()).toEqual({ ok: true, status: STATUS });
        expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
            'https://worker.example.test/sandbox/sandbox%2Fname%20with%20spaces/persistence',
            {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${mintSandboxPreviewToken(SECRET)}`,
                    'Content-Type': 'application/json',
                    [CORRELATION_HEADER]: 'test-correlation',
                },
                signal: expect.any(AbortSignal),
                cache: 'no-store',
            },
        );
        expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(30_000);
    });

    it('ignores extra keys at every level without forwarding them', async () => {
        stubResponse({
            ok: true, extra: 'ignored',
            status: {
                ...STATUS, extra: 'ignored',
                system: { ...STATUS.system, extra: 'ignored' },
                workspace: { ...STATUS.workspace, extra: 'ignored' },
            },
        });
        expect(await readStatus()).toEqual({ ok: true, status: STATUS });
    });

    it.each([
        { code: 'a'.repeat(64), outcome: 'error', committedAgeS: Number.MAX_SAFE_INTEGER },
        { code: 'future_code_123', outcome: 'skipped', committedAgeS: null },
    ])('accepts boundary values and future valid codes: %j', async (layer) => {
        const status = { ...STATUS, system: layer, workspace: layer };
        stubResponse({ ok: true, status });
        expect(await readStatus()).toEqual({ ok: true, status });
    });

    it.each([
        [false, null, null, true],
        [true, 'system', 'stale', false],
        [true, 'system', 'not_restored', true],
    ])('accepts pause metadata %j/%j/%j/%j', async (savingPaused, pausedLayer, pausedReason, lastStopDiscardedUnsaved) => {
        const status = { ...STATUS, savingPaused, pausedLayer, pausedReason, lastStopDiscardedUnsaved };
        stubResponse({ ok: true, status });
        expect(await readStatus()).toEqual({ ok: true, status });
    });

    describe.each(['system', 'workspace'] as const)('%s validation', (layer) => {
        const invalidFields: [string, unknown][] = [
            ...[undefined, null, 1, '', 'A', 'bad-code', 'with space', 'a'.repeat(65)].map(value => ['code', value] as [string, unknown]),
            ...[undefined, null, 1, true, '', 'success', 'OK'].map(value => ['outcome', value] as [string, unknown]),
            ...[undefined, '0', false, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(value => ['committedAgeS', value] as [string, unknown]),
        ];
        it.each(invalidFields)('rejects malformed %s = %j', async (field, value) => {
            stubResponse({ ok: true, status: { ...STATUS, [layer]: { ...STATUS[layer], [field]: value } } });
            expect(await readStatus()).toEqual({ ok: false, error: 'persistence_status_invalid' });
        });

        it.each([undefined, null, [], 'layer', 1].map(value => ({ value })))('rejects a malformed layer: %j', async ({ value }) => {
            stubResponse({ ok: true, status: { ...STATUS, [layer]: value } });
            expect(await readStatus()).toEqual({ ok: false, error: 'persistence_status_invalid' });
        });

        it.each([NaN, Infinity, -Infinity])('rejects a non-finite age: %j', async (value) => {
            // JSON serializes non-finite numbers as null; use a decoded-body
            // mock to exercise the validator without accidentally testing null.
            vi.stubGlobal('fetch', vi.fn(async () => ({
                ok: true,
                json: async () => ({ ok: true, status: { ...STATUS, [layer]: { ...STATUS[layer], committedAgeS: value } } }),
            })));
            expect(await readStatus()).toEqual({ ok: false, error: 'persistence_status_invalid' });
        });
    });

    const invalidStatusFields: [string, unknown][] = [
        ...[undefined, null, 0, 'true'].map(value => ['savingPaused', value] as [string, unknown]),
        ...[undefined, '', 'both', false, 1].map(value => ['pausedLayer', value] as [string, unknown]),
        ...[undefined, '', 'failed', false, 1].map(value => ['pausedReason', value] as [string, unknown]),
        ...[undefined, null, 0, 'false'].map(value => ['lastStopDiscardedUnsaved', value] as [string, unknown]),
    ];
    it.each(invalidStatusFields)('rejects malformed %s = %j', async (field, value) => {
        stubResponse({ ok: true, status: { ...STATUS, [field]: value } });
        expect(await readStatus()).toEqual({ ok: false, error: 'persistence_status_invalid' });
    });

    it.each([null, [], {}, { ok: 'true', status: STATUS }, { ok: true }, { ok: true, status: null }, { ok: true, status: [] }].map(body => ({ body })))(
        'rejects a malformed success envelope: %j', async ({ body }) => {
            stubResponse(body);
            expect(await readStatus()).toEqual({ ok: false, error: 'persistence_status_invalid' });
        },
    );

    it('rejects invalid JSON', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('not json')));
        expect(await readStatus()).toEqual({ ok: false, error: 'persistence_status_invalid' });
    });

    it.each([200, 503])('preserves worker errors on HTTP %i', async (status) => {
        stubResponse({ ok: false, error: 'sandbox_not_found' }, status);
        expect(await readStatus()).toEqual({ ok: false, error: 'sandbox_not_found' });
    });

    it.each([null, {}, { ok: true, status: STATUS }, { ok: false, error: 42 }])('reports unavailable for an HTTP failure without a worker error: %j', async (body) => {
        stubResponse(body, 503);
        expect(await readStatus()).toEqual({ ok: false, error: 'persistence_status_unavailable' });
    });

    it('reports unavailable when fetch throws', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
        expect(await readStatus()).toEqual({ ok: false, error: 'persistence_status_unavailable' });
    });

    it('reports unavailable when the response body cannot be read', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => { throw new Error('connection closed'); },
        })));
        expect(await readStatus()).toEqual({ ok: false, error: 'persistence_status_unavailable' });
    });
});

describe.each([
    ['workspace_persistence_unavailable', false, 'Workspace saving is unavailable. Please contact support before reopening your computer.'],
    ['workspace_checkpoint_failed', true, 'Your workspace could not be saved. Please try opening your computer again.'],
] as const)('preview persistence failure %s', (errorCode, retryable, message) => {
    it('classifies the 503 body and preserves the code through the router policy', () => {
        expect(classifyWorkerHttpFailure(503, JSON.stringify({ ok: false, error: errorCode }))).toBe(errorCode);
        expect(isRetryablePreviewErrorCode(errorCode)).toBe(retryable);
        expect(surfacePreviewErrorAsValue(errorCode, retryable)).toBe(true);
    });

    it.each([200, 503])('returns its own code, retry policy and readable message on HTTP %i', async (status) => {
        stubResponse({ ok: false, error: errorCode }, status);
        expect(await requestGuacamolePreview(CONFIG, SECRET, {
            sessionId: '00000000-0000-4000-8000-000000000001',
            userId: '00000000-0000-4000-8000-000000000002',
            projectId: '00000000-0000-4000-8000-000000000003',
            desktopMode: 'neko',
        }, 'test-correlation')).toEqual({ ok: false, error: message, errorCode, retryable });
    });
});
