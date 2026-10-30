import { pathToFileURL } from 'node:url';

export const PACK_SEEDS = [
    { credits: 1000, name: 'EZiL AI credits · 1,000', cents: 10000, percent: 20, coupon: 'ezil_ai_pack_100_20' },
    { credits: 5000, name: 'EZiL AI credits · 5,000', cents: 50000, percent: 30, coupon: 'ezil_ai_pack_500_30' },
    { credits: 10000, name: 'EZiL AI credits · 10,000', cents: 100000, percent: 30, coupon: 'ezil_ai_pack_1000_30' },
];

/** Small REST adapter so both dry-run and offline tests need no Stripe package. */
export function createStripe(secret, fetcher = globalThis.fetch) {
    async function request(path, fields, idempotencyKey) {
        const body = new URLSearchParams();
        function append(key, value) {
            if (value !== null && typeof value === 'object') {
                for (const [name, item] of Object.entries(value)) append(`${key}[${name}]`, item);
            } else if (value !== undefined) body.append(key, String(value));
        }
        for (const [key, value] of Object.entries(fields ?? {})) append(key, value);
        const response = await fetcher(`https://api.stripe.com/v1${path}`, {
            method: fields ? 'POST' : 'GET',
            headers: { Authorization: `Bearer ${secret}`, 'Stripe-Version': '2026-09-30.endive',
                ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
                ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
            ...(fields ? { body } : {}),
        });
        if (!response.ok) {
            const error = new Error(`Stripe request failed (HTTP ${response.status})`);
            error.status = response.status;
            throw error;
        }
        return response.json();
    }
    return {
        products: {
            list: params => request(`/products?${new URLSearchParams(params)}`),
            create: (fields, key) => request('/products', fields, key),
            update: (id, fields) => request(`/products/${encodeURIComponent(id)}`, fields),
        },
        prices: {
            retrieve: id => request(`/prices/${encodeURIComponent(id)}`),
            create: (fields, key) => request('/prices', fields, key),
        },
        coupons: {
            retrieve: id => request(`/coupons/${encodeURIComponent(id)}`),
            create: fields => request('/coupons', fields, `seed:${fields.id}`),
        },
    };
}

export async function run(args = [], { env = process.env, stripe, write = console.log } = {}) {
    if (args.some(arg => arg !== '--apply')) throw new Error('Usage: stripe-seed-ai-packs.mjs [--apply]');
    if (!args.includes('--apply')) {
        write(JSON.stringify({ mode: 'dry-run', products: PACK_SEEDS }, null, 2));
        return;
    }
    if (!env.STRIPE_SECRET?.startsWith('sk_test_')) throw new Error('--apply requires STRIPE_SECRET starting with sk_test_');
    stripe ??= createStripe(env.STRIPE_SECRET);
    const products = [];
    let cursor;
    do {
        const page = await stripe.products.list({ limit: '100', ...(cursor ? { starting_after: cursor } : {}) });
        products.push(...page.data);
        const next = page.data.at(-1)?.id;
        if (page.has_more && (!next || next === cursor)) throw new Error('Invalid Stripe pagination');
        cursor = page.has_more ? next : undefined;
    } while (cursor);
    for (const [index, seed] of PACK_SEEDS.entries()) {
        let coupon;
        try { coupon = await stripe.coupons.retrieve(seed.coupon); }
        catch (error) {
            if (error.status !== 404 && error.statusCode !== 404) throw error;
            coupon = await stripe.coupons.create({ id: seed.coupon, percent_off: seed.percent, duration: 'once' });
        }
        if (!coupon.valid || coupon.percent_off !== seed.percent || coupon.amount_off != null)
            throw new Error(`Coupon ${seed.coupon} does not match the seed`);
        const metadata = { ezil_kind: 'ai_pack', ezil_credits: String(seed.credits), ezil_order: String(index + 1),
            ezil_coupon: seed.coupon, ezil_seed: `ai_pack_${seed.credits}` };
        const matches = products.filter(product => product.metadata?.ezil_seed === metadata.ezil_seed);
        if (matches.length > 1) throw new Error(`Duplicate seed ${metadata.ezil_seed}`);
        const fields = { name: seed.name, active: true, tax_code: 'txcd_10103000', metadata };
        const product = matches[0] ?? await stripe.products.create(fields, `seed:${metadata.ezil_seed}`);
        const priceId = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id;
        let price = priceId ? await stripe.prices.retrieve(priceId) : null;
        if (!price?.active || price.type !== 'one_time' || price.currency !== 'usd' || price.unit_amount !== seed.cents
            || price.product !== product.id || price.tax_behavior !== 'inclusive') {
            price = await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: seed.cents,
                tax_behavior: 'inclusive' }, `seed:${product.id}:usd:${seed.cents}:inclusive`);
        }
        await stripe.products.update(product.id, { ...fields, default_price: price.id });
        write(`Seeded ${metadata.ezil_seed}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run(process.argv.slice(2)).catch(() => { console.error('AI pack seed failed; check test-mode configuration and catalog.'); process.exitCode = 1; });
}
