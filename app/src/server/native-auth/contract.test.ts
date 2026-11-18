import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    NATIVE_INSTRUCTION_MAX_BYTES, checkInstruction, isWellFormedUnicode, matchNativeRestRoute, nativeConsentTermsConfig, nativeInstructionDigest,
    nativeIntentInputDigest,
    nativeRestInputHash, nativeRestTranscript, nativeTaskRef, parseNativeIntentBody,
} from './contract';

const OP = '22222222-2222-4222-8222-222222222222';
const SESSION = '11111111-1111-4111-8111-111111111111';
const COMPUTER = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://os-staging.ezil.work';
const create = (instruction: string, extra: Record<string, unknown> = {}) => ({
    kind: 'create', operationId: OP, sessionId: SESSION, computerId: COMPUTER, instructionRevision: 1,
    instructionDigest: isWellFormedUnicode(instruction) ? nativeInstructionDigest(instruction) : `sha256:${'0'.repeat(64)}`, instruction, ...extra,
});

/** Root-pinned vectors (work/native-rest-v1-vectors.json, sha256 9aab04d5…bd0), copied verbatim. */
const VECTORS = [
    { method: 'GET', pathname: `/api/mcp/native-auth-intents/${OP}`, rawBody: '',
        sha256Hex: '28f3f759aec08a27752c188661e542ff5e15aef96bef8dc7c5bbe02ef71e7ec1', inp: 'KPP3Wa7Aiid1LBiGYeVC_14Vrvlr743HxbvgLvcefsE' },
    { method: 'GET', pathname: `/api/mcp/native-sessions/${SESSION}`, rawBody: '',
        sha256Hex: '4e701b37e115fdd8c52a81dab6da9ffb0bcd39c31a623d79bc55cc5b30810541', inp: 'TnAbN-EV_djFKoHattqf-wvNOcMaYj15vFXMWzCBBUE' },
    { method: 'POST', pathname: '/api/mcp/native-auth-intents',
        rawBody: '{"kind":"create","operationId":"22222222-2222-4222-8222-222222222222","sessionId":"11111111-1111-4111-8111-111111111111","computerId":"33333333-3333-4333-8333-333333333333","instructionRevision":1,"instructionDigest":"sha256:79a8924631d435fa4b3c887f6cf1db91527191a15f296ff3c102179524501898","instruction":"Build a café\\n"}',
        sha256Hex: '20ba8d3708874edea0732007d4049a5805f3a4a99726c1dd9db8a91677ea8af4', inp: 'ILqNNwiHTt6gcyAH1ASaWAXzpKmXJsHdnbipFnfqivQ', wireBodyBytes: 323 },
] as const;

