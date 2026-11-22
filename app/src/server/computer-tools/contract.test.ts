import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { inputDigest } from '@/server/api/delegation-auth';
import { parseDelegationConfig, verifyDelegation } from '@/server/api/delegation-core';
import {
    CLIENT_ID, MCP_ORIGIN, OS_ORIGIN, SUPABASE_ISSUER, delegationEnv, signAssertion, signingKey, type SigningKey,
} from '@/server/api/delegation.test-support';

import {
    COMPUTER_TOOLS_DELEGATION_POLICY, COMPUTER_TOOLS_OPS, SCOPE_FOR_OP,
    computerToolsConfigured, opSwitchEnabled, parseComputerToolsBody, procedureForOp,
} from './contract';

const AUTH0_ISSUER = 'https://id.ezil.work/';
const ALL_SCOPES = ['ezil:computer-tools:read', 'ezil:computer-tools:call', 'ezil:terminal:run', 'ezil:settings:write'];

describe('computer-tools delegation policy (scope map)', () => {
    it('maps each procedure to exactly its contract scope', () => {
        expect([...COMPUTER_TOOLS_DELEGATION_POLICY.scopeByProcedure]).toEqual([
            ['computerTools.list', 'ezil:computer-tools:read'],
            ['computerTools.refresh', 'ezil:computer-tools:read'],
            ['computerTools.call', 'ezil:computer-tools:call'],
            ['computerTools.exec', 'ezil:terminal:run'],
            ['computerTools.job', 'ezil:terminal:run'],
            ['computerTools.cancel', 'ezil:terminal:run'],
        ]);
    });

    it('verifyDelegation accepts a procedure only under its scope and rejects every other scope', async () => {
        const signer = await signingKey();
        const owner = randomUUID();
        const serialized = 'EZIL-COMPUTER-TOOLS/1\nPOST\n/api/mcp/computer-tools/x\n{}';
        const verify = async (proc: string, scope: string) => {
            const n = Math.floor(Date.now() / 1000);
            const assertion = await signAssertion(signer as SigningKey, {
                iss: MCP_ORIGIN, aud: OS_ORIGIN, sub: owner, idp_iss: SUPABASE_ISSUER, client_id: CLIENT_ID,
                scope, proc, inp: inputDigest(serialized), jti: randomUUID(), iat: n, exp: n + 60,
            });
            const config = await parseDelegationConfig(delegationEnv([signer]), AUTH0_ISSUER);
            return verifyDelegation(new Headers({ authorization: `EZiL-Delegation ${assertion}` }), {
                enabled: true, config, binding: { procedure: proc, serializedInput: serialized },
                policy: COMPUTER_TOOLS_DELEGATION_POLICY, now: () => n,
                consumeJti: async () => true, findAccount: async () => ({ id: owner, createdAt: new Date().toISOString() }),
            });
        };
        for (const op of COMPUTER_TOOLS_OPS) {
            const proc = procedureForOp(op);
            const right = SCOPE_FOR_OP[op];
            expect((await verify(proc, right)).kind, `${op} should accept ${right}`).toBe('accepted');
            for (const wrong of ALL_SCOPES.filter((s) => s !== right)) {
                const outcome = await verify(proc, wrong);
                expect(outcome.kind, `${op} under ${wrong}`).toBe('rejected');
                expect(outcome.kind === 'rejected' && outcome.reason, `${op} under ${wrong}`).toBe('scope');
            }
        }
    });
});

describe('computer-tools gate', () => {
    const pins = {
        EZIL_DELEGATION_ISSUER: 'https://connect-staging.ezil.work',
        EZIL_DELEGATION_AUDIENCE: 'https://os-staging.ezil.work',
        CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://api-desktop-staging.ezil.work',
        CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'synthetic',
    };

    it('is configured only with every exact pin, tolerating a trailing slash on the Worker URL', () => {
        expect(computerToolsConfigured(pins)).toBe(true);
        expect(computerToolsConfigured({ ...pins, CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://api-desktop-staging.ezil.work/' })).toBe(true);
        for (const key of Object.keys(pins)) {
            expect(computerToolsConfigured({ ...pins, [key]: undefined }), `missing ${key}`).toBe(false);
        }
        expect(computerToolsConfigured({ ...pins, EZIL_DELEGATION_ISSUER: 'https://connect.ezil.work' })).toBe(false);
        expect(computerToolsConfigured({ ...pins, EZIL_DELEGATION_AUDIENCE: 'https://os.ezil.work' })).toBe(false);
        expect(computerToolsConfigured({ ...pins, CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://api-desktop.ezil.work' })).toBe(false);
        expect(computerToolsConfigured({ ...pins, CLOUDFLARE_GUACAMOLE_HMAC_SECRET: '   ' })).toBe(false);
    });

    it('routes each op to its family switch', () => {
        const toolsOn = { EZIL_DELEGATED_COMPUTER_TOOLS: 'enabled' };
        const termOn = { EZIL_DELEGATED_TERMINAL: 'enabled' };
        for (const op of ['list', 'refresh', 'call'] as const) {
            expect(opSwitchEnabled(toolsOn, op), op).toBe(true);
            expect(opSwitchEnabled(termOn, op), op).toBe(false);
            expect(opSwitchEnabled({ EZIL_DELEGATED_COMPUTER_TOOLS: 'on' }, op), op).toBe(false);
        }
        for (const op of ['exec', 'job', 'cancel'] as const) {
            expect(opSwitchEnabled(termOn, op), op).toBe(true);
            expect(opSwitchEnabled(toolsOn, op), op).toBe(false);
            expect(opSwitchEnabled({ EZIL_DELEGATED_TERMINAL: 'yes' }, op), op).toBe(false);
        }
    });
});

describe('computer-tools strict body grammar (canonicality)', () => {
    it('accepts the six exact op shapes and rejects extras, bad types and out-of-range fields', () => {
        expect(parseComputerToolsBody({ op: 'list' })?.op).toBe('list');
        expect(parseComputerToolsBody({ op: 'refresh' })?.op).toBe('refresh');
        expect(parseComputerToolsBody({ op: 'call', name: 'n', arguments: {}, requestId: randomUUID() })?.op).toBe('call');
        expect(parseComputerToolsBody({ op: 'job', jobId: 'a'.repeat(22) })?.op).toBe('job');

        expect(parseComputerToolsBody([])).toBeNull();
        expect(parseComputerToolsBody('x')).toBeNull();
        expect(parseComputerToolsBody({ op: 'nope' })).toBeNull();
        expect(parseComputerToolsBody({ op: 'list', x: 1 })).toBeNull();
        expect(parseComputerToolsBody({ op: 'call', name: 'n', arguments: [], requestId: randomUUID() })).toBeNull();
        expect(parseComputerToolsBody({ op: 'call', name: 'n', arguments: {}, requestId: 'bad' })).toBeNull();
        expect(parseComputerToolsBody({ op: 'job', jobId: 'short' })).toBeNull();
        expect(parseComputerToolsBody({ op: 'exec', command: 'ls', timeoutSeconds: 601, background: false, requestId: randomUUID() })).toBeNull();
        // positive control: the same timeout is allowed in the background
        expect(parseComputerToolsBody({ op: 'exec', command: 'ls', timeoutSeconds: 601, background: true, requestId: randomUUID() })?.op).toBe('exec');
    });
});
