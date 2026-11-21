import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { parseDelegationConfig } from './delegation-auth';
import { verifyDelegation } from './delegation-core';
import { delegationEnv, mcpInput, readClaims, readUrl, signAssertion, signingKey } from './delegation.test-support';
import {
    ACCOUNT_SETTINGS_PROCEDURE, NAMED_COMPUTER_PROCEDURE, ONBOARDING_DELEGATION_POLICY,
    onboardingDelegationBinding, onboardingDelegationEnabled, requireOnboardingCaller,
} from './onboarding-delegation';

const issuer = 'https://connect-staging.ezil.work';
const audience = 'https://os-staging.ezil.work';
const pins = { EZIL_DELEGATION_ISSUER: issuer, EZIL_DELEGATION_AUDIENCE: audience };
const stage = { ...pins, EZIL_DELEGATED_ONBOARDING: 'enabled' };
const auth0 = 'https://id.ezil.work/';
const settingsInput = mcpInput({});
const createInput = mcpInput({ name: 'Named desktop', idempotencyKey: randomUUID() });
const settingsLine = { method: 'GET', url: readUrl(ACCOUNT_SETTINGS_PROCEDURE, settingsInput), hasBody: false };
const createLine = {
    method: 'POST', url: readUrl(NAMED_COMPUTER_PROCEDURE), hasBody: true, editorBody: Buffer.from(createInput),
};

describe('delegated onboarding', () => {
    it('needs an explicit gate with canonical staging origins and has no editor or browser dependency', () => {
        expect(onboardingDelegationEnabled(pins)).toBe(false);
        expect(onboardingDelegationEnabled(stage)).toBe(true);
        expect(onboardingDelegationEnabled({ ...stage, EZIL_DELEGATION_AUDIENCE: 'https://os.ezil.work' })).toBe(false);
        expect(onboardingDelegationEnabled({ ...stage, EZIL_DELEGATION_ISSUER: issuer + '/' })).toBe(false);
    });

    it('binds one exact method and procedure to its original bytes', () => {
        expect(onboardingDelegationBinding(settingsLine)).toEqual({
            procedure: ACCOUNT_SETTINGS_PROCEDURE, serializedInput: settingsInput, type: 'query',
        });
        expect(onboardingDelegationBinding(createLine)).toEqual({
            procedure: NAMED_COMPUTER_PROCEDURE, serializedInput: createInput, type: 'mutation',
        });
        for (const line of [
            { ...settingsLine, method: 'POST' }, { ...settingsLine, hasBody: true },
            { ...settingsLine, url: settingsLine.url + '&batch=1' },
            { ...createLine, method: 'GET' }, { ...createLine, url: createLine.url + '?batch=1' },
            { ...createLine, editorBody: Buffer.from('{"json":{},"extra":1}') },
            { ...createLine, editorBody: Buffer.from([255]) },
        ]) expect(onboardingDelegationBinding(line)).toBeUndefined();
    });

    it('requires the exact client, issuer, scope and signed body for each arbitrary verified owner', async () => {
        const key = await signingKey();
        const config = await parseDelegationConfig(delegationEnv([key]), auth0);
        const [firstOwner, secondOwner] = [randomUUID(), randomUUID()];
        for (const [line, proc, scope, input, owner] of [
            [settingsLine, ACCOUNT_SETTINGS_PROCEDURE, 'ezil:settings:read', settingsInput, firstOwner],
            [createLine, NAMED_COMPUTER_PROCEDURE, 'ezil:computers:create', createInput, secondOwner],
        ] as const) {
            const findAccount = vi.fn(async () => ({ id: owner, createdAt: '2026-11-01T00:00:00Z' }));
            const consumeJti = vi.fn(async () => true);
            const deps = { enabled: true, config, binding: onboardingDelegationBinding(line),
                policy: ONBOARDING_DELEGATION_POLICY, now: () => Math.floor(Date.now() / 1_000), findAccount, consumeJti };
            const claims = readClaims(owner, 'computer.list', input, { proc, scope });
            for (const [rejectedClaims, reason] of [
                [{ ...claims, scope: 'ezil:computers:read' }, 'scope'],
                [{ ...claims, client_id: 'unregistered-client' }, 'client'],
                [{ ...claims, iss: 'https://wrong.test' }, 'issuer'],
                [{ ...claims, aud: 'https://wrong.test' }, 'audience'],
                [readClaims(owner, 'computer.list', mcpInput({ name: 'changed' }), { proc, scope }), 'binding'],
            ] as const) {
                const authorization = 'EZiL-Delegation ' + await signAssertion(key, rejectedClaims);
                await expect(verifyDelegation(new Headers({ authorization }), deps)).resolves.toEqual({ kind: 'rejected', reason });
            }
            expect(findAccount).not.toHaveBeenCalled();
            expect(consumeJti).not.toHaveBeenCalled();
            const authorization = 'EZiL-Delegation ' + await signAssertion(key, claims);
            await expect(verifyDelegation(new Headers({ authorization }), deps)).resolves.toMatchObject({
                kind: 'accepted', caller: { userId: owner, procedure: proc },
            });
            consumeJti.mockResolvedValueOnce(false);
            await expect(verifyDelegation(new Headers({ authorization }), deps)).resolves.toEqual({ kind: 'rejected', reason: 'replayed' });
        }
    });

    it('refuses a plain login or a delegation for another owner or procedure at the handler', () => {
        for (const [key, value] of Object.entries(stage)) vi.stubEnv(key, value);
        const user = { id: randomUUID() } as Parameters<typeof requireOnboardingCaller>[0]['user'];
        const call = { jti: randomUUID(), clientId: 'approved', userId: user!.id, procedure: ACCOUNT_SETTINGS_PROCEDURE };
        try {
            expect(() => requireOnboardingCaller({ user }, ACCOUNT_SETTINGS_PROCEDURE)).toThrow();
            expect(() => requireOnboardingCaller({ user, delegation: { status: 'accepted', call } }, NAMED_COMPUTER_PROCEDURE)).toThrow();
            expect(() => requireOnboardingCaller({ user, delegation: { status: 'accepted', call: { ...call, userId: randomUUID() } } },
                ACCOUNT_SETTINGS_PROCEDURE)).toThrow();
            expect(requireOnboardingCaller({ user, delegation: { status: 'accepted', call } }, ACCOUNT_SETTINGS_PROCEDURE)).toEqual(call);
        } finally {
            vi.unstubAllEnvs();
        }
    });
});
