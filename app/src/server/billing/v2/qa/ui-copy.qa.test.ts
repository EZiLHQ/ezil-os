/**
 * QA: UI honesty (CONTRACT-v2 §1, §4, §5). Reads the shipped shell/pricing sources
 * directly; the five copy-ban lists must be one list.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { getPricingContent } from '@/app/(marketing)/pricing/pricing-content';

const ROOT = path.resolve(__dirname, '../../../../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const REGEX_FILES = [
    'shell/ezil/ui/Settings/billing-sheets-test.mjs',
    'shell/ezil/ui/Settings/billing-test.mjs',
    'shell/ezil/ui/Settings/upgrade-sheet-test.mjs',
    'app/src/app/(marketing)/pricing/pricing.test.ts',
];
const UI_SOURCES = [
    'shell/ezil/ui/Settings/tabs/billing.js', 'shell/ezil/ui/Settings/billing-sheets.js',
    'shell/ezil/ui/Settings/upgrade-sheet.js', 'shell/ezil/ui/Settings/billing-format.js',
    'app/src/app/(marketing)/pricing/pricing-content.ts', 'app/src/app/(marketing)/_components/home-page.tsx',
];

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

    it('no shipped billing/pricing source contains a banned term or a speed / memory-survival promise', () => {
        const extra = /\bfast\b|speed|in seconds|lightning|blazing|ram is kept|memory is preserved|processes (are )?kept|processes survive|keeps? running after/i;
        const banned = new RegExp(arrayTerms().map(t => t.replace(/ /g, '\\s+')).join('|'), 'i');
        for (const rel of UI_SOURCES) {
            const code = read(rel).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
                // The ban list itself is not copy.
                .replace(/^export const BANNED_COPY = .*$/m, '');
            const strings = [...code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map(m => m[2]).join('\n');
            expect([rel, strings.match(banned)?.[0] ?? null]).toEqual([rel, null]);
            expect([rel, strings.match(extra)?.[0] ?? null]).toEqual([rel, null]);
        }
    });

    it.each([[null], ['2026-12-01T00:00:00Z']])('pricing (Free effective %s): Free never 8 GiB, prices before tax, overage names rate, cap and billed separately, no AI included', effective => {
        const content = getPricingContent(false, effective);
        const text = allText(content);
        const free = (content as unknown as { plans: { id: string }[] }).plans.find(p => p.id === 'free');
        expect(free).toBeDefined();
        expect(allText(free)).not.toMatch(/8\s*GiB/);
        expect(allText(free)).toMatch(/6\s*GiB/);
        expect(text).toMatch(/before tax/i);
        expect(text).toMatch(/\$0\.25 per standard-hour/);
        expect(text).toMatch(/billed separately/i);
        expect(text).toMatch(/cap/i);
        expect(text).toMatch(/\$100/);
        expect(text).not.toMatch(/ai (credit|usage)? ?(is )?included|includes ai|with ai\b/i);
        expect(text).toMatch(/running processes start fresh/i);
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
