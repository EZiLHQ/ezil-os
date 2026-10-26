import test from 'node:test';
import assert from 'node:assert/strict';
import { PACK_SEEDS, createStripe, run } from './stripe-seed-ai-packs.mjs';

function fixture() {
    const products = [], coupons = new Map(), prices = new Map(), calls = [];
    const stripe = {
        products: {
            list: async () => { calls.push('list'); return { data: products, has_more: false }; },
            create: async fields => { const p = { ...fields, id: `prod_${products.length}` }; products.push(p); calls.push('product'); return p; },
            update: async (id, fields) => Object.assign(products.find(p => p.id === id), fields),
        },
        coupons: {
            retrieve: async id => { if (!coupons.has(id)) throw Object.assign(new Error('missing'), { status: 404 }); return coupons.get(id); },
            create: async fields => { const c = { ...fields, valid: true, amount_off: null }; coupons.set(c.id, c); calls.push('coupon'); return c; },
        },
        prices: {
            retrieve: async id => prices.get(id),
            create: async fields => { const p = { ...fields, id: `price_${prices.size}`, active: true, type: 'one_time' }; prices.set(p.id, p); calls.push('price'); return p; },
        },
    };
    const output = [];
    return { products, prices, coupons, calls, output, options: { stripe, env: { STRIPE_SECRET: 'sk_test_fixture' }, write: text => output.push(text) } };
}

test('dry-run needs no key and never calls Stripe or prints a key', async () => {
    const f = fixture();
    await run([], f.options);
    await run([], { ...f.options, env: {} });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(JSON.parse(f.output[0]), { mode: 'dry-run', products: PACK_SEEDS });
    assert.ok(!f.output.join('').includes('sk_test_fixture'));
});

test('apply refuses absent, live, and restricted keys before any Stripe call', async () => {
    const f = fixture();
    for (const key of [undefined, '', 'sk_live_fixture', 'rk_test_fixture']) {
        await assert.rejects(run(['--apply'], { ...f.options, env: { STRIPE_SECRET: key } }), /requires STRIPE_SECRET/);
    }
    assert.deepEqual(f.calls, []);
});

test('seeds the three face-value products and coupons idempotently', async () => {
    const f = fixture();
    await run(['--apply'], f.options);
    await run(['--apply'], f.options);
    assert.equal(f.products.length, 3);
    assert.equal(f.prices.size, 3);
    assert.equal(f.coupons.size, 3);
    assert.deepEqual(f.products.map(p => [p.name, p.metadata.ezil_seed, p.metadata.ezil_order]), PACK_SEEDS.map((s, i) => [s.name, `ai_pack_${s.credits}`, String(i + 1)]));
    assert.deepEqual([...f.prices.values()].map(p => p.unit_amount), [10000, 50000, 100000]);
    assert.deepEqual([...f.coupons.values()].map(c => c.percent_off), [20, 30, 30]);
    assert.ok(f.products.every(p => p.metadata.ezil_kind === 'ai_pack' && p.default_price));
});

test('updates a seeded product with an incorrect price and stale metadata', async () => {
    const f = fixture();
    await run(['--apply'], f.options);
    f.products[0].active = false;
    f.products[0].name = 'old';
    f.products[0].metadata.ezil_credits = '12';
    f.prices.get(f.products[0].default_price).unit_amount = 12;
    await run(['--apply'], f.options);
    assert.equal(f.products.length, 3);
    assert.equal(f.products[0].active, true);
    assert.equal(f.products[0].name, PACK_SEEDS[0].name);
    assert.equal(f.products[0].metadata.ezil_credits, '1000');
    assert.equal(f.prices.get(f.products[0].default_price).unit_amount, 10000);
});

test('fails on coupon retrieval errors or conflicting discounts without creating products', async () => {
    const f = fixture();
    f.options.stripe.coupons.retrieve = async () => { throw Object.assign(new Error('offline'), { status: 500 }); };
    await assert.rejects(run(['--apply'], f.options), /offline/);
    f.options.stripe.coupons.retrieve = async () => ({ valid: true, percent_off: 40 });
    await assert.rejects(run(['--apply'], f.options), /does not match/);
    assert.equal(f.products.length, 0);
});

test('REST adapter encodes metadata and reports only HTTP status on failure', async () => {
    let sent;
    const stripe = createStripe('sk_test_fixture', async (url, init) => { sent = { url, init }; return Response.json({ id: 'prod_test' }); });
    await stripe.products.create({ name: 'AI', metadata: { ezil_kind: 'ai_pack' } }, 'seed:test');
    assert.equal(sent.init.body.get('metadata[ezil_kind]'), 'ai_pack');
    assert.equal(sent.init.headers['Idempotency-Key'], 'seed:test');
    const broken = createStripe('sk_test_fixture', async () => new Response('sk_test_fixture', { status: 403 }));
    await assert.rejects(broken.products.list({ limit: '100' }), { message: 'Stripe request failed (HTTP 403)' });
});
