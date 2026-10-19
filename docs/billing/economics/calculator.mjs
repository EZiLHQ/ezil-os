#!/usr/bin/env node
/**
 * Billing v2/v3 contribution calculator. Exact rational arithmetic (BigInt), so
 * every published figure is reproducible from `rates.json` without float drift.
 *
 *   node docs/billing/economics/calculator.mjs            # print the table
 *   node docs/billing/economics/calculator.mjs --markdown # regenerate ECONOMICS-v2.md body
 *   node docs/billing/economics/calculator.mjs --markdown-v3 # generate ECONOMICS-v3.md
 *
 * These are CONTRIBUTION estimates before salaries, tax, AI (unless the AI
 * sensitivity is applied), backup/replication and exceptional network. They are
 * not profit, and the operations reserve is not a guaranteed ceiling.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const RATES = JSON.parse(readFileSync(join(here, 'rates.json'), 'utf8'));

// ── exact rationals ──────────────────────────────────────────────────────────
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
export class Q {
    constructor(n, d = 1n) { if (d === 0n) throw new RangeError('zero denominator'); if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); this.n = n / g; this.d = d / g; }
    static of(x) {
        if (x instanceof Q) return x;
        if (typeof x === 'bigint') return new Q(x);
        if (typeof x === 'number') { if (!Number.isSafeInteger(x)) throw new Error(`unsafe integer or float ${x} — pass a decimal string`); return new Q(BigInt(x)); }
        const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(x).trim());
        if (!m) throw new Error(`not a decimal: ${x}`);
        const frac = m[3] ?? '';
        const n = BigInt(m[2] + frac) * (m[1] ? -1n : 1n);
        return new Q(n, 10n ** BigInt(frac.length));
    }
    add(o) { o = Q.of(o); return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
    sub(o) { o = Q.of(o); return new Q(this.n * o.d - o.n * this.d, this.d * o.d); }
    mul(o) { o = Q.of(o); return new Q(this.n * o.n, this.d * o.d); }
    div(o) { o = Q.of(o); return new Q(this.n * o.d, this.d * o.n); }
    /** Round half away from zero to `dp` decimals, as a string. */
    toFixed(dp = 4) {
        const scale = 10n ** BigInt(dp);
        const neg = this.n < 0n;
        const abs = neg ? -this.n : this.n;
        let q = (abs * scale) / this.d;
        const r = (abs * scale) % this.d;
        if (r * 2n >= this.d) q += 1n;
        const s = q.toString().padStart(dp + 1, '0');
        const out = dp ? `${s.slice(0, -dp)}.${s.slice(-dp)}` : s;
        return (neg && q !== 0n ? '-' : '') + out;
    }
}
const sum = xs => xs.reduce((a, x) => a.add(x), new Q(0n));

// ── model ────────────────────────────────────────────────────────────────────
export const DEFAULT_MODEL = Object.freeze({
    subscribers: 100,
    warmSpares: 2,
    warmSpareHours: '730',
    bootDiskGB: 30,
    workspaceDiskGB: 60,
    freeUsersPerPaid: 5,
    freeHoursEach: 2,
    freeStorageGB: 2,
    opsReservePerPaid: '3',
    aiGatePerPaid: '0',
});

/**
 * Monthly contribution of ONE paid subscriber at full use of its allowance.
 * `instance` runs `hours`; warm spares (the 2-vCPU type of the same family) are
 * shared across `subscribers`.
 */
