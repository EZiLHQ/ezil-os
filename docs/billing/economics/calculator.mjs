#!/usr/bin/env node
/**
 * Billing v2 contribution calculator. Exact rational arithmetic (BigInt), so
 * every published figure is reproducible from `rates.json` without float drift.
 *
 *   node docs/billing/economics/calculator.mjs            # print the table
 *   node docs/billing/economics/calculator.mjs --markdown # regenerate ECONOMICS-v2.md body
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
    constructor(n, d = 1n) { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); this.n = n / g; this.d = d / g; }
    static of(x) {
        if (x instanceof Q) return x;
        if (typeof x === 'bigint') return new Q(x);
        if (typeof x === 'number') { if (!Number.isInteger(x)) throw new Error(`float ${x} — pass a decimal string`); return new Q(BigInt(x)); }
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    if (process.argv.includes('--markdown')) console.log(markdown());
    else console.log(JSON.stringify(table(), null, 2));
}
