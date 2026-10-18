import assert from 'node:assert/strict';
import test from 'node:test';
import { redact, scanCopy, hasHorizontalOverflow, requireTestKeys } from './billing-e2e-lib.mjs';

test('redaction removes every key mode and checkout secret while retaining useful context', () => {
    assert.equal(redact('session cs_test_example: declined'), 'session cs_test_example: declined');
    for (const prefix of ['sk_test_', 'pk_test_', 'sk_live_', 'pk_live_', 'rk_test_', 'rk_live_']) {
        const output = redact(`failed ${prefix}Synthetic123`);
        assert.equal(output, 'failed [REDACTED_STRIPE_KEY]');
        assert(!output.includes('Synthetic123'));
    }
    assert.equal(redact('cs_test_123_secret_456'), '[REDACTED_CHECKOUT_SECRET]');
    assert.equal(redact(new Error('sk_test_Synthetic123')), 'Error: [REDACTED_STRIPE_KEY]');
});

test('copy scan covers the entire frozen list with positive controls', () => {
    assert.deepEqual(scanCopy('$20 USD · before tax. 2 vCPU · 8 GiB. Sessions run up to 6 hours, then your work is saved and the computer restarts. Files and installed tools are kept; running processes start fresh.'), []);
    for (const term of ['faster', 'instant', 'unlimited', 'priority', 'gpu', 'heavy use', 'fair use', 'gpt', 'claude', 'gemini', 'llama', 'memory is kept', 'memory survives', 'processes keep running', 'ai included', 'includes ai']) {
        assert.deepEqual(scanCopy(`A ${term.toUpperCase()} claim`), [term]);
        assert.deepEqual(scanCopy(term.replaceAll(' ', '\n\t ')), [term]);
    }
    assert.deepEqual(scanCopy('HEAVY\n USE and fair\tuse'), ['heavy use', 'fair use']);
    assert.deepEqual(scanCopy('instantly available'), ['instant']);
});

test('overflow detects either root or body exceeding the viewport at both required sizes', () => {
    for (const viewportWidth of [390, 1280]) {
        assert.equal(hasHorizontalOverflow({ viewportWidth, documentWidth: viewportWidth, bodyWidth: viewportWidth }), false);
        assert.equal(hasHorizontalOverflow({ viewportWidth, documentWidth: viewportWidth + 1, bodyWidth: viewportWidth }), true);
        assert.equal(hasHorizontalOverflow({ viewportWidth, documentWidth: viewportWidth, bodyWidth: viewportWidth + 1 }), true);
    }
    for (const invalid of [0, -1, NaN, Infinity, undefined]) {
        assert.throws(() => hasHorizontalOverflow({ viewportWidth: invalid, documentWidth: 390, bodyWidth: 390 }), TypeError);
    }
});

test('test-mode guard accepts an explicit pair and refuses either live, missing or malformed key', () => {
    const secret = 'sk_test_Synthetic123';
    const publishable = 'pk_test_Synthetic456';
    assert.deepEqual(requireTestKeys(secret, publishable), { secret, publishable });
    for (const pair of [
        ['sk_live_Synthetic123', publishable], [secret, 'pk_live_Synthetic456'],
        [undefined, publishable], [secret, undefined], ['', ''],
        ['sk_test_', publishable], [secret, 'pk_test_'],
        [' sk_test_Synthetic123', publishable], [publishable, secret],
    ]) {
        assert.throws(() => requireTestKeys(...pair), /live or missing keys are refused/);
    }
});

test('redact scrubs the Vercel bypass header and the configured secret', () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'bypassSecretValue123';
    try {
        const out = redact('x-vercel-protection-bypass: bypassSecretValue123 and again bypassSecretValue123');
        assert.equal(out.includes('bypassSecretValue123'), false);
        assert.match(redact('plain text'), /plain text/, 'positive control: ordinary text is untouched');
    } finally { delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET; }
});