export function contribution({ priceUsd, region, instance, hours, spareInstance, model = DEFAULT_MODEL }) {
    const r = RATES;
    const hr = Q.of(r.hours_per_month);
    const ec2 = name => Q.of(r.ec2_hourly[region][name] ?? (() => { throw new Error(`no rate ${region}/${name}`); })());
    const gp3 = Q.of(r.gp3_gb_month[region]);
    const ipv4 = Q.of(r.public_ipv4_hour);
    const n = Q.of(model.subscribers);
    const spares = Q.of(model.warmSpares);
    const spareHours = Q.of(model.warmSpareHours);
    const h = Q.of(hours);
    const price = Q.of(priceUsd);

    const lines = {
        fees: price.mul(r.fees.rate).add(r.fees.fixed),
        compute: h.mul(ec2(instance)),
        workspaceDisk: Q.of(model.workspaceDiskGB).mul(gp3),
        bootDisk: Q.of(model.bootDiskGB).mul(gp3).mul(h).div(hr),
        ipv4Active: h.mul(ipv4),
        ipv4Warm: spares.mul(spareHours).mul(ipv4).div(n),
        warmCompute: spares.mul(spareHours).mul(ec2(spareInstance)).div(n),
        warmBootDisk: spares.mul(model.bootDiskGB).mul(gp3).div(n),
        cloudflareBase: Q.of(r.cloudflare.workers_paid_base_month).div(n),
        freeUsersCompute: Q.of(model.freeUsersPerPaid).mul(model.freeHoursEach).mul(r.cloudflare.standard3_hour_at_20pct_cpu),
        freeUsersStorage: Q.of(model.freeUsersPerPaid).mul(model.freeStorageGB).mul(r.cloudflare.r2_gb_month),
        opsReserve: Q.of(model.opsReservePerPaid),
        aiGate: Q.of(model.aiGatePerPaid),
    };
    const cost = sum(Object.values(lines));
    return { revenue: price, lines, cost, contribution: price.sub(cost) };
}

/** Cost base of the warm pool with zero subscribers. */
export function idlePoolBase({ region, spareInstance, model = DEFAULT_MODEL }) {
    const r = RATES;
    const spares = Q.of(model.warmSpares);
    const spareHours = Q.of(model.warmSpareHours);
    return sum([
        spares.mul(spareHours).mul(r.ec2_hourly[region][spareInstance]),
        spares.mul(model.bootDiskGB).mul(r.gp3_gb_month[region]),
        spares.mul(spareHours).mul(r.public_ipv4_hour),
        Q.of(r.cloudflare.workers_paid_base_month),
    ]);
}

/** Compute cost of one extra standard-hour on an 8-vCPU instance (= hourly / 4). */
export function extraStdHourCost({ region, instance }) {
    return Q.of(RATES.ec2_hourly[region][instance]).div(4n);
}

export const SCENARIOS = Object.freeze({
    standard: [
        { name: 'T4g Mumbai (baseline CPU)', region: 'ap-south-1', instance: 't4g.large', spareInstance: 't4g.large' },
        { name: 'T4g Mumbai (full CPU, surplus credits)', region: 'ap-south-1', instance: 't4g.large@full_cpu', spareInstance: 't4g.large' },
        { name: 'M7g Mumbai', region: 'ap-south-1', instance: 'm7g.large', spareInstance: 'm7g.large' },
        { name: 'M7g US East', region: 'us-east-1', instance: 'm7g.large', spareInstance: 'm7g.large' },
        { name: 'M6i Mumbai (current x86)', region: 'ap-south-1', instance: 'm6i.large', spareInstance: 'm6i.large' },
        { name: 'M6i US East (current x86)', region: 'us-east-1', instance: 'm6i.large', spareInstance: 'm6i.large' },
    ].map(s => ({ ...s, priceUsd: '20', hours: '60' })),
    compute: [
        { name: 'M7g Mumbai 8 vCPU', region: 'ap-south-1', instance: 'm7g.2xlarge', spareInstance: 'm7g.large' },
        { name: 'M7g US East 8 vCPU', region: 'us-east-1', instance: 'm7g.2xlarge', spareInstance: 'm7g.large' },
        { name: 'M6i Mumbai 8 vCPU (current x86)', region: 'ap-south-1', instance: 'm6i.2xlarge', spareInstance: 'm6i.large' },
        { name: 'M6i US East 8 vCPU (current x86)', region: 'us-east-1', instance: 'm6i.2xlarge', spareInstance: 'm6i.large' },
    ].map(s => ({ ...s, priceUsd: '100', hours: '125' })),
});

export function table(model = DEFAULT_MODEL) {
    const row = s => {
        const c = contribution({ ...s, model });
        return { scenario: s.name, revenue: c.revenue.toFixed(2), cost: c.cost.toFixed(4), contribution: c.contribution.toFixed(4) };
    };
    return { standard: SCENARIOS.standard.map(row), compute: SCENARIOS.compute.map(row) };
}

