// node --test docs/billing/economics/calculator.test.mjs
// Pins the coordinator's published contribution figures (Notion task
// 3f67021e…, "Research: official rates and economics") to the calculator, so a
// rate or model edit that changes them is visible in review.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { contribution, DEFAULT_MODEL, extraStdHourCost, idlePoolBase, Q, SCENARIOS } from './calculator.mjs';
import { contributionV3, freeCostV3, markdownV3, SUBSCRIBERS_V3, warmPoolV3 } from './calculator.mjs';

const find = (plan, name) => SCENARIOS[plan].find(s => s.name === name);
const c = (plan, name, model) => contribution({ ...find(plan, name), model });

test('exact rational arithmetic rounds half away from zero', () => {
    assert.equal(Q.of('0.1').add('0.2').toFixed(1), '0.3');
    assert.equal(Q.of('2.5').toFixed(0), '3');
    assert.equal(Q.of('-2.5').toFixed(0), '-3');
    assert.throws(() => Q.of(0.1));
});

test('Standard contribution matches the coordinator figures', () => {
    assert.equal(c('standard', 'T4g Mumbai (baseline CPU)').contribution.toFixed(3), '4.965');
    assert.equal(c('standard', 'T4g Mumbai (full CPU, surplus credits)').contribution.toFixed(3), '1.605');
    assert.equal(c('standard', 'M7g Mumbai').contribution.toFixed(3), '3.958');
    assert.equal(c('standard', 'M7g US East').contribution.toFixed(3), '2.926');
    assert.equal(c('standard', 'M6i Mumbai (current x86)').contribution.toFixed(3), '0.772');
});

test('Compute full-use contribution matches the coordinator figures', () => {
    assert.equal(c('compute', 'M7g Mumbai 8 vCPU').contribution.toFixed(3), '53.645');
    assert.equal(c('compute', 'M7g US East 8 vCPU').contribution.toFixed(3), '42.403');
    assert.equal(c('compute', 'M6i Mumbai 8 vCPU (current x86)').contribution.toFixed(3), '31.684');
    assert.equal(c('compute', 'M7g Mumbai 8 vCPU').lines.compute.toFixed(4), '29.1625');
    assert.equal(c('compute', 'M7g US East 8 vCPU').lines.compute.toFixed(2), '40.80');
    assert.equal(c('compute', 'M6i Mumbai 8 vCPU (current x86)').lines.compute.toFixed(2), '50.50');
});

test('sensitivities: $3 AI gate and legacy 8 h Free users', () => {
    const base = c('standard', 'M7g Mumbai').contribution;
    const ai = c('standard', 'M7g Mumbai', { ...DEFAULT_MODEL, aiGatePerPaid: '3' }).contribution;
    assert.equal(base.sub(ai).toFixed(4), '3.0000');
    const legacy = c('standard', 'M7g Mumbai', { ...DEFAULT_MODEL, freeHoursEach: 8 }).contribution;
    assert.equal(base.sub(legacy).toFixed(3), '3.145');
});

test('idle warm pool base and overage unit cost', () => {
    assert.equal(idlePoolBase({ region: 'ap-south-1', spareInstance: 't4g.large' }).toFixed(2), '83.18');
    assert.equal(idlePoolBase({ region: 'ap-south-1', spareInstance: 'm7g.large' }).toFixed(2), '102.89');
    assert.equal(idlePoolBase({ region: 'ap-south-1', spareInstance: 'm6i.large' }).toFixed(3), '165.232');
    assert.equal(extraStdHourCost({ region: 'ap-south-1', instance: 'm7g.2xlarge' }).toFixed(6), '0.058325');
    assert.equal(extraStdHourCost({ region: 'us-east-1', instance: 'm7g.2xlarge' }).toFixed(4), '0.0816');
    assert.equal(extraStdHourCost({ region: 'ap-south-1', instance: 'm6i.2xlarge' }).toFixed(3), '0.101');
});

test('fees and tax: tax collected is never revenue', () => {
    const s = c('standard', 'M7g Mumbai');
    assert.equal(s.revenue.toFixed(2), '20.00');
    assert.equal(s.lines.fees.toFixed(2), '1.32');
});

