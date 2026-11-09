// Browser-free validation of the auth-recovery fixture IdP's redirect guard.
// Run: node --test e2e/local-redirect.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeLocalRedirect } from './local-redirect.mjs';

const APP = 'http://localhost:3187';

test('accepts only the exact configured local app origin, keeping path and query', () => {
    assert.equal(safeLocalRedirect('http://localhost:3187/login', APP), 'http://localhost:3187/login');
    assert.equal(safeLocalRedirect('http://localhost:3187/app/browser?x=1#h', APP), 'http://localhost:3187/app/browser?x=1#h');
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