function markdown() {
    const out = [];
    const t = table();
    const withAi = table({ ...DEFAULT_MODEL, aiGatePerPaid: '3' });
    const legacy = table({ ...DEFAULT_MODEL, freeHoursEach: 8 });
    out.push('| Plan | Scenario | Revenue | Cost | Contribution | with $3 AI gate | with legacy 8 h Free |');
    out.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
    for (const plan of ['standard', 'compute']) {
        t[plan].forEach((r, i) => {
            out.push(`| ${plan} | ${r.scenario} | ${r.revenue} | ${r.cost} | **${r.contribution}** | ${withAi[plan][i].contribution} | ${legacy[plan][i].contribution} |`);
        });
    }
    out.push('');
    out.push('| Idle warm pool (2 spares, 0 users) | Monthly |');
    out.push('| --- | ---: |');
    for (const [name, region, spare] of [['T4g Mumbai', 'ap-south-1', 't4g.large'], ['M7g Mumbai', 'ap-south-1', 'm7g.large'], ['M6i Mumbai', 'ap-south-1', 'm6i.large'], ['M6i US East', 'us-east-1', 'm6i.large']]) {
        out.push(`| ${name} | ${idlePoolBase({ region, spareInstance: spare }).toFixed(3)} |`);
    }
    out.push('');
    out.push('| Overage: compute cost per extra standard-hour (8 vCPU ÷ 4) | Cost | Retail | Gross margin before fees/network/storage |');
    out.push('| --- | ---: | ---: | ---: |');
    for (const [name, region, inst] of [['M7g Mumbai', 'ap-south-1', 'm7g.2xlarge'], ['M7g US East', 'us-east-1', 'm7g.2xlarge'], ['M6i Mumbai', 'ap-south-1', 'm6i.2xlarge'], ['M6i US East', 'us-east-1', 'm6i.2xlarge']]) {
        const c = extraStdHourCost({ region, instance: inst });
        out.push(`| ${name} | ${c.toFixed(6)} | 0.25 | ${Q.of('0.25').sub(c).toFixed(6)} |`);
    }
    return out.join('\n');
}

// ── v3: actual running hours, no overage ─────────────────────────────────────
// Snapshots of the pinned billing and pool contracts; no app/runtime dependency.
export const PLANS_V3 = Object.freeze({
    free: Object.freeze({ name: 'Free', priceUsd: '0', instance: 'standard-3', fairUseHours: '5', legacyFairUseHours: '8' }),
    standard: Object.freeze({ name: 'Standard', priceUsd: '20', instance: 'm6i.large', fairUseHours: '40', workspaceDiskGB: '30' }),
    premium: Object.freeze({ name: 'Premium', priceUsd: '40', instance: 'm6i.xlarge', fairUseHours: '80', workspaceDiskGB: '60' }),
});
// POOL-CONTRACT.md specifies POOL_POLICY; ready-pool.ts in this checkout has
// not yet implemented it. Premium has min 0; additional idle host-hours are
// explicit model inputs, separate from adopted hosts' paid runtime.
export const POOL_POLICY_V3 = Object.freeze({
    'ap-south-1': Object.freeze({ name: 'Mumbai', standardMinSpares: 1, premiumMinSpares: 0 }),
    'us-east-1': Object.freeze({ name: 'US East', standardMinSpares: 0, premiumMinSpares: 0 }),
});
export const SUBSCRIBERS_V3 = Object.freeze([25, 100, 500]);
export const DEFAULT_MODEL_V3 = Object.freeze({
    subscribers: 100,
    bootDiskGB: '30',
    freeUsersPerPaid: '5',
    freeStorageGB: '2',
    typicalHoursEach: '7',
    opsReservePerPaid: '2',
    extraStandardSpareHours: '0',
    premiumSpareHours: '0',
});

const minQ = (a, b) => a.n * b.d <= b.n * a.d ? a : b;
function modelV3(overrides) {
    const model = { ...DEFAULT_MODEL_V3, ...overrides };
    const result = {};
    for (const key of Object.keys(DEFAULT_MODEL_V3)) {
        const q = Q.of(model[key]);
        if (q.n < 0n) throw new RangeError(`${key} must be nonnegative`);
        result[key] = q;
    }
    if (result.subscribers.n === 0n || result.subscribers.d !== 1n) {
        throw new RangeError('subscribers must be a positive integer');
    }
    return result;
}
function policyV3(region) {
    if (!Object.hasOwn(POOL_POLICY_V3, region)) throw new Error(`unknown v3 region: ${region}`);
    return POOL_POLICY_V3[region];
}
function checkUsageV3(usage, legacyFree) {
    if (!['full', 'typical'].includes(usage)) throw new Error(`unknown v3 usage: ${usage}`);
    if (typeof legacyFree !== 'boolean') throw new TypeError('legacyFree must be boolean');
}

