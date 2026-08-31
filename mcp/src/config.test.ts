/**
 * Config is checked before the transport connects, so these pin the failure
 * messages a person will actually see on stderr.
 */
import { describe, expect, it } from 'bun:test';
import { ConfigError, readConfig } from './config';

const base = { EZIL_API_URL: 'https://ezil.example', EZIL_TOKEN: 'tok' };

describe('readConfig', () => {
    it('accepts a complete config and defaults the timeout generously', () => {
        expect(readConfig(base)).toEqual({ baseUrl: 'https://ezil.example', token: 'tok', timeoutMs: 300_000 });
    });

    it('demands EZIL_API_URL and EZIL_TOKEN by name', () => {
        expect(() => readConfig({ EZIL_TOKEN: 'tok' })).toThrow(/EZIL_API_URL is not set/);
        expect(() => readConfig({ EZIL_API_URL: 'https://x.example' })).toThrow(/EZIL_TOKEN is not set/);
    });

    it('treats whitespace-only values as missing', () => {
        expect(() => readConfig({ ...base, EZIL_TOKEN: '   ' })).toThrow(ConfigError);
        expect(() => readConfig({ ...base, EZIL_API_URL: '  ' })).toThrow(ConfigError);
    });

    // 🔴 A bearer token sent over plaintext is a leaked token, and this server
    // sends one on every single call.
    it('refuses plaintext http for a remote host', () => {
        expect(() => readConfig({ ...base, EZIL_API_URL: 'http://ezil.example' })).toThrow(/must be https/);
    });

    it('still allows http on loopback, so local development works', () => {
        expect(readConfig({ ...base, EZIL_API_URL: 'http://localhost:3000' }).baseUrl).toBe('http://localhost:3000');
        expect(readConfig({ ...base, EZIL_API_URL: 'http://127.0.0.1:3000' }).baseUrl).toBe('http://127.0.0.1:3000');
    });

    it('rejects a malformed URL rather than failing later on every call', () => {
        expect(() => readConfig({ ...base, EZIL_API_URL: 'not a url' })).toThrow(/not a valid URL/);
    });

    // A short timeout turns a slow cold boot into a phantom failure, which the
    // model then retries — booting the container a second time.
    it('rejects a timeout too short to survive a cold boot', () => {
        expect(() => readConfig({ ...base, EZIL_TIMEOUT_MS: '500' })).toThrow(/>= 1000/);
        expect(() => readConfig({ ...base, EZIL_TIMEOUT_MS: 'soon' })).toThrow(/>= 1000/);
    });

    it('accepts an explicit timeout', () => {
        expect(readConfig({ ...base, EZIL_TIMEOUT_MS: '60000' }).timeoutMs).toBe(60_000);
    });

    it('names the HMAC secret as the wrong credential, because that mistake is catastrophic', () => {
        expect(() => readConfig({ EZIL_API_URL: 'https://x.example' })).toThrow(/SANDBOX_HMAC_SECRET/);
    });
});