describe('signed REST transcript (root vectors)', () => {
    it('reproduces every pinned vector byte for byte, with real line feeds and the GET path bound', () => {
        for (const v of VECTORS) {
            const route = matchNativeRestRoute(v.method, `${ORIGIN}${v.pathname}`);
            expect(route, v.pathname).not.toBeNull();
            const transcript = nativeRestTranscript(route!, v.rawBody);
            expect(transcript.split('\n').slice(0, 3)).toEqual(['EZIL-NATIVE-REST/1', v.method, v.pathname]);
            expect(transcript).not.toContain('\\n\\n');
            expect(createHash('sha256').update(Buffer.from(transcript, 'utf8')).digest('hex')).toBe(v.sha256Hex);
            expect(nativeRestInputHash(transcript)).toBe(v.inp);
        }
        const post = VECTORS[2];
        expect(Buffer.byteLength(post.rawBody, 'utf8')).toBe(post.wireBodyBytes);
        // The POST vector's instruction digest is the exact UTF-8 digest of "Build a café\n".
        const parsed = parseNativeIntentBody(JSON.parse(post.rawBody));
        expect(parsed).toMatchObject({ ok: true, input: { instruction: 'Build a café\n' } });
        // A GET is never the hash of an empty body: two GET paths give different inputs.
        expect(VECTORS[0].inp).not.toBe(VECTORS[1].inp);
        expect(VECTORS[0].inp).not.toBe(createHash('sha256').update('').digest('base64url'));
    });

    it('changes the bound input when the method, path id or body is tampered', () => {
        const base = nativeRestInputHash(nativeRestTranscript({ method: 'POST', pathname: '/api/mcp/native-auth-intents' }, VECTORS[2].rawBody));
        expect(nativeRestInputHash(nativeRestTranscript({ method: 'POST', pathname: '/api/mcp/native-auth-intents' }, `${VECTORS[2].rawBody} `))).not.toBe(base);
        expect(nativeRestInputHash(nativeRestTranscript({ method: 'GET', pathname: `/api/mcp/native-auth-intents/${OP}` }, '')))
            .not.toBe(nativeRestInputHash(nativeRestTranscript({ method: 'GET', pathname: `/api/mcp/native-auth-intents/${SESSION}` }, '')));
        expect(() => nativeRestTranscript({ method: 'GET', pathname: `/api/mcp/native-auth-intents/${OP}` }, 'x')).toThrow();
    });

    it('matches only the three fixed routes, refusing query, fragment, encoding, case, trailing slash and wrong methods', () => {
        expect(matchNativeRestRoute('POST', `${ORIGIN}/api/mcp/native-auth-intents`)).toMatchObject({ procedure: 'nativeAuthorization.prepare', id: null });
        expect(matchNativeRestRoute('GET', `${ORIGIN}/api/mcp/native-auth-intents/${OP}`)).toMatchObject({ procedure: 'nativeAuthorization.get', id: OP });
        expect(matchNativeRestRoute('GET', `${ORIGIN}/api/mcp/native-sessions/${SESSION}`)).toMatchObject({ procedure: 'nativeSession.get', id: SESSION });
        for (const [method, path] of [
            ['GET', '/api/mcp/native-auth-intents'], ['POST', `/api/mcp/native-auth-intents/${OP}`], ['PUT', '/api/mcp/native-auth-intents'],
            ['POST', '/api/mcp/native-auth-intents?'], ['POST', '/api/mcp/native-auth-intents?x=1'], ['POST', '/api/mcp/native-auth-intents#f'],
            ['POST', '/api/mcp/native-auth-intents/'], ['GET', `/api/mcp/native-auth-intents/${OP}/`], ['GET', `/api/mcp/native-auth-intents/ABCDEF22-2222-4222-8222-222222222222`],
            ['GET', `/api/mcp/native-auth-intents/${OP}%2f`], ['GET', `/api/mcp/native-auth-intents%2f${OP}`], ['GET', `/api/mcp/native-sessions/${SESSION}/x`],
            ['GET', `/api/mcp/native-sessions/${SESSION.slice(0, -1)}`], ['GET', `/api/mcp/native-sessions/${SESSION}?`], ['GET', `/api/mcp/./native-sessions/${SESSION}`],
            ['GET', `/api/mcp/native-sessions/${SESSION}\\`], ['post', '/api/mcp/native-auth-intents'],
        ] as const) {
            expect(matchNativeRestRoute(method, `${ORIGIN}${path}`), `${method} ${path}`).toBeNull();
        }
    });
});

describe('prepare body', () => {
    it('accepts the exact create and renew shapes and nothing else', () => {
        expect(parseNativeIntentBody(create('run tests'))).toMatchObject({ ok: true, input: { kind: 'create', instruction: 'run tests' } });
        expect(parseNativeIntentBody({ kind: 'renew', operationId: OP, sessionId: SESSION })).toEqual({ ok: true, input: { kind: 'renew', operationId: OP, sessionId: SESSION } });
        for (const bad of [
            null, [], 'x', {}, { kind: 'cancel', operationId: OP, sessionId: SESSION }, { kind: 'renew', operationId: OP },
            { kind: 'renew', operationId: OP, sessionId: SESSION, computerId: COMPUTER }, create('x', { taskRef: 'task:x' }), create('x', { model: 'm' }),
            create('x', { instructionRevision: 2 }), create('x', { instructionRevision: '1' }), create('x', { operationId: 'ABCDEF22-2222-4222-8222-222222222222' }),
            create('x', { computerId: 'not-a-uuid' }), create('x', { instructionDigest: 'a'.repeat(64) }),
            create('x', { instructionDigest: `sha256:${'A'.repeat(64)}` }), { ...create('x'), instruction: 7 },
            Object.assign(Object.create({ inherited: 1 }), create('x')),
        ]) {
            expect(parseNativeIntentBody(bad).ok, JSON.stringify(bad)).toBe(false);
        }
    });

    it('keeps the exact bytes: whitespace and Unicode forms are never trimmed or normalised', () => {
        for (const text of ['  leading and trailing  \n', '\ttab\r\n', 'café', 'café', '😀 emoji', ' x ']) {
            const parsed = parseNativeIntentBody(create(text));
            expect(parsed, JSON.stringify(text)).toMatchObject({ ok: true, input: { instruction: text } });
        }
        // NFC and NFD are different instructions with different digests.
        expect(nativeInstructionDigest('café')).not.toBe(nativeInstructionDigest('café'));
        expect(nativeInstructionDigest('x')).toBe(`sha256:${createHash('sha256').update('x').digest('hex')}`);
    });

    it('refuses blank, NUL and ill-formed instructions, including a lone surrogate from a JSON escape', () => {
        for (const text of ['', ' ', '\n\t\r ', '  ', 'a\u0000b', '\u0000']) {
            expect(checkInstruction(text), JSON.stringify(text)).toBe('instruction_invalid');
        }
        for (const raw of ['"\\ud800"', '"x\\udc00"', '"\\udbff\\u0041"']) {
            const instruction = JSON.parse(raw) as string;
            expect(isWellFormedUnicode(instruction)).toBe(false);
            expect(parseNativeIntentBody(create(instruction))).toEqual({ ok: false, code: 'instruction_invalid' });
            expect(() => nativeInstructionDigest(instruction)).toThrow();
        }
        expect(isWellFormedUnicode(JSON.parse('"\\ud83d\\ude00"') as string)).toBe(true);
    });

    it('measures the 16384-byte limit in UTF-8 bytes, not characters', () => {
        const ascii = 'a'.repeat(NATIVE_INSTRUCTION_MAX_BYTES);
        expect(parseNativeIntentBody(create(ascii)).ok).toBe(true);
        expect(parseNativeIntentBody(create(`${ascii}a`))).toEqual({ ok: false, code: 'instruction_too_large' });
        // 4096 four-byte characters is exactly the limit; one more two-byte character is over it.
        const emoji = '😀'.repeat(NATIVE_INSTRUCTION_MAX_BYTES / 4);
        expect(Buffer.byteLength(emoji, 'utf8')).toBe(NATIVE_INSTRUCTION_MAX_BYTES);
        expect(parseNativeIntentBody(create(emoji)).ok).toBe(true);
        expect(parseNativeIntentBody(create(`${emoji}é`))).toEqual({ ok: false, code: 'instruction_too_large' });
    });

    it('recomputes the digest and refuses a mismatch', () => {
        expect(parseNativeIntentBody(create('a', { instructionDigest: nativeInstructionDigest('b') }))).toEqual({ ok: false, code: 'instruction_digest_mismatch' });
        expect(parseNativeIntentBody(create('a ', { instructionDigest: nativeInstructionDigest('a') }))).toEqual({ ok: false, code: 'instruction_digest_mismatch' });
    });
});