// v3 figures hand-checked separately using fractions; compare exact fractions,
// not just rounded output, so a line-item omission cannot hide in rounding.
test('v3 Mumbai full use matches hand-checked rational contribution', () => {
    const standard = contributionV3();
    const premium = contributionV3({ plan: 'premium' });
    // Standard: 20 - (1.72 + 4.04 + 2.736 + 109.44/730 + .2
    //                  + .80116 + .05 + 2.6208 + .15 + 2).
    assert.deepEqual(standard.contribution, new Q(10096123n, 1825000n));
    // Premium: 40 - (3.14 + 16.16 + 5.472 + 218.88/730 + .4
    //                 + .80116 + .05 + 2.6208 + .15 + 2).
    assert.deepEqual(premium.contribution, new Q(16253823n, 1825000n));
    assert.equal(standard.contribution.toFixed(6), '5.532122');
    assert.equal(premium.contribution.toFixed(6), '8.906204');
    assert.deepEqual(standard.lines.bootDisk, Q.of('109.44').div(730));
    assert.deepEqual(premium.lines.bootDisk, Q.of('218.88').div(730));
    assert.equal(standard.lines.workspaceDisk.toFixed(3), '2.736');
    assert.equal(premium.lines.workspaceDisk.toFixed(3), '5.472');
    for (const row of [standard, premium]) {
        assert.deepEqual(row.cost, Object.values(row.lines).reduce((a, b) => a.add(b), Q.of(0)));
        assert.deepEqual(row.revenue, row.cost.add(row.contribution));
    }
});

test('v3 paid plans satisfy the exact $1 no-loss rule at N=100, full use with MP', () => {
    for (const region of ['ap-south-1', 'us-east-1']) {
        for (const plan of ['standard', 'premium']) {
            for (const legacyFree of [false, true]) {
                const row = contributionV3({ region, plan, legacyFree, managedPayments: true, usage: 'full', model: { subscribers: 100 } });
                assert.ok(row.contribution.n >= row.contribution.d, `${region}/${plan}/legacy=${legacyFree}`);
                assert.equal(row.meetsNoLossRule, true);
            }
        }
    }
});

test('v3 no-loss check fails under excessive pool costs and does not round up to $1', () => {
    const stress = contributionV3({ model: { extraStandardSpareHours: '2190', premiumSpareHours: '1460' } });
    assert.equal(stress.contribution.toFixed(6), '0.051722');
    assert.equal(stress.meetsNoLossRule, false);
    const small = contributionV3({ model: { subscribers: 1 } });
    assert.ok(small.contribution.n < 0n);
    assert.equal(small.meetsNoLossRule, false);
    const base = contributionV3();
    const reserveForOneDollar = base.lines.opsReserve.add(base.contribution).sub(1);
    const boundary = contributionV3({ model: { opsReservePerPaid: reserveForOneDollar } });
    assert.deepEqual(boundary.contribution, Q.of(1));
    assert.equal(boundary.meetsNoLossRule, true);
    const below = contributionV3({ model: { opsReservePerPaid: reserveForOneDollar.add('0.00001') } });
    assert.equal(below.contribution.toFixed(4), '1.0000');
    assert.equal(below.meetsNoLossRule, false);
});

test('v3 fees keep tax out of revenue and add MP to card and Billing', () => {
    for (const [plan, price, card, billing, mp, noMp, withMp] of [
        ['standard', '20.00', '0.88', '0.14', '0.70', '1.02', '1.72'],
        ['premium', '40.00', '1.46', '0.28', '1.40', '1.74', '3.14'],
    ]) {
        const off = contributionV3({ plan, managedPayments: false });
        const on = contributionV3({ plan, managedPayments: true });
        assert.equal(off.revenue.toFixed(2), price);
        assert.deepEqual(off.revenue, on.revenue);
        assert.equal(on.fees.card.toFixed(2), card);
        assert.equal(on.fees.billing.toFixed(2), billing);
        assert.equal(on.fees.managedPayments.toFixed(2), mp);
        assert.equal(off.fees.managedPayments.n, 0n);
        assert.equal(off.lines.fees.toFixed(2), noMp);
        assert.equal(on.lines.fees.toFixed(2), withMp);
        assert.deepEqual(off.contribution.sub(on.contribution), Q.of(mp));
    }
});

