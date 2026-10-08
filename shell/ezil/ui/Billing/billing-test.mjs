// Local DOM tests; no gateway, checkout provider, or network is contacted.
// Run: node shell/ezil/ui/Billing/billing-test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import {
    attachToChat, classifyGatewayError, createBillingPopup, createComposerNotice, createWalletBadge,
    fetchWallet, formatUsdMicro, mountComputeSize, walletSummary,
} from './index.js';

const config = { WALLET_V2_ENABLED: true };
const rateCodes = ['rate_limited', 'tpm_limited', 'concurrency_limit', 'spend_limit_reached'];
const serviceCodes = [
    'global_cap_reached', 'killswitch', 'paused', 'model_disabled',
    'policy_unavailable', 'controls_unavailable', 'credit_policy_unavailable', 'pricing_unavailable',
];
const wallet = (included = '20000000', purchased = '0', plan = 'free') => ({
    version: 2, unit: 'usd_micro', plan, included: { balance: included, periodEnd: null }, purchased: { balance: purchased },
});
const refusal = (code = 'insufficient_credits', status = 402, extra = {}) => ({ status, body: { error: { code, ...extra } } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until (predicate) {
    for ( let attempt = 0; attempt < 200; attempt++ ) {
        if ( predicate() ) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.fail('Timed out waiting for local UI state');
}
function fixture (t, options = {}) {
    const dom = new JSDOM('<!doctype html><body><button id="editor">Editor</button></body>', { url: 'https://ezil.local/?payment=success' });
    const popup = createBillingPopup({
        config, document: dom.window.document, wallet: wallet(),
        maxPollTries: 3, pollIntervalMs: 1, requestTimeoutMs: 20,
        ...options,
    });
    t.after(() => { popup.destroy(); dom.window.close(); });
    return { dom, popup, doc: dom.window.document };
}
const action = (popup, name) => popup.element?.querySelector(`[data-action="${name}"]`);
const cardTitle = (popup, name) => action(popup, name)?.querySelector('.ezil-billing-card-title').textContent;
function noticeFixture (t, options = {}) {
    const { doc, dom } = fixture(t);
    const notice = createComposerNotice({ document: doc, ...options });
    t.after(() => notice.destroy());
    return { notice, doc, dom };
}

test('v1.1 A5 classifies every row and rejects mismatched/unknown envelopes', () => {
    const cases = [
        [402, 'insufficient_credits', 'topup'], [402, 'no_entitlement', 'subscribe'],
        ...rateCodes.map(code => [429, code, 'retry_later']),
        ...serviceCodes.map(code => [503, code, 'retry_later']),
        ...[502, 504].flatMap(status => ['upstream_error', 'upstream_unavailable', 'upstream_timeout', 'upstream_future'].map(code => [status, code, 'provider'])),
        ...[502, 503, 504].flatMap(status => ['provider_error', 'provider_unavailable'].map(code => [status, code, 'unknown'])),
        ...[429, 502, 504].flatMap(status => serviceCodes.map(code => [status, code, 'unknown'])),
        ...rateCodes.map(code => [503, code, 'unknown']),
        ...['upstream_error', 'upstream_unavailable', 'upstream_timeout'].map(code => [503, code, 'unknown']),
        [429, 'insufficient_credits', 'unknown'], [402, 'rate_limited', 'unknown'],
        [500, 'upstream_error', 'unknown'], [200, 'no_entitlement', 'unknown'],
        ...[402, 429, 502, 503, 504].map(status => [status, 'future_code', 'unknown']),
        ['502', 'upstream_error', 'unknown'], [502, 'not_upstream_error', 'unknown'],
    ];
    for ( const [status, code, expected] of cases ) assert.equal(classifyGatewayError(status, { error: { code } }), expected, `${status} ${code}`);
    for ( const status of [402, 429, 502, 503, 504] ) {
        for ( const body of [null, undefined, {}, 'rate_limited', { code: 'rate_limited' }] ) assert.equal(classifyGatewayError(status, body), 'unknown');
        for ( const code of [null, undefined, 12, {}, ['upstream_error']] ) assert.equal(classifyGatewayError(status, { error: { code } }), 'unknown');
    }
});

test('USD formatting stays exact for ordinary, fractional, and very large values', () => {
    assert.equal(formatUsdMicro('20000000'), '$20.00');
    assert.equal(formatUsdMicro('0'), '$0.00');
    assert.equal(formatUsdMicro('19999999'), '$19.99');
    assert.equal(formatUsdMicro('9999'), '$0.00');
    assert.equal(formatUsdMicro('9007199254740993123456789'), '$9007199254740993123.45');
    for ( const value of [null, 20000000, '-1', '1.5', 'Infinity', ''] ) assert.equal(formatUsdMicro(value), '—');
});

test('feature flag is strictly opt-in, with no DOM or reads by default', async t => {
    const { doc, popup } = fixture(t, { config: undefined });
    assert.equal(popup.open(refusal()), false);
    for ( const value of [undefined, false, 'true', 1] ) {
        const adapter = attachToChat({ config: { WALLET_V2_ENABLED: value }, document: doc, walletMount: doc.body, fetchImpl: () => assert.fail('disabled fetch') });
        assert.equal(await adapter.ready, null);
        assert.equal(adapter.handleGatewayError(402, refusal().body, 'draft'), false);
        assert.equal(adapter.handleGatewayError(429, refusal('rate_limited', 429).body, 'draft'), false);
        adapter.dispose();
    }
    assert.equal(mountComputeSize(doc.body, { getShapes: () => assert.fail('disabled shapes') }), null);
    assert.equal(doc.querySelector('dialog, .ezil-wallet-badge, section'), null);
    assert.equal(doc.querySelector('style[data-ezil-billing], .ezil-billing-bar'), null);
});

test('dialog hierarchy, focus, renewal, config copy, and shared styles', t => {
    const data = wallet();
    data.included.periodEnd = '2026-11-07T00:00:00Z';
    const { popup, doc } = fixture(t, {
        config: { ...config, SUBSCRIPTION_INCLUDED_USD_MICRO: '20000000' }, wallet: data,
        startCheckout: () => {}, refreshWallet: () => data,
    });
    popup.open(refusal('insufficient_credits', 402, { requiredUsdMicro: '30000000', actions: ['topup', 'subscribe'] }));
    assert.equal(popup.element.getAttribute('role'), 'dialog');
    assert.equal(doc.getElementById(popup.element.getAttribute('aria-labelledby')).textContent, 'Not enough AI credit');
    assert.equal(doc.activeElement, action(popup, 'topup'));
    assert.equal(popup.element.querySelectorAll('.ezil-billing-bucket').length, 2);
    assert.match(popup.element.textContent, /renews Nov 7/);
    assert.match(action(popup, 'subscribe').textContent, /\$20.00 AI credit each paid period/);
    action(popup, 'dismiss').click();
    assert.equal(popup.element, null);
    popup.open(refusal('no_entitlement', 402, { actions: ['subscribe', 'topup'] }));
    assert.equal(doc.activeElement, action(popup, 'subscribe'));
    assert.equal(action(popup, 'topup'), null);
    popup.close();
    const notice = createComposerNotice({ document: doc });
    t.after(() => notice.destroy());
    notice.show(refusal('paused', 503));
    notice.hide();
    popup.open();
    assert.equal(doc.querySelectorAll('style[data-ezil-billing]').length, 1);
    assert.match(doc.querySelector('style[data-ezil-billing]').textContent, /font-variant-numeric: tabular-nums/);
});

test('Resend waits for a refreshed balance sufficient to cover the exact required microdollars', async t => {
    const sent = [];
    const draft = Object.freeze({ text: 'keep me', attachments: ['a'] });
    const { popup } = fixture(t, {
        draft, wallet: wallet('0', '0'), onResend: value => { sent.push(value); },
        startCheckout: () => ({ success: true }), refreshWallet: () => wallet('0', '1199999'),
    });
    popup.open(refusal('insufficient_credits', 402, { requiredUsdMicro: '1200000' }));
    assert.equal(action(popup, 'resend').disabled, true);
    action(popup, 'resend').click();
    action(popup, 'topup').click();
    assert.equal(popup.element.querySelector('.ezil-billing-cards'), null);
    assert.match(popup.element.textContent, /Waiting for payment confirmation/);
    assert.match(popup.element.textContent, /only after payment is confirmed/);
    assert.equal(action(popup, 'resend').disabled, true);
    await until(() => popup.checkoutState === 'updated');
    assert.equal(action(popup, 'resend').disabled, true);
    assert.deepEqual(sent, []);
    popup.updateWallet(wallet('1', '1199999'));
    assert.equal(action(popup, 'resend').disabled, false);
    assert.deepEqual(sent, []);
    action(popup, 'resend').click();
    action(popup, 'resend').click();
    await tick();
    assert.deepEqual(sent, [draft]);
    assert.equal(popup.draft, draft);
});

test('initial, invalid, and legacy balances cannot satisfy a USD requirement', t => {
    const { popup } = fixture(t, { onResend: () => assert.fail('unexpected resend') });
    popup.open(refusal('insufficient_credits', 402, { requiredUsdMicro: '1' }));
    assert.equal(action(popup, 'resend').disabled, true);
    for ( const next of [wallet('invalid'), null, { version: 1, balance_microcredits: '999999999' }, wallet('0', '0')] ) {
        popup.updateWallet(next);
        assert.equal(action(popup, 'resend').disabled, true);
    }
    for ( const requiredUsdMicro of ['invalid', '-1', 1] ) {
        popup.open(refusal('insufficient_credits', 402, { requiredUsdMicro }));
        popup.updateWallet(wallet());
        assert.equal(action(popup, 'resend').disabled, true);
    }
    popup.open(refusal('insufficient_credits', 402, { requiredUsdMicro: '9007199254740993' }));
    popup.updateWallet(wallet('9007199254740992'));
    assert.equal(action(popup, 'resend').disabled, true);
    popup.updateWallet(wallet('9007199254740992', '1'));
    assert.equal(action(popup, 'resend').disabled, false);
});

test('429 countdown disables Retry until zero and sends the retained draft once per click', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
    const draft = Object.freeze({ text: 'retained', attachments: ['a'] });
    const received = [];
    let finish;
    const { notice } = noticeFixture(t, {
        draft, onResend: value => { received.push(value); return new Promise(resolve => { finish = resolve; }); },
    });
    notice.show(refusal('rate_limited', 429, { retryAfterSeconds: 42 }));
    assert.equal(action(notice, 'retry').disabled, true);
    assert.match(notice.element.textContent, /0:42/);
    action(notice, 'retry').click();
    assert.deepEqual(received, []);
    t.mock.timers.tick(41000);
    assert.match(notice.element.textContent, /0:01/);
    assert.equal(action(notice, 'retry').disabled, true);
    t.mock.timers.tick(1000);
    assert.equal(action(notice, 'retry').disabled, false);
    assert.match(notice.element.textContent, /Try again now/);
    assert.deepEqual(received, []);
    action(notice, 'retry').click();
    action(notice, 'retry').click();
    assert.deepEqual(received, [draft]);
    finish();
    await tick();
    assert.equal(notice.element.hidden, true);
    assert.equal(notice.draft, draft);
    notice.show(refusal('paused', 503, { retryAfterSeconds: 60 }));
    assert.match(notice.element.textContent, /AI is temporarily paused.*1:00/);
    notice.hide();
    t.mock.timers.tick(60000);
    assert.equal(notice.element.hidden, true);
});

test('composer ignores native double clicks and keeps draft after resend failures', async t => {
    const draft = { text: 'draft' };
    const received = [];
    const { notice, dom } = noticeFixture(t, { draft, onResend: value => { received.push(value); throw new Error('offline'); } });
    notice.show(refusal('upstream_error', 502, { charge: 'pending_review' }));
    action(notice, 'retry').dispatchEvent(new dom.window.MouseEvent('click', { detail: 1 }));
    await tick();
    assert.match(notice.element.textContent, /Your draft is kept/);
    action(notice, 'retry').dispatchEvent(new dom.window.MouseEvent('click', { detail: 2 }));
    assert.deepEqual(received, [draft]);
    action(notice, 'retry').click();
    assert.deepEqual(received, [draft, draft]);
    notice.hide();
    action(notice, 'retry').click();
    assert.deepEqual(received, [draft, draft]);
});

test('chat routes 402 to the dialog and 429, 503, provider, and unknown errors above the composer', async t => {
    const { doc } = fixture(t);
    const composer = doc.createElement('div');
    const input = doc.createElement('textarea');
    input.value = 'saved draft';
    composer.append(input);
    doc.body.append(composer);
    const requests = [];
    const draft = { text: input.value };
    const adapter = attachToChat({
        config, document: doc, composerMount: composer, refreshWallet: () => wallet(),
        onResend: (...args) => { requests.push(args); throw new Error('offline'); },
    });
    t.after(() => adapter.dispose());
    await adapter.ready;
    adapter.handleGatewayError(402, refusal().body, draft);
    assert.ok(adapter.popup.element.matches('dialog'));
    assert.equal(adapter.notice, null);
    for ( const [status, code] of [[429, 'rate_limited'], [503, 'paused'], [502, 'upstream_error'], [500, 'future_code']] ) {
        assert.equal(adapter.handleGatewayError(status, refusal(code, status).body, draft), true);
        assert.equal(adapter.popup, null);
        assert.equal(doc.querySelector('dialog'), null);
        assert.equal(composer.firstChild, adapter.notice.element);
        assert.equal(adapter.notice.draft, draft);
        assert.equal(input.value, 'saved draft');
        assert.equal(action(adapter.notice, 'topup'), null);
        assert.equal(action(adapter.notice, 'subscribe'), null);
    }
    assert.equal(requests.length, 0);
    action(adapter.notice, 'retry').click();
    await tick();
    action(adapter.notice, 'retry').click();
    await tick();
    assert.equal(requests.length, 2);
    assert.equal(requests[0][0], draft);
    assert.notEqual(requests[0][1].requestId, requests[1][1].requestId);
    adapter.handleGatewayError(402, refusal().body, draft);
    assert.equal(adapter.notice, null);
    assert.equal(composer.querySelector('.ezil-billing-bar'), null);
    assert.ok(adapter.popup.element);
});

test('402 actions distinguish top-up and subscription', t => {
    const { popup } = fixture(t, { startCheckout: () => {}, refreshWallet: () => wallet() });
    popup.open(refusal());
    assert.equal(cardTitle(popup, 'topup'), 'Top up');
    assert.equal(cardTitle(popup, 'subscribe'), 'Upgrade to EZiL Cloud');
    assert.match(popup.element.textContent, /Included\$20.00Purchased\$0.00/);
    popup.open({ ...refusal(), wallet: wallet('0', '0', 'subscriber') });
    assert.equal(action(popup, 'subscribe'), null);
    popup.open(refusal('no_entitlement'));
    assert.equal(action(popup, 'topup'), null);
    assert.ok(action(popup, 'subscribe'));
});

test('402 server actions offer both checkouts without a wallet plan', async t => {
    const checkouts = [];
    const { popup } = fixture(t, {
        wallet: null, maxPollTries: 1,
        startCheckout: value => { checkouts.push(value); },
        refreshWallet: () => wallet('0', '0'),
    });
    popup.open(refusal('insufficient_credits', 402, {
        actions: ['topup', 'subscribe'],
        balance: { includedUsdMicro: '0', purchasedUsdMicro: '0' },
    }));
    assert.equal(popup.wallet.plan, undefined);
    assert.equal(cardTitle(popup, 'topup'), 'Top up');
    assert.equal(cardTitle(popup, 'subscribe'), 'Upgrade to EZiL Cloud');
    for ( const name of ['subscribe', 'topup'] ) {
        assert.equal(action(popup, name).disabled, false);
        action(popup, name).click();
        await until(() => popup.checkoutState === 'unconfirmed');
    }
    assert.deepEqual(checkouts, ['subscribe', 'topup']);
});

test('402 action arrays override plan fallback and ignore unknown or duplicate actions', t => {
    const { popup } = fixture(t);
    const cases = [
        [[], []],
        [['future_action'], []],
        [['subscribe'], ['subscribe']],
        [['topup'], ['topup']],
        [['subscribe', 'future_action', 'topup', 'subscribe'], ['topup', 'subscribe']],
    ];
    for ( const code of ['insufficient_credits', 'no_entitlement'] ) {
        for ( const plan of ['free', 'subscriber'] ) {
            for ( const [actions, expected] of cases ) {
                popup.open({ ...refusal(code, 402, { actions }), wallet: wallet('0', '0', plan) });
                const actual = [...popup.element.querySelectorAll('[data-action]')].map(button => button.dataset.action);
                assert.deepEqual(actual, ['dismiss', ...expected.filter(action => code !== 'no_entitlement' || action !== 'topup'), 'close', 'resend'], `${code} ${plan} ${JSON.stringify(actions)}`);
            }
        }
    }
});

test('402 missing or non-array actions preserve the current plan fallback', t => {
    const { popup } = fixture(t);
    for ( const actions of [undefined, null, 'subscribe', { topup: true }] ) {
        for ( const [plan, expected] of [[undefined, ['topup']], ['free', ['topup', 'subscribe']], ['subscriber', ['topup']]] ) {
            popup.open({ ...refusal('insufficient_credits', 402, { actions }), wallet: plan ? wallet('0', '0', plan) : null });
            const actual = [...popup.element.querySelectorAll('[data-action]')].map(button => button.dataset.action);
            assert.deepEqual(actual, ['dismiss', ...expected, 'close', 'resend']);
        }
        popup.open(refusal('no_entitlement', 402, { actions }));
        assert.equal(action(popup, 'topup'), null);
        assert.ok(action(popup, 'subscribe'));
    }
});

test('429 limits and 503 service refusals, including global_cap_reached, show retry hints and never offer payment', t => {
    const { notice } = noticeFixture(t, { onResend: () => assert.fail('automatic resend') });
    const cases = [...rateCodes.map(code => [429, code]), ...serviceCodes.map(code => [503, code])];
    for ( const [status, code] of cases ) {
        notice.show(refusal(code, status, { actions: ['topup', 'subscribe'], plan: 'free', retryAfterSeconds: 12 }));
        assert.equal(action(notice, 'topup'), null);
        assert.equal(action(notice, 'subscribe'), null);
        assert.equal(action(notice, 'resend'), null);
        assert.equal(action(notice, 'retry').textContent, 'Retry');
        assert.equal(action(notice, 'retry').disabled, true);
        assert.match(notice.element.textContent, /Try again in 0:12\./);
        notice.show(refusal(code, status));
        assert.doesNotMatch(notice.element.textContent, /Try again in/);
    }
});

test('unknown errors never offer payment or claim nothing was charged', t => {
    const { notice } = noticeFixture(t);
    for ( const [status, code] of [[429, 'global_cap_reached'], [429, 'insufficient_credits'], [503, 'provider_unavailable'], [502, 'provider_error']] ) {
        notice.show(refusal(code, status, { actions: ['topup', 'subscribe'], charge: 'none', retryAfterSeconds: 12 }));
        assert.equal(action(notice, 'topup'), null);
        assert.equal(action(notice, 'subscribe'), null);
        assert.equal(action(notice, 'resend'), null);
        assert.equal(action(notice, 'later'), null);
        assert.doesNotMatch(notice.element.textContent, /Nothing was charged|Try again in/);
    }
});

test('provider copy promises no charge only for error.charge none; pending_review and missing states are reconciled', t => {
    const { notice } = noticeFixture(t, { onResend: () => assert.fail('automatic resend') });
    for ( const [status, code] of [[502, 'upstream_error'], [502, 'upstream_unavailable'], [504, 'upstream_timeout'], [504, 'upstream_future']] ) {
        for ( const charge of ['none', 'pending_review', undefined, null, '', 'NONE', 'unknown'] ) {
            const failure = refusal(code, status, { charge, actions: ['topup', 'subscribe'] });
            failure.body.charge = 'none';
            notice.show(failure);
            const copy = notice.element.querySelector('.ezil-billing-bar-message').textContent;
            if ( charge === 'none' ) {
                assert.equal(copy, 'The model provider failed. Nothing was charged.');
                assert.doesNotMatch(copy, /reconciled/);
            } else {
                assert.equal(copy, 'The model provider failed. Any usage will be reconciled and charged once.');
                assert.doesNotMatch(copy, /Nothing was charged/);
            }
            assert.equal(action(notice, 'retry').textContent, 'Retry');
            assert.equal(action(notice, 'retry').disabled, false);
            assert.equal(action(notice, 'topup'), null);
            assert.equal(action(notice, 'subscribe'), null);
        }
    }
});

test('402 balance envelope uses USD strings without inferring USD from v1', t => {
    const { popup } = fixture(t, { wallet: wallet('999000000') });
    popup.open(refusal('insufficient_credits', 402, {
        balance: { includedUsdMicro: '20000000', purchasedUsdMicro: '1500000' }, requiredUsdMicro: '30000000', plan: 'free',
    }));
    assert.match(popup.element.textContent, /\$20.00Purchased\$1.50/);
    assert.match(popup.element.textContent, /This request needs \$30.00\./);
    popup.open({ ...refusal(), wallet: { version: 1, balance_microcredits: '1234' } });
    assert.match(popup.element.textContent, /1234 microcredits/);
    assert.doesNotMatch(popup.element.textContent, /\$/);
});

test('close/reopen preserves the entire draft and never automatically resends', async t => {
    const draft = Object.freeze({ text: 'Keep this draft <script>', attachments: Object.freeze(['file-1']) });
    let sends = 0;
    const { popup, doc, dom } = fixture(t, { draft, onResend: () => { sends++; } });
    doc.querySelector('#editor').focus();
    popup.open(refusal());
    action(popup, 'close').click();
    assert.equal(doc.activeElement.id, 'editor');
    assert.equal(popup.draft, draft);
    popup.open();
    popup.element.dispatchEvent(new dom.window.Event('cancel', { cancelable: true }));
    popup.open();
    await tick();
    assert.equal(popup.draft, draft);
    assert.equal(sends, 0);
    assert.equal(doc.querySelectorAll('dialog').length, 1);
});

test('an explicit resend passes the saved draft once despite duplicate clicks', async t => {
    const draft = { text: 'same draft' };
    const received = [];
    let finish;
    const { popup } = fixture(t, { draft, onResend: value => { received.push(value); return new Promise(resolve => { finish = resolve; }); } });
    popup.open(refusal());
    const resend = action(popup, 'resend');
    resend.click();
    resend.click();
    action(popup, 'resend').click();
    assert.deepEqual(received, [draft]);
    finish();
    await tick();
    assert.equal(popup.element, null);
    assert.equal(popup.draft, draft);
});

test('second native double-click event is ignored even after a fast resend failure', async t => {
    let sends = 0;
    const { popup, dom } = fixture(t, { onResend: () => { sends++; throw new Error('offline'); } });
    popup.open(refusal());
    action(popup, 'resend').dispatchEvent(new dom.window.MouseEvent('click', { detail: 1 }));
    await tick();
    action(popup, 'resend').dispatchEvent(new dom.window.MouseEvent('click', { detail: 2 }));
    assert.equal(sends, 1);
    action(popup, 'resend').dispatchEvent(new dom.window.MouseEvent('click', { detail: 1 }));
    assert.equal(sends, 2);
});

test('return URL alone never confirms payment; polling is bounded and does not resend', async t => {
    let reads = 0;
    let checkouts = 0;
    const { popup } = fixture(t, {
        wallet: wallet('0', '0'),
        onResend: () => assert.fail('automatic resend'),
        startCheckout: () => { checkouts++; return { success: true, returnUrl: 'https://ezil.local/?payment=success' }; },
        refreshWallet: () => { reads++; return wallet('0', '0'); },
    });
    popup.open(refusal('insufficient_credits', 402, { requiredUsdMicro: '1200000' }));
    const topup = action(popup, 'topup');
    topup.click();
    topup.click();
    await until(() => popup.checkoutState === 'unconfirmed');
    assert.equal(checkouts, 1);
    assert.equal(reads, 3);
    assert.match(popup.element.textContent, /Payment not confirmed yet/);
    assert.equal(action(popup, 'resend').disabled, true);
});

test('wallet changes after checkout update both buckets without reopening or sending', async t => {
    let reads = 0;
    const { popup } = fixture(t, {
        draft: 'retained', onResend: () => assert.fail('automatic resend'), startCheckout: () => 'returned',
        refreshWallet: () => ++reads === 1 ? wallet() : wallet('20000000', '5000000'),
    });
    popup.open(refusal());
    action(popup, 'topup').click();
    popup.close();
    await until(() => popup.checkoutState === 'updated');
    assert.equal(reads, 2);
    assert.equal(popup.element, null);
    popup.open();
    assert.equal(popup.draft, 'retained');
    assert.match(popup.element.textContent, /Purchased\$5.00/);
});

test('failed or hung wallet reads exhaust a bounded budget without confirming', async t => {
    let reads = 0;
    const { popup } = fixture(t, {
        startCheckout: () => {}, requestTimeoutMs: 5,
        refreshWallet: () => { reads++; return reads === 1 ? Promise.reject(new Error('offline')) : new Promise(() => {}); },
    });
    popup.open(refusal());
    action(popup, 'topup').click();
    await until(() => popup.checkoutState === 'unconfirmed');
    assert.equal(reads, 3);
});

test('wallet badge handles v2 and v1 without converting legacy credit to dollars', async t => {
    const { doc } = fixture(t);
    let call;
    const data = await fetchWallet({ fetchImpl: async (url, options) => { call = { url, options }; return { ok: true, json: async () => wallet() }; } });
    assert.equal(call.url, '/v1/wallet');
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.cache, 'no-store');
    const badge = createWalletBadge({ config, document: doc, wallet: data });
    assert.equal(badge.element.textContent, 'AI balance $20.00');
    assert.match(badge.element.title, /Included credit: \$20.00 · Purchased credit: \$0.00/);
    badge.update({ version: 1, balance_microcredits: '9007199254740993' });
    assert.equal(badge.element.textContent, '9007199254740993 microcredits');
    assert.equal(walletSummary({ version: 1, balance: 42 }).label, 'Legacy credit wallet');
    assert.equal(walletSummary({ version: 1 }, () => '42 credits').label, '42 credits');
    badge.update(wallet('invalid'));
    assert.equal(badge.element.textContent, 'Balance unavailable');
});

test('chat adapter clones responses and supplies a fresh request ID only on explicit resend', async t => {
    const { doc } = fixture(t);
    const requests = [];
    const draft = { text: 'retry me', attachments: ['a'] };
    const adapter = attachToChat({
        config, document: doc, walletMount: doc.body,
        fetchImpl: async () => ({ ok: true, json: async () => wallet() }),
        onResend: (...args) => { requests.push(args); throw new Error('offline'); },
    });
    t.after(() => adapter.dispose());
    await adapter.ready;
    const response = new Response(JSON.stringify(refusal().body), { status: 402 });
    assert.equal(await adapter.handleResponse(response, draft), true);
    assert.equal(response.bodyUsed, false);
    assert.equal(requests.length, 0);
    action(adapter.popup, 'resend').click();
    await tick();
    action(adapter.popup, 'resend').click();
    await tick();
    assert.equal(requests.length, 2);
    assert.equal(requests[0][0], draft);
    assert.notEqual(requests[0][1].requestId, requests[1][1].requestId);
    assert.match(requests[0][1].requestId, /^[\da-f-]{36}$/);
    assert.equal(await adapter.handleResponse(new Response('bad json', { status: 502 }), draft), false);
});

test('compute picker uses server shapes, eligibility, Upgrade, and confirmation before change', async t => {
    const { doc, dom } = fixture(t);
    let upgraded = false;
    let confirm;
    let warning;
    const changes = [];
    const picker = mountComputeSize(doc.body, {
        config, getComputer: () => ({ id: 'c-1' }),
        getShapes: async () => [
            { id: 'standard', vcpu: 2, memoryGiB: 6, diskGB: 16, eligible: true },
            { id: 'performance', vcpu: 4, memoryGiB: 12, diskGB: 20, eligible: upgraded, reason: 'subscription_required' },
        ],
        onUpgrade: () => { upgraded = true; },
        confirmChange: ({ message }) => { warning = message; return new Promise(resolve => { confirm = resolve; }); },
        changeShape: change => { changes.push(change); },
    });
    await picker.ready;
    // DESIGN.md §4: card layout and copy; behaviour assertions below are unchanged.
    assert.match(picker.element.textContent, /Computer size/);
    assert.match(picker.element.querySelector('[data-shape="performance"]').textContent, /4 vCPU.*12 GiB.*20 GB/);
    assert.match(picker.element.textContent, /Requires EZiL Cloud/);
    assert.equal(picker.element.querySelector('script'), null);
    assert.equal(picker.element.querySelector('[data-shape="performance"]').disabled, true);
    picker.element.querySelector('[data-shape="performance"]').click();
    assert.equal(warning, undefined);
    picker.element.querySelector('[data-action="upgrade"]').click();
    await tick();
    const performance = () => picker.element.querySelector('[data-shape="performance"]');
    assert.equal(performance().disabled, false);
    performance().click();
    // DESIGN.md §4 confirm copy: restart, files kept, running state closed.
    assert.match(warning, /^Restart into /);
    assert.match(warning, /Your files are kept/);
    assert.match(warning, /Open apps, terminals and unsaved editor changes are closed/);
    assert.equal(changes.length, 0);
    confirm(false);
    await tick();
    assert.equal(changes.length, 0);
    performance().click();
    performance().dispatchEvent(new dom.window.MouseEvent('click', { detail: 2 }));
    confirm(true);
    await tick();
    assert.deepEqual(changes, [{ computerId: 'c-1', shape: 'performance' }]);
});

test('compute picker separates localised eligibility reasons from shape labels', async t => {
    const { doc } = fixture(t);
    let reason = 'subscription_required';
    const picker = mountComputeSize(doc.body, {
        config,
        getShapes: async () => [{ id: 'performance', vcpu: 4, memoryGiB: 12, diskGB: 20, eligible: false, reason }],
    });
    await picker.ready;
    const assertReason = copy => {
        const button = picker.element.querySelector('[data-shape="performance"]');
        assert.equal(button.disabled, true);
        // DESIGN.md §4: the localised reason is its own element inside the card.
        assert.equal(button.querySelector('.ezil-billing-compute-reason').textContent, copy);
        assert.equal(button.title, copy);
        assert.match(button.textContent, /20 GB/);
        assert.doesNotMatch(picker.element.textContent, /subscription_required|future_reason|<script>/);
        assert.equal(picker.element.querySelector('script'), null);
    };
    assertReason('Requires EZiL Cloud');
    for ( reason of ['future_reason', 'Active subscription required <script>', undefined, null, ''] ) {
        await picker.refresh();
        assertReason('Not available on your plan');
    }
    const previousI18n = globalThis.i18n;
    t.after(() => {
        if ( previousI18n === undefined ) delete globalThis.i18n;
        else globalThis.i18n = previousI18n;
    });
    globalThis.i18n = key => ({
        compute_card_requires_cloud: 'Abonnement requis',
        compute_ineligible: 'Indisponible avec votre forfait',
    })[key] ?? key;
    reason = 'subscription_required';
    await picker.refresh();
    assertReason('Abonnement requis');
    reason = 'future_reason';
    await picker.refresh();
    assertReason('Indisponible avec votre forfait');
});