/** Direct monthly cost of one Free user, before shared Workers and ops costs. */
export function freeCostV3({ usage = 'full', legacyFree = false, model = {} } = {}) {
    checkUsageV3(usage, legacyFree);
    const m = modelV3(model);
    const cap = Q.of(legacyFree ? PLANS_V3.free.legacyFairUseHours : PLANS_V3.free.fairUseHours);
    const hours = usage === 'full' ? cap : minQ(m.typicalHoursEach, cap);
    const lines = {
        compute: hours.mul(RATES.cloudflare.standard3_hour_at_20pct_cpu),
        storage: m.freeStorageGB.mul(RATES.cloudflare.r2_gb_month),
    };
    const cost = sum(Object.values(lines));
    return { hours, revenue: Q.of(0), lines, cost, contribution: cost.mul(-1) };
}

/** Total monthly idle pool cost (not divided by subscribers, excludes Workers). */
export function warmPoolV3({ region = 'ap-south-1', model = {} } = {}) {
    const policy = policyV3(region);
    const m = modelV3(model);
    const month = Q.of(RATES.hours_per_month);
    const standardHours = month.mul(policy.standardMinSpares).add(m.extraStandardSpareHours);
    const premiumHours = month.mul(policy.premiumMinSpares).add(m.premiumSpareHours);
    const hours = standardHours.add(premiumHours);
    const lines = {
        warmCompute: standardHours.mul(RATES.ec2_hourly[region]['m6i.large'])
            .add(premiumHours.mul(RATES.ec2_hourly[region]['m6i.xlarge'])),
        warmBootDisk: hours.mul(m.bootDiskGB).mul(RATES.gp3_gb_month[region]).div(month),
        ipv4Warm: hours.mul(RATES.public_ipv4_hour),
    };
    return { standardHours, premiumHours, lines, cost: sum(Object.values(lines)) };
}

/**
 * Contribution per paid subscriber. N is the TOTAL paid population sharing
 * this regional pool (both plans combined). Fees use the pre-tax plan price;
 * collected sales tax is not revenue and fee-on-tax overhead is not estimated.
 * Typical hours are capped by each plan's actual fair-use allowance.
 */
export function contributionV3({
    plan = 'standard', region = 'ap-south-1', usage = 'full',
    managedPayments = true, legacyFree = false, model = {},
} = {}) {
    if (!Object.hasOwn(PLANS_V3, plan) || plan === 'free') throw new Error(`unknown v3 paid plan: ${plan}`);
    policyV3(region);
    checkUsageV3(usage, legacyFree);
    if (typeof managedPayments !== 'boolean') throw new TypeError('managedPayments must be boolean');
    const m = modelV3(model);
    const offer = PLANS_V3[plan];
    const cap = Q.of(offer.fairUseHours);
    const hours = usage === 'full' ? cap : minQ(m.typicalHoursEach, cap);
    const revenue = Q.of(offer.priceUsd);
    const gp3 = Q.of(RATES.gp3_gb_month[region]);
    const fees = {
        card: revenue.mul(RATES.fees_v3.card_rate).add(RATES.fees_v3.card_fixed),
        billing: revenue.mul(RATES.fees_v3.billing_rate),
        managedPayments: managedPayments ? revenue.mul(RATES.fees_v3.managed_payments_rate) : Q.of(0),
    };
    const free = freeCostV3({ usage, legacyFree, model: m });
    const pool = warmPoolV3({ region, model: m });
    const lines = {
        fees: sum(Object.values(fees)),
        compute: hours.mul(RATES.ec2_hourly[region][offer.instance]),
        workspaceDisk: Q.of(offer.workspaceDiskGB).mul(gp3),
        bootDisk: m.bootDiskGB.mul(gp3).mul(hours).div(RATES.hours_per_month),
        ipv4Active: hours.mul(RATES.public_ipv4_hour),
        ...Object.fromEntries(Object.entries(pool.lines).map(([key, value]) => [key, value.div(m.subscribers)])),
        cloudflareBase: Q.of(RATES.cloudflare.workers_paid_base_month).div(m.subscribers),
        freeUsersCompute: free.lines.compute.mul(m.freeUsersPerPaid),
        freeUsersStorage: free.lines.storage.mul(m.freeUsersPerPaid),
        opsReserve: m.opsReservePerPaid,
    };
    const cost = sum(Object.values(lines));
    const contribution = revenue.sub(cost);
    return { revenue, hours, freeHoursEach: free.hours, fees, lines, cost, contribution,
        meetsNoLossRule: contribution.n >= contribution.d }; // >= $1, before rounding
}