describe('finite consent terms configuration', () => {
    const env = { EZIL_NATIVE_AUTHORIZATION_POLICY_ID: '0B6F8A2E-4c1d-4e5f-9a7b-3c2d1e0f9a8b', EZIL_NATIVE_CONSENT_EPOCH: '3',
        EZIL_NATIVE_CONSENT_BUDGET_MICRO: '1000000', EZIL_NATIVE_CONSENT_TTL_SECONDS: '86400' };

    it('admits only positive canonical decimals and a deadline of at most 24 hours', () => {
        expect(nativeConsentTermsConfig(env)).toEqual({ policyId: '0b6f8a2e-4c1d-4e5f-9a7b-3c2d1e0f9a8b', epoch: '3', budgetMicro: '1000000', ttlSeconds: 86_400 });
        for (const [key, value] of [['EZIL_NATIVE_CONSENT_EPOCH', '0'], ['EZIL_NATIVE_CONSENT_EPOCH', '03'], ['EZIL_NATIVE_CONSENT_EPOCH', '-1'],
            ['EZIL_NATIVE_CONSENT_EPOCH', '1.5'], ['EZIL_NATIVE_CONSENT_BUDGET_MICRO', '1e6'], ['EZIL_NATIVE_CONSENT_BUDGET_MICRO', ' 1'],
            ['EZIL_NATIVE_CONSENT_BUDGET_MICRO', '1'.repeat(20)], ['EZIL_NATIVE_CONSENT_TTL_SECONDS', '86401'], ['EZIL_NATIVE_CONSENT_TTL_SECONDS', '0'],
            ['EZIL_NATIVE_AUTHORIZATION_POLICY_ID', 'policy'], ['EZIL_NATIVE_CONSENT_TTL_SECONDS', undefined]] as const) {
            expect(nativeConsentTermsConfig({ ...env, [key]: value }), `${key}=${value}`).toBeNull();
        }
    });
});

describe('derived values', () => {
    it('binds the input digest to kind, ids and instruction digest, but not the operation key', () => {
        const a = parseNativeIntentBody(create('one'));
        const b = parseNativeIntentBody(create('two'));
        if (!a.ok || !b.ok) throw new Error('fixture');
        expect(nativeIntentInputDigest(a.input)).not.toBe(nativeIntentInputDigest(b.input));
        expect(nativeIntentInputDigest(a.input)).toBe(nativeIntentInputDigest({ ...a.input, operationId: SESSION }));
        expect(nativeIntentInputDigest({ kind: 'renew', operationId: OP, sessionId: SESSION })).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('derives the only task reference, which fits the broker task_ref rule', () => {
        expect(nativeTaskRef(OP)).toBe(`native-task:${OP}`);
        expect(nativeTaskRef(OP)).toMatch(/^[a-z0-9][a-z0-9._:-]{0,127}$/);
        expect(() => nativeTaskRef('x')).toThrow();
    });
});