test('v3 Free full and typical costs respect new and legacy allowances', () => {
    const fresh = freeCostV3();
    const legacy = freeCostV3({ legacyFree: true });
    assert.equal(fresh.revenue.n, 0n);
    assert.equal(fresh.lines.compute.toFixed(6), '0.524160');
    assert.equal(fresh.cost.toFixed(6), '0.554160');
    assert.equal(legacy.cost.toFixed(6), '0.868656');
    assert.deepEqual(fresh.contribution, fresh.cost.mul(-1));
    assert.deepEqual(freeCostV3({ usage: 'typical' }), fresh); // 7 h capped at 5
    assert.equal(freeCostV3({ usage: 'typical', legacyFree: true }).cost.toFixed(6), '0.763824');
    for (const [usage, delta] of [['full', '1.57248'], ['typical', '1.04832']]) {
        for (const region of ['ap-south-1', 'us-east-1']) {
            for (const plan of ['standard', 'premium']) {
                const current = contributionV3({ usage, region, plan });
                const older = contributionV3({ usage, region, plan, legacyFree: true });
                assert.deepEqual(current.contribution.sub(older.contribution), Q.of(delta));
            }
        }
    }
});

test('v3 typical paid use is 7 h; persistent storage and idle pool remain charged', () => {
    for (const [plan, expected, compute] of [
        ['standard', new Q(16705693n, 1825000n), '0.707'],
        ['premium', new Q(22165359n, 912500n), '1.414'],
    ]) {
        const full = contributionV3({ plan });
        const typical = contributionV3({ plan, usage: 'typical' });
        assert.deepEqual(typical.contribution, expected);
        assert.equal(typical.hours.toFixed(0), '7');
        assert.equal(typical.freeHoursEach.toFixed(0), '5');
        assert.equal(typical.lines.compute.toFixed(3), compute);
        for (const key of ['workspaceDisk', 'warmCompute', 'warmBootDisk', 'ipv4Warm', 'fees', 'opsReserve']) {
            assert.deepEqual(typical.lines[key], full.lines[key], `${plan}/${key}`);
        }
        assert.deepEqual(contributionV3({ plan, usage: 'typical', model: { typicalHoursEach: '100' } }).contribution, full.contribution);
    }
    const idle = contributionV3({ usage: 'typical', model: { typicalHoursEach: '0' } });
    for (const key of ['compute', 'bootDisk', 'ipv4Active', 'freeUsersCompute']) assert.equal(idle.lines[key].n, 0n);
    assert.equal(idle.lines.workspaceDisk.toFixed(3), '2.736');
    assert.equal(idle.lines.freeUsersStorage.toFixed(2), '0.15');
});

test('v3 warm pool follows regional minimums and allocates once across both plans', () => {
    const pool = warmPoolV3();
    assert.equal(pool.standardHours.toFixed(0), '730');
    assert.equal(pool.premiumHours.n, 0n);
    assert.equal(pool.lines.warmCompute.toFixed(2), '73.73');
    assert.equal(pool.lines.warmBootDisk.toFixed(3), '2.736');
    assert.equal(pool.lines.ipv4Warm.toFixed(2), '3.65');
    assert.equal(pool.cost.toFixed(3), '80.116');
    assert.equal(warmPoolV3({ region: 'us-east-1' }).cost.n, 0n);
    const shares = ['3.20464', '0.80116', '0.160232'];
    for (const [index, subscribers] of SUBSCRIBERS_V3.entries()) {
        const standard = contributionV3({ model: { subscribers } });
        const premium = contributionV3({ plan: 'premium', model: { subscribers } });
        const keys = ['warmCompute', 'warmBootDisk', 'ipv4Warm'];
        const share = keys.reduce((a, key) => a.add(standard.lines[key]), Q.of(0));
        assert.deepEqual(share, Q.of(shares[index]));
        // A population split between plans still pays exactly one pool bill.
        const mixed = keys.reduce((a, key) => a.add(standard.lines[key].mul(10))
            .add(premium.lines[key].mul(subscribers - 10)), Q.of(0));
        assert.deepEqual(mixed, pool.cost);
    }
});

