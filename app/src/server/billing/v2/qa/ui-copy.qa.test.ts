/** V3 rendered-copy honesty; existing v2 subscriptions retain their consent terms. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';

import { publicOffers } from '@/server/billing/v3/catalog';
import { getPricingContent } from '@/app/(marketing)/pricing/pricing-content';

const ROOT = path.resolve(__dirname, '../../../../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const REGEX_FILES = [
    'shell/ezil/ui/Settings/billing-sheets-test.mjs',
    'shell/ezil/ui/Settings/billing-test.mjs',
    'shell/ezil/ui/Settings/upgrade-sheet-test.mjs',
    'app/src/app/(marketing)/pricing/pricing.test.ts',
];
// Bundle the actual renderer and sheets, without booting a desktop or using the network.
const appRequire = createRequire(path.join(ROOT, 'app/package.json'));
const shellRequire = createRequire(path.join(ROOT, 'shell/package.json'));
const { buildSync } = appRequire('esbuild');
const { JSDOM } = shellRequire('jsdom');
const bundle = buildSync({
    stdin: { contents: `
        import { summaryV3Html } from './tabs/billing.js';
        import { summaryV3 } from './billing-v3-fixtures.mjs';
        import * as sheets from './billing-sheets.js';
        import { v3CopyForAudit, honestyBans } from './billing-copy-test-helpers.mjs';
        window.copyQA = { summaryV3Html, summaryV3, sheets, v3CopyForAudit, honestyBans };
    `, resolveDir: path.join(ROOT, 'shell/ezil/ui/Settings') },
    bundle: true, write: false, format: 'iife', target: 'es2022',
}).outputFiles[0].text;
const dom = new JSDOM('<!doctype html><body><main></main></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.test/os' });
dom.window.html_encode = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
dom.window.structuredClone = structuredClone;
dom.window.eval(bundle);
const api = dom.window.copyQA;
afterAll(() => dom.window.close());
function summary(tier: string) {
    const value = api.summaryV3(tier);
    value.catalog.offers = publicOffers();
    return value;
}
function assertHonest(copy: string, faq = false) {
    const banned = new RegExp(arrayTerms().map(t => t.replace(/ /g, '\\s+')).join('|'), 'i');
    expect(api.v3CopyForAudit(copy, { faq })).not.toMatch(banned);
    expect(copy).not.toMatch(api.honestyBans);
    expect(copy).not.toMatch(/ai (credit|usage)? ?(is )?included|includes ai|with ai\b/i);
}

function regexTerms(rel: string): string[] {
    const m = read(rel).match(/const banned = \/(.+)\/i;/);
    if (!m) throw new Error(`no banned regex in ${rel}`);
    return m[1].split('|').map(t => t.replace(/\\s\+/g, ' ')).sort();
}
function arrayTerms(): string[] {
    const m = read('shell/ezil/ui/Settings/billing-format.js').match(/export const BANNED_COPY = \[([^\]]+)\]/);
    if (!m) throw new Error('no BANNED_COPY');
    return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort();
}
const allText = (value: unknown): string => typeof value === 'string' ? value
    : Array.isArray(value) ? value.map(allText).join('\n')
        : value && typeof value === 'object' ? Object.values(value).map(allText).join('\n') : '';

describe('qa UI honesty', () => {
    it('the five copy-ban lists are identical', () => {
        const reference = arrayTerms();
        expect(reference.length).toBeGreaterThan(10);
        for (const rel of REGEX_FILES) expect([rel, regexTerms(rel)]).toEqual([rel, reference]);
    });

    it('shell offer fixtures match the pinned public catalog', () => {
        expect(api.summaryV3().catalog.offers).toEqual(publicOffers());
    });

    it.each(['free', 'standard', 'premium'])('v3 %s renders honest plan copy without v2 meters or overage', tier => {
        const value = summary(tier);
        for (const status of ['ok', 'near', 'paused']) {
            value.fairUse.status = status;
            const html = api.summaryV3Html(value);
            assertHonest(html);
            expect(html).not.toMatch(/standard-hour|overage|billed separately|progressbar/i);
            expect(html).toContain('Prices before tax.');
            if (tier === 'free') expect(html).toContain('2 vCPU · 6 GB');
            if (tier === 'premium') for (const spec of ['2 vCPU · 8 GB', '4 vCPU · 16 GB', '8 vCPU · 32 GB']) expect(html).toContain(spec);
        }
    });

    it('v3 plan, upgrade, downgrade and cancellation sheets render honest copy', async () => {
        const container = dom.window.document.querySelector('main');
        for (const [tier, opener] of [['free', 'openPlanPickerSheet'], ['standard', 'openComputeUpgradeSheet'], ['premium', 'openDowngradeSheet'], ['premium', 'openCancelSheet']]) {
            const handle = api.sheets[opener]({ container, summary: summary(tier), trpc: {
                mutate: async () => ({ ok: true, data: { lines: [], amountDueCents: 1200, prorationDate: 1 } }),
            } });
            await new Promise<void>(resolve => setImmediate(resolve));
            const html = dom.window.document.querySelector('[role="dialog"]').outerHTML;
            assertHonest(html);
            expect(html).not.toMatch(/standard-hour|overage|billed separately/i);
            if (opener === 'openComputeUpgradeSheet') {
                expect(html).toContain('$100/month');
                expect(html).toContain('after payment. Your Mumbai computer is prepared then.');
            }
            handle.close();
        }
    });

    it('keeps banned terms and opening/memory promises rejected outside the exact approved phrases', () => {
        for (const copy of ['opens faster', '500 standard-hours', 'instant', 'memory survives', 'Opens from a ready computer', 'opens in seconds', 'Most popular']) {
            expect(() => assertHonest(copy)).toThrow();
        }
        assertHonest('uses time 2× faster');
        assertHonest('uses time 4× faster');
    });

    it.each([[null], ['2026-12-01T00:00:00Z']])('v3 pricing (legacy display flag %s): catalog prices, GB, no overage or AI included', effective => {
        const content = getPricingContent(false, effective);
        const text = allText(content);
        const free = content.plans.find(p => p.id === 'free');
        expect(free).toBeDefined();
        expect(allText(free)).not.toMatch(/8\s*G(?:i)?B/);
        expect(allText(free)).toMatch(/2 vCPU · 6 GB/);
        expect(text).toMatch(/before tax/i);
        expect(text).not.toMatch(/overage|billed separately|\$0\.25/);
        expect(content.plans.map(plan => plan.price)).toEqual(publicOffers().map(offer => `$${offer.priceCents / 100}`));
        expect(allText(content.plans[2])).toContain('2, 4 or 8 vCPU (8, 16 or 32 GB)');
        expect(text).toContain('Running processes stop; they start fresh');
        assertHonest(allText(content.plans));
        assertHonest(text, true);
    });

    it('the overage consent sheet names the rate, the cap and "billed separately" in the consent copy', () => {
        const src = read('shell/ezil/ui/Settings/billing-sheets.js');
        expect(src).toMatch(/money\(overage\.centsPerStdHour\)\} per standard-hour/);
        expect(src).toMatch(/I agree that usage beyond my allowance is billed separately[^`]*up to my cap of/);
        expect(src).toMatch(/termsVersion: overage\.termsVersion/);
    });

    it('the Billing tab session note never claims processes survive the 6 h restart', () => {
        expect(read('shell/ezil/ui/Settings/tabs/billing.js')).toMatch(/running processes start fresh/);
    });
});
