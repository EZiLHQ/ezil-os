/**
 * QA: re-derive published ECONOMICS-v2 figures by hand from rates.json (exact
 * scaled integers, not the calculator's Q class) and compare with calculator.mjs
 * and the published markdown.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../../../..');
const rates = JSON.parse(readFileSync(path.join(ROOT, 'docs/billing/economics/rates.json'), 'utf8'));
const doc = readFileSync(path.join(ROOT, 'docs/billing/ECONOMICS-v2.md'), 'utf8');

const S = BigInt(10) ** BigInt(12);
const d = (v: string | number) => {
    const [i, f = ''] = String(v).split('.');
    return BigInt(i) * S + BigInt((f + '0'.repeat(12)).slice(0, 12));
};
const mul = (a: bigint, b: bigint) => a * b / S;
const div = (a: bigint, b: bigint) => a * S / b;
const fmt = (a: bigint, places: number) => {
    const scale = BigInt(10) ** BigInt(12 - places);
    const neg = a < BigInt(0);
    const abs = neg ? -a : a;
    const rounded = (abs + scale / BigInt(2)) / scale;
    const p = BigInt(10) ** BigInt(places);
    return `${neg ? '-' : ''}${rounded / p}.${(rounded % p).toString().padStart(places, '0')}`;
};

describe('qa economics re-derivation', () => {
    it('overage compute cost per extra standard-hour, M6i Mumbai = m6i.2xlarge / 4 = 0.101000; margin 0.149000', async () => {
        const cost = div(d(rates.ec2_hourly['ap-south-1']['m6i.2xlarge']), d(4));
        expect(fmt(cost, 6)).toBe('0.101000');
        expect(fmt(d('0.25') - cost, 6)).toBe('0.149000');
        expect(doc).toContain('| M6i Mumbai | 0.101000 | 0.25 | 0.149000 |');
        const calc = await import(/* @vite-ignore */ path.join(ROOT, 'docs/billing/economics/calculator.mjs'));
        expect(calc.extraStdHourCost({ region: 'ap-south-1', instance: 'm6i.2xlarge' }).toFixed(6)).toBe('0.101000');
    });

    it('Standard on M6i Mumbai, fully used: cost 19.2275, contribution 0.7725, legacy-8h-Free -2.3725', async () => {
        const r = rates;
        const hr = d(r.hours_per_month); const gp3 = d(r.gp3_gb_month['ap-south-1']); const ipv4 = d(r.public_ipv4_hour);
        const large = d(r.ec2_hourly['ap-south-1']['m6i.large']); const price = d(20); const h = d(60); const n = d(100);
        const cf = d(r.cloudflare.standard3_hour_at_20pct_cpu);
        const lines = [
            mul(price, d(r.fees.rate)) + d(r.fees.fixed), // fees 1.32
            mul(h, large), // 60 h × 0.101 = 6.06
            mul(d(60), gp3), // 60 GB workspace
            div(mul(mul(d(30), gp3), h), hr), // boot disk pro-rated
            mul(h, ipv4), // active IPv4
            div(mul(mul(d(2), hr), ipv4), n), // warm IPv4
            div(mul(mul(d(2), hr), large), n), // warm compute
            div(mul(d(2 * 30), gp3), n), // warm boot disks
            div(d(r.cloudflare.workers_paid_base_month), n),
            mul(d(5 * 2), cf), // 5 Free users × 2 h
            mul(d(5 * 2), d(r.cloudflare.r2_gb_month)), // 5 × 2 GB R2
            d(3), // ops reserve
        ];
        const cost = lines.reduce((s, x) => s + x, BigInt(0));
        expect(fmt(cost, 4)).toBe('19.2275');
        expect(fmt(price - cost, 4)).toBe('0.7725');
        const legacy = price - cost - mul(d(5 * 6), cf);
        expect(fmt(legacy, 4)).toBe('-2.3725');
        expect(doc).toContain('| standard | M6i Mumbai (current x86) | 20.00 | 19.2275 | **0.7725** | -2.2275 | -2.3725 |');
        const calc = await import(/* @vite-ignore */ path.join(ROOT, 'docs/billing/economics/calculator.mjs'));
        const row = calc.contribution({ priceUsd: '20', region: 'ap-south-1', instance: 'm6i.large', hours: '60', spareInstance: 'm6i.large' });
        expect(row.cost.toFixed(4)).toBe('19.2275');
        expect(row.contribution.toFixed(4)).toBe('0.7725');
    });
});
