import { describe, expect, it } from 'vitest';

import { editorControlsEnabled, editorDelegationEnabled } from './editor-delegation';
import { mcpIdentityBootstrapAudience, onboardingDelegationEnabled } from './onboarding-delegation';
import { editorWorkerOrigin } from './parity-config';

const production = {
    EZIL_OS_PUBLIC_ORIGIN: 'https://os.ezil.work',
    EZIL_DELEGATION_AUDIENCE: 'https://os.ezil.work',
    EZIL_DELEGATION_ISSUER: 'https://connect.ezil.work',
    EZIL_EDITOR_WORKER_ORIGIN: 'https://api-desktop.ezil.work',
    CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://api-desktop.ezil.work',
    EZIL_EDITOR_WORKER_PROTOCOL: '2',
    EZIL_DELEGATED_EDITOR_SESSIONS: 'enabled', EZIL_EDITOR_BRIDGE: 'enabled',
    EZIL_EDITOR_BRIDGE_CONTROLS: 'enabled', EZIL_DELEGATED_ONBOARDING: 'enabled',
};

describe('deployment-specific parity gates', () => {
    it('defaults off and accepts explicit production pins without an account allowlist', () => {
        expect(editorDelegationEnabled({})).toBe(false);
        expect(onboardingDelegationEnabled({})).toBe(false);
        expect(editorControlsEnabled(production)).toBe(true);
        expect(onboardingDelegationEnabled(production)).toBe(true);
        expect(editorWorkerOrigin(production)).toBe(production.EZIL_EDITOR_WORKER_ORIGIN);
    });

    it.each(['', '1', '3', '02'])('refuses unsupported or missing Worker protocol %j', protocol => {
        const env = { ...production, EZIL_EDITOR_WORKER_PROTOCOL: protocol };
        expect(editorDelegationEnabled(env)).toBe(false);
        expect(editorWorkerOrigin(env)).toBeUndefined();
        // Identity bootstrap and named creation do not need a running Worker.
        expect(onboardingDelegationEnabled(env)).toBe(true);
    });

    it('refuses mixed deployment origins, credentials, paths and non-HTTPS pins', () => {
        expect(editorDelegationEnabled({ ...production, EZIL_DELEGATION_AUDIENCE: 'https://os-staging.ezil.work' })).toBe(false);
        expect(editorWorkerOrigin({ ...production, CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://api-desktop-staging.ezil.work' })).toBeUndefined();
        for (const origin of ['http://os.ezil.work', 'https://os.ezil.work/', 'https://os.ezil.work/path', 'https://user:pass@os.ezil.work']) {
            expect(onboardingDelegationEnabled({ ...production, EZIL_OS_PUBLIC_ORIGIN: origin, EZIL_DELEGATION_AUDIENCE: origin })).toBe(false);
        }
    });

    it('requires separate controls and bootstrap consent audience gates', () => {
        expect(editorControlsEnabled({ ...production, EZIL_EDITOR_BRIDGE_CONTROLS: '' })).toBe(false);
        expect(mcpIdentityBootstrapAudience(production)).toBeUndefined();
        expect(mcpIdentityBootstrapAudience({ ...production, EZIL_MCP_IDENTITY_BOOTSTRAP_AUTH0_CLIENT_ID: 'synthetic-client-1234' }))
            .toBe('synthetic-client-1234');
        expect(mcpIdentityBootstrapAudience({ ...production, EZIL_MCP_IDENTITY_BOOTSTRAP_AUTH0_CLIENT_ID: '*' })).toBeUndefined();
    });
});