export function markdownV3() {
    const out = [
        '# Billing v3 economics: Free, Standard and Premium',
        '',
        'Generated with exact BigInt rationals from [calculator.mjs](economics/calculator.mjs) and [rates.json](economics/rates.json). USD per month; costs and contributions are rounded only for display.',
        '',
        'Regenerate: `node docs/billing/economics/calculator.mjs --markdown-v3 > docs/billing/ECONOMICS-v3.md`.',
        'Validate: `node --test docs/billing/economics/calculator.test.mjs`.',
        '',
        '## Assumptions',
        '',
        '- [Pinned billing contract](CONTRACT-v3.md): Free $0, 5 h (legacy 8 h); Standard $20, 40 h on m6i.large, 30 GB gp3 workspace; Premium $40, 80 h on m6i.xlarge, 60 GB gp3. Workspaces are retained for the full month.',
        '- Full fair use means every paid and Free user reaches their allowance. Typical use applies 7 h per user, capped by their allowance: paid 7 h, new Free 5 h, legacy Free 7 h. [Measured usage](USAGE-2026-10.md) reports p90 7.05 h, rounded to 7 h in this requested scenario. This is a small-sample percentile proxy, not a forecast or the mean.',
        '- Cloudflare standard-3 costs $0.104832/h at the existing 20% CPU assumption. Each paid user supports 5 Free users, each retaining 2 GB R2 at $0.015/GB-month; the $5/month Workers base is shared by N paid subscribers. These storage/base assumptions carry over from v2.',
        '- Each AWS host has a disposable 30 GB gp3 boot disk (the infrastructure default), prorated over 730 h to active or spare hours. Public IPv4 costs $0.005/h for both active and idle hosts. Paid compute, active boot disks and IPv4 are charged for actual running hours.',
        '- The [pinned pool contract](../aws-computers/POOL-CONTRACT.md) specifies POOL_POLICY: Mumbai m6i.large min 1/max 4, m6i.xlarge min 0/max 2; US East min 0. The base model has one Mumbai Standard spare for 730 h and zero Premium spare hours. N = 25, 100 or 500 is the total number of paid subscribers sharing one regional pool, across both paid plans; the pool is allocated once per subscriber.',
        '- Premium spares and Standard capacity above the minimum are on demand. Their idle hours are not measured; base results assume zero additional idle hours. `premiumSpareHours` and `extraStandardSpareHours` add aggregate idle host-hours, including boot disks and IPv4, before division by N. Adopted runtime is already in paid compute. Provisioning and retirement tails require measured extra hours.',
        '- Card processing is 2.9% + $0.30 per monthly invoice; Billing adds 0.7%; Managed Payments (MP, merchant of record) adds 3.5%. Total fees are 3.6% + $0.30 without MP, or 7.1% + $0.30 with MP. These are assigned assumptions, not live account quotes.',
        '- Operations reserve: $2 per paid subscriber. No credits, discounts, AI allowance, salaries, backup/replication or exceptional network costs are included. Contribution is not profit; the reserve is not a cost ceiling.',
        '- Tax collected is not revenue. Prices and fee calculations use the pre-tax subscription subtotal; additional processing fees on collected tax, refunds, disputes, FX and international-card surcharges are not estimated.',
        '- Rates are the checked-in snapshots, not refreshed from AWS, Stripe or Cloudflare. POOL_POLICY is specified by the pinned contract but absent from ready-pool.ts in this checkout; this model snapshots that contract pending implementation.',
        '',
        '| Region | m6i.large / h | m6i.xlarge / h | gp3 / GB-month | Fixed pool / month | Workers base / month |',
        '| --- | ---: | ---: | ---: | ---: | ---: |',
    ];
    for (const [region, policy] of Object.entries(POOL_POLICY_V3)) {
        out.push(`| ${policy.name} | ${RATES.ec2_hourly[region]['m6i.large']} | ${RATES.ec2_hourly[region]['m6i.xlarge']} | ${RATES.gp3_gb_month[region]} | ${warmPoolV3({ region }).cost.toFixed(4)} | ${Q.of(RATES.cloudflare.workers_paid_base_month).toFixed(2)} |`);
    }
    out.push('', '## Free cost and subsidy', '',
        '| Free cohort | Full hours | Full direct cost / user | Typical hours | Typical direct cost / user |',
        '| --- | ---: | ---: | ---: | ---: |');
    for (const legacyFree of [false, true]) {
        const full = freeCostV3({ legacyFree });
        const typical = freeCostV3({ legacyFree, usage: 'typical' });
        out.push(`| ${legacyFree ? 'Legacy' : 'New'} | ${full.hours.toFixed(0)} | ${full.cost.toFixed(6)} | ${typical.hours.toFixed(0)} | ${typical.cost.toFixed(6)} |`);
    }
    const fullLegacyDelta = freeCostV3({ legacyFree: true }).cost.sub(freeCostV3().cost).mul(DEFAULT_MODEL_V3.freeUsersPerPaid);
    const typicalLegacyDelta = freeCostV3({ legacyFree: true, usage: 'typical' }).cost.sub(freeCostV3({ usage: 'typical' }).cost).mul(DEFAULT_MODEL_V3.freeUsersPerPaid);
    out.push('', `Direct Free costs include compute and R2; Free has no revenue. Multiply by 5 for the subsidy per paid subscriber. Tables below use new Free users. If all five are legacy, subtract **$${fullLegacyDelta.toFixed(5)}** from each full-use contribution or **$${typicalLegacyDelta.toFixed(5)}** from each typical-use contribution, in either region and fee mode. For a mixed cohort, multiply that reduction by the legacy fraction.`, '');
    for (const [region, policy] of Object.entries(POOL_POLICY_V3)) {
        out.push(`## ${policy.name}: contribution per paid subscriber`, '',
            '| Plan | N | Full, without MP | Full, with MP | Typical, without MP | Typical, with MP |',
            '| --- | ---: | ---: | ---: | ---: | ---: |');
        for (const plan of ['standard', 'premium']) {
            for (const subscribers of SUBSCRIBERS_V3) {
                const columns = ['full', 'typical'].flatMap(usage => [false, true].map(managedPayments =>
                    contributionV3({ plan, region, usage, managedPayments, model: { subscribers } }).contribution.toFixed(4)));
                out.push(`| ${PLANS_V3[plan].name} | ${subscribers} | ${columns.join(' | ')} |`);
            }
        }
        out.push('');
    }
    const standard = contributionV3();
    const premium = contributionV3({ plan: 'premium' });
    out.push('## Hand-check: Mumbai, N = 100, full fair use, with MP', '',
        '| Monthly line per subscriber | Standard | Premium |',
        '| --- | ---: | ---: |',
        `| Revenue before tax | ${standard.revenue.toFixed(6)} | ${premium.revenue.toFixed(6)} |`);
    const labels = { fees: 'Fees (card + Billing + MP)', compute: 'Paid compute', workspaceDisk: 'Workspace gp3', bootDisk: 'Active boot gp3', ipv4Active: 'Active IPv4', warmCompute: 'Shared warm compute', warmBootDisk: 'Shared warm boot gp3', ipv4Warm: 'Shared warm IPv4', cloudflareBase: 'Shared Workers base', freeUsersCompute: 'Five Free users: compute', freeUsersStorage: 'Five Free users: R2', opsReserve: 'Operations reserve' };
    for (const [key, label] of Object.entries(labels)) out.push(`| ${label} | ${standard.lines[key].toFixed(6)} | ${premium.lines[key].toFixed(6)} |`);
    out.push(`| Total cost | ${standard.cost.toFixed(6)} | ${premium.cost.toFixed(6)} |`,
        `| Contribution | **${standard.contribution.toFixed(6)}** | **${premium.contribution.toFixed(6)}** |`, '',
        'Hand-check equations: Mumbai fixed pool = 730 × (0.101 + 0.005) + 30 × 0.0912 = $80.116/month. New Free compute subsidy = 5 × 5 × 0.104832 = $2.6208. Standard fees = 20 × 0.071 + 0.30 = $1.72; Premium fees = 40 × 0.071 + 0.30 = $3.14. Standard active boot disk = 30 × 0.0912 × 40 / 730; Premium doubles those hours. Sum the exact lines before rounding.', '',
        '## On-demand spares and US East comparison', '',
        'The US East table follows its zero-minimum policy. For an equal warm-service comparison, add one US East m6i.large spare for 730 h: $76.130/month including boot disk and IPv4. Subtract the following from every US East contribution (both plans, both usage scenarios, both fee modes):', '',
        '| N | One US East spare: contribution reduction |', '| ---: | ---: |');
    const usSpare = warmPoolV3({ region: 'us-east-1', model: { extraStandardSpareHours: '730' } }).cost;
    for (const subscribers of SUBSCRIBERS_V3) out.push(`| ${subscribers} | ${usSpare.div(subscribers).toFixed(6)} |`);
    out.push('', 'Each additional **idle host-hour** adds the following total pool cost, divided by N paid subscribers. This includes prorated boot gp3 and IPv4; no workspace disk is attached to an idle spare.', '',
        '| Region | Standard spare / h | Premium spare / h |', '| --- | ---: | ---: |');
    for (const [region, policy] of Object.entries(POOL_POLICY_V3)) {
        const base = warmPoolV3({ region }).cost;
        const extra = key => warmPoolV3({ region, model: { [key]: '1' } }).cost.sub(base).toFixed(8);
        out.push(`| ${policy.name} | ${extra('extraStandardSpareHours')} | ${extra('premiumSpareHours')} |`);
    }
    const stress = { extraStandardSpareHours: '2190', premiumSpareHours: '1460' }; // 3 extra large + 2 xlarge, 730 h
    out.push('', `As an upper idle-capacity sensitivity, holding Mumbai at its policy maxima (4 Standard + 2 Premium spares, all 730 h) adds $${warmPoolV3({ model: stress }).cost.sub(warmPoolV3().cost).toFixed(3)}/month. At N=100, full use with MP contributes $${contributionV3({ model: stress }).contribution.toFixed(4)} Standard / $${contributionV3({ plan: 'premium', model: stress }).contribution.toFixed(4)} Premium. This is a stress case, not measured demand.`, '',
        '## What this means', '',
        `- At N=100 in Mumbai, full fair use with MP contributes **$${standard.contribution.toFixed(4)} Standard / $${premium.contribution.toFixed(4)} Premium**, passing the exact **contribution ≥ $1** rule for both plans. With five legacy Free users, those become $${contributionV3({ legacyFree: true }).contribution.toFixed(4)} / $${contributionV3({ plan: 'premium', legacyFree: true }).contribution.toFixed(4)}.`,
        `- The requested 7 h scenario gives **$${contributionV3({ usage: 'typical' }).contribution.toFixed(4)} / $${contributionV3({ plan: 'premium', usage: 'typical' }).contribution.toFixed(4)}** with MP at N=100 in Mumbai. Validate this against paid usage after launch; 7 h is not an allowance or a guaranteed average.`,
        '- MP reduces contribution by $0.70 on Standard and $1.40 on Premium. The pool costs more per subscriber at small N; on-demand idle hours and the legacy Free mix can consume the remaining margin. The no-loss check covers the stated base assumptions, not unbounded spare demand or excluded costs.',
        '- US East has lower compute/storage rates and no fixed spare under the pinned policy. Use the one-spare adjustment for a comparable warm-service budget. Reconcile pool implementation and measured idle hours before treating these estimates as an operating budget.', '');
    return out.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    if (process.argv.includes('--markdown-v3')) console.log(markdownV3());
    else if (process.argv.includes('--markdown')) console.log(markdown());
    else console.log(JSON.stringify(table(), null, 2));
}
