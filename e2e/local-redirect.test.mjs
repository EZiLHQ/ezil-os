// Browser-free validation of the auth-recovery fixture IdP's redirect guard.
// Run: node --test e2e/local-redirect.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeLocalRedirect } from './local-redirect.mjs';

const APP = 'http://localhost:3187';

test('accepts the local app callback at the exact origin, keeping its state query and its fragment', () => {
    assert.equal(safeLocalRedirect('http://localhost:3187/login', APP), 'http://localhost:3187/login');
    assert.equal(safeLocalRedirect('http://localhost:3187/api/auth/callback?state=abc123', APP), 'http://localhost:3187/api/auth/callback?state=abc123');
    assert.equal(safeLocalRedirect('http://localhost:3187/app/browser#section', APP), 'http://localhost:3187/app/browser#section');
});

test('refuses a same-origin blob: URL and a same-origin URL carrying credentials', () => {
    assert.equal(safeLocalRedirect('blob:http://localhost:3187/abc', APP), null);
    assert.equal(safeLocalRedirect('http://user:pass@localhost:3187/cb', APP), null);
    assert.equal(safeLocalRedirect('http://user@localhost:3187/cb', APP), null); // username only
    assert.equal(safeLocalRedirect('data:text/html,evil', APP), null);
});

test('refuses a foreign origin', () => {
    assert.equal(safeLocalRedirect('https://evil.example/app/browser', APP), null);
    assert.equal(safeLocalRedirect('http://evil.example', APP), null);
});

test('refuses a protocol-relative URL (//evil) and a backslash-authority (/\\evil)', () => {
    assert.equal(safeLocalRedirect('//evil', APP), null);
    assert.equal(safeLocalRedirect('//evil.example/app/browser', APP), null);
    assert.equal(safeLocalRedirect('/\\evil', APP), null);
    assert.equal(safeLocalRedirect('\\\\evil', APP), null);
});

test('refuses a look-alike host that merely starts with the app origin', () => {
    assert.equal(safeLocalRedirect('http://localhost:3187.evil.example/app', APP), null);
    assert.equal(safeLocalRedirect('http://localhost:31870/app', APP), null); // different port
    assert.equal(safeLocalRedirect('https://localhost:3187/app', APP), null); // different scheme
    assert.equal(safeLocalRedirect('http://localhost@evil.example/app', APP), null); // userinfo trick
});

test('refuses a relative path, an empty value and a non-string', () => {
    assert.equal(safeLocalRedirect('/app/browser', APP), null);
    assert.equal(safeLocalRedirect('', APP), null);
    assert.equal(safeLocalRedirect(null, APP), null);
    assert.equal(safeLocalRedirect(undefined, APP), null);
});