test('v3 on-demand spare hours include compute, boot disk and IPv4, but no workspace', () => {
    const base = warmPoolV3();
    const model = { premiumSpareHours: '100' };
    const more = warmPoolV3({ model });
    assert.deepEqual(more.cost.sub(base.cost), Q.of('20.2').add('0.5').add(Q.of('273.6').div(730)));
    for (const plan of ['standard', 'premium']) {
        const before = contributionV3({ plan });
        const after = contributionV3({ plan, model });
        assert.deepEqual(before.contribution.sub(after.contribution), more.cost.sub(base.cost).div(100));
        assert.deepEqual(before.lines.compute, after.lines.compute);
        assert.deepEqual(before.lines.workspaceDisk, after.lines.workspaceDisk);
    }
    const usEquivalent = warmPoolV3({ region: 'us-east-1', model: { extraStandardSpareHours: '730' } });
    assert.equal(usEquivalent.cost.toFixed(3), '76.130');
});

test('v3 US East full and typical use match independent hand figures', () => {
    for (const [plan, usage, expected] of [
        ['standard', 'full', new Q(314251n, 45625n)],
        ['standard', 'typical', new Q(3770153n, 365000n)],
        ['premium', 'full', new Q(1023477n, 91250n)],
        ['premium', 'typical', new Q(9430573n, 365000n)],
    ]) {
        const row = contributionV3({ region: 'us-east-1', plan, usage });
        assert.deepEqual(row.contribution, expected);
        const equalPool = contributionV3({ region: 'us-east-1', plan, usage, model: { extraStandardSpareHours: '730' } });
        assert.deepEqual(row.contribution.sub(equalPool.contribution), Q.of('0.7613'));
    }
});

test('v3 rejects unknown plans, regions, usage and non-boolean fee/cohort flags', () => {
    for (const plan of ['free', 'compute', 'toString', '']) assert.throws(() => contributionV3({ plan }), /paid plan/);
    for (const region of ['eu-west-1', 'toString', '']) {
        assert.throws(() => contributionV3({ region }), /region/);
        assert.throws(() => warmPoolV3({ region }), /region/);
    }
    assert.throws(() => contributionV3({ usage: 'average' }), /usage/);
    assert.throws(() => freeCostV3({ usage: 'average' }), /usage/);
    assert.throws(() => contributionV3({ managedPayments: 'false' }), /boolean/);
    assert.throws(() => freeCostV3({ legacyFree: 1 }), /boolean/);
});

test('v3 rejects impossible subscriber counts, negative costs and inexact numeric inputs', () => {
    for (const subscribers of [0, -1, '0.5', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
        assert.throws(() => contributionV3({ model: { subscribers } }));
    }
    for (const key of ['bootDiskGB', 'freeUsersPerPaid', 'freeStorageGB', 'typicalHoursEach', 'opsReservePerPaid', 'extraStandardSpareHours', 'premiumSpareHours']) {
        assert.throws(() => contributionV3({ model: { [key]: '-1' } }), /nonnegative/);
    }
    assert.throws(() => warmPoolV3({ model: { premiumSpareHours: 'invalid' } }), /decimal/);
    assert.throws(() => contributionV3({ model: { typicalHoursEach: 7.05 } }), /decimal string/);
    assert.equal(contributionV3({ usage: 'typical', model: { typicalHoursEach: '7.05' } }).hours.toFixed(2), '7.05');
});

test('rationals reject zero denominators, zero divisors and already-rounded unsafe integers', () => {
    assert.throws(() => new Q(1n, 0n), /zero denominator/);
    assert.throws(() => Q.of(0).div(0), /zero denominator/);
    assert.throws(() => Q.of(1).div(0), /zero denominator/);
    assert.throws(() => Q.of(Number.MAX_SAFE_INTEGER + 1), /unsafe integer/);
    assert.deepEqual(new Q(1n, -2n), Q.of('-0.5'));
    assert.equal(Q.of('9007199254740993').add(1).toFixed(0), '9007199254740994');
});

test('v3 markdown regenerates the complete checked-in report deterministically', () => {
    const doc = readFileSync(new URL('../ECONOMICS-v3.md', import.meta.url), 'utf8');
    assert.equal(doc, markdownV3() + '\n');
    assert.match(doc, /Tax collected is not revenue/);
    assert.match(doc, /## What this means/);
});
