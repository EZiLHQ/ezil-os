// node --test docs/billing/economics/calculator.test.mjs
// Pins the coordinator's published contribution figures (Notion task
// 3f67021e…, "Research: official rates and economics") to the calculator, so a
// rate or model edit that changes them is visible in review.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contribution, DEFAULT_MODEL, extraStdHourCost, idlePoolBase, Q, SCENARIOS } from './calculator.mjs';

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
