import test from 'node:test';
import assert from 'node:assert/strict';
import { providerText } from './provider-state.js';

test('Settings describes checked gateway state without inferring credit availability', () => {
    assert.match(providerText({ provider: 'ezil', state: 'paused', configured: true }), /paused/);
    assert.match(providerText({ provider: 'ezil', state: 'ready' }), /credit availability is checked per request/);
    assert.match(providerText({ provider: 'ezil', state: 'model_unavailable' }), /No EZiL models/);
    assert.match(providerText({ provider: 'ezil', state: 'signin_required' }), /Sign in/);
    assert.match(providerText({ configured: true }), /unknown/);
    assert.match(providerText({ provider: 'azure', state: 'stored' }), /access has not been tested/);
});
test('Settings only displays fixed errors, never IPC error payloads or credentials', () => {
    for (const errorCode of ['secret-token', 'builder_required', 'membership_required', 'auth_unavailable', 'rate_limited']) {
        const message = providerText({ provider: 'ezil', state: 'unavailable', error: 'secret-payload', errorCode, accessToken: 'secret-token' });
        assert.equal(message.includes('secret'), false);
        assert.equal(message.includes('verified'), errorCode === 'secret-token');
    }
    assert.match(providerText({ keychainAvailable: false }), /Keychain/);
});
