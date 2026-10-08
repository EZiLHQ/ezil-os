// Local DOM tests; no gateway, checkout provider, or network is contacted.
// Run: node shell/ezil/ui/Billing/billing-test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import {
    attachToChat, classifyGatewayError, createBillingPopup, createWalletBadge,
    fetchWallet, formatUsdMicro, mountComputeSize, walletSummary,
} from './index.js';

const config = { WALLET_V2_ENABLED: true };
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

test('C4 classifies all four families and rejects mismatched/unknown envelopes', () => {
    const cases = [
        [402, 'insufficient_credits', 'topup'], [402, 'no_entitlement', 'subscribe'],
        ...['rate_limited', 'tpm_limited', 'concurrency_limit', 'spend_limit_reached', 'global_cap_reached'].map(code => [429, code, 'retry_later']),
        ...[502, 503, 504].flatMap(status => ['provider_error', 'provider_unavailable', 'upstream_timeout'].map(code => [status, code, 'provider'])),
        [429, 'insufficient_credits', 'unknown'], [402, 'rate_limited', 'unknown'],
        [500, 'provider_error', 'unknown'], [200, 'no_entitlement', 'unknown'], [402, 'future_code', 'unknown'],
    ];
    for ( const [status, code, expected] of cases ) assert.equal(classifyGatewayError(status, { error: { code } }), expected);
    for ( const body of [null, undefined, {}, 'rate_limited', { code: 'rate_limited' }] ) assert.equal(classifyGatewayError(429, body), 'unknown');
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
        adapter.dispose();
    }
    assert.equal(mountComputeSize(doc.body, { getShapes: () => assert.fail('disabled shapes') }), null);
    assert.equal(doc.querySelector('dialog, .ezil-wallet-badge, section'), null);
});

test('402 actions distinguish top-up and subscription; 429 never offers payment', t => {
    const { popup } = fixture(t, { startCheckout: () => {}, refreshWallet: () => wallet() });
    popup.open(refusal());
    assert.equal(action(popup, 'topup').textContent, 'Top up');
    assert.equal(action(popup, 'subscribe').textContent, 'Upgrade plan');
    assert.match(popup.element.textContent, /Included credit\$20.00Purchased credit\$0.00/);
    popup.open({ ...refusal(), wallet: wallet('0', '0', 'subscriber') });
    assert.equal(action(popup, 'subscribe'), null);
    popup.open(refusal('no_entitlement'));
    assert.equal(action(popup, 'topup'), null);
    assert.ok(action(popup, 'subscribe'));
    for ( const code of ['rate_limited', 'tpm_limited', 'concurrency_limit', 'spend_limit_reached', 'global_cap_reached', 'insufficient_credits'] ) {
        popup.open(refusal(code, 429, { actions: ['topup', 'subscribe'], plan: 'free', retryAfterSeconds: 12 }));
        assert.equal(action(popup, 'topup'), null);
        assert.equal(action(popup, 'subscribe'), null);
        assert.equal(action(popup, 'resend'), null);
        if ( code !== 'insufficient_credits' ) {
            assert.equal(action(popup, 'later').textContent, 'Try again later');
            assert.match(popup.element.textContent, /12 seconds/);
        }
    }
    popup.open(refusal('provider_unavailable', 503));
    assert.match(popup.element.textContent, /Nothing was charged/);
    assert.equal(action(popup, 'resend').textContent, 'Retry');
});

test('402 balance envelope uses USD strings without inferring USD from v1', t => {
    const { popup } = fixture(t, { wallet: wallet('999000000') });
    popup.open(refusal('insufficient_credits', 402, {
        balance: { includedUsdMicro: '20000000', purchasedUsdMicro: '1500000' }, requiredUsdMicro: '30000000', plan: 'free',
    }));
    assert.match(popup.element.textContent, /\$20.00Purchased credit\$1.50/);
    assert.match(popup.element.textContent, /Credit required: \$30.00/);
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
        onResend: () => assert.fail('automatic resend'),
        startCheckout: () => { checkouts++; return { success: true, returnUrl: 'https://ezil.local/?payment=success' }; },
        refreshWallet: () => { reads++; return wallet(); },
    });
    popup.open(refusal());
    const topup = action(popup, 'topup');
    topup.click();
    topup.click();
    await until(() => popup.checkoutState === 'unconfirmed');
    assert.equal(checkouts, 1);
    assert.equal(reads, 3);
    assert.match(popup.element.textContent, /Payment is not confirmed/);
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
    assert.match(popup.element.textContent, /Purchased credit\$5.00/);
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
            { id: 'performance', vcpu: 4, memoryGiB: 12, diskGB: 20, eligible: upgraded, reason: 'Active subscription required <script>' },
        ],
        onUpgrade: () => { upgraded = true; },
        confirmChange: ({ message }) => { warning = message; return new Promise(resolve => { confirm = resolve; }); },
        changeShape: change => { changes.push(change); },
    });
    await picker.ready;
    assert.match(picker.element.textContent, /Compute size/);
    assert.match(picker.element.textContent, /4 virtual CPUs · 12 GiB memory · 20 GB disk/);
    assert.match(picker.element.textContent, /Active subscription required/);
    assert.equal(picker.element.querySelector('script'), null);
    assert.equal(picker.element.querySelector('[data-shape="performance"]').disabled, true);
    picker.element.querySelector('[data-shape="performance"]').click();
    assert.equal(warning, undefined);
    picker.element.querySelector('[data-action="upgrade"]').click();
    await tick();
    const performance = () => picker.element.querySelector('[data-shape="performance"]');
    assert.equal(performance().disabled, false);
    performance().click();
    assert.match(warning, /restarts this computer/);
    assert.match(warning, /Saved files are kept/);
    assert.match(warning, /Running apps, processes, open terminals, and unsaved editor buffers are not kept/);
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
