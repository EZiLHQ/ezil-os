import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import LegalLayout from './layout';
import PrivacyPage from './privacy/page';
import RefundsPage, { metadata as refundsMetadata } from './refunds/page';
import TermsPage from './terms/page';

const here = path.dirname(fileURLToPath(import.meta.url));
const legacyOperator = /Private\s+Limited|Bengaluru/i;
const pages = [
    { route: 'terms', Page: TermsPage },
    { route: 'privacy', Page: PrivacyPage },
    { route: 'refunds', Page: RefundsPage },
] as const;

/** Scan production sources so an old operator cannot return in a new legal page. */
function* legalSources(directory: string): Generator<string> {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            yield* legalSources(file);
        } else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
            // Fixtures must be able to name the wording the production scan rejects.
            yield file;
        }
    }
}

function section(html: string, id: string): string {
    const match = html.match(new RegExp(`<section[^>]* id="${id}"[^>]*>([\\s\\S]*?)</section>`));
    expect(match, `section ${id} must be rendered`).toBeTruthy();
    return match![1]!;
}

/** Each paragraph carries its condition so a clause stays clear when quoted alone. */
function expectConditionalParagraphs(html: string) {
    const paragraphs = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)];
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const [, paragraph] of paragraphs) {
        expect(paragraph).toMatch(/when paid plans are offered/i);
    }
}

describe('hosted legal identity and navigation', () => {
    it('rejects legacy operator wording throughout production legal sources', () => {
        expect(legacyOperator.test('Operated by EZIL Private Limited')).toBe(true);
        expect(legacyOperator.test('Contact us in Bengaluru')).toBe(true);
        expect(legacyOperator.test('Operated by EZiL LLC')).toBe(false);

        const files = [...legalSources(here)];
        expect(files).toContain(path.join(here, 'terms/page.tsx'));
        expect(files).toContain(path.join(here, 'privacy/page.tsx'));
        expect(files).toContain(path.join(here, 'refunds/page.tsx'));
        expect(files).toContain(path.join(here, 'legal-document.tsx'));
        for (const file of files) {
            expect(readFileSync(file, 'utf8'), path.relative(here, file)).not.toMatch(legacyOperator);
        }
    });

    it.each(pages)('renders EZiL LLC, the effective date, and active navigation on /$route', ({ route, Page }) => {
        const html = renderToStaticMarkup(createElement(Page));
        expect(html).toContain('EZiL LLC');
        expect(html).toMatch(/<time datetime="2026-10-11">11 October 2026<\/time>/i);
        expect(html).toContain('What changed:');
        const tabs = html.match(/<nav[^>]*aria-label="Legal documents"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
        expect(tabs).toMatch(new RegExp(`<a(?=[^>]*href="/${route}")(?=[^>]*aria-current="page")[^>]*>`));
    });

    it('provides the refunds route and canonical metadata', () => {
        expect(existsSync(path.join(here, 'refunds/page.tsx'))).toBe(true);
        expect(refundsMetadata.alternates?.canonical).toBe('https://os.ezil.org/refunds');
        expect(renderToStaticMarkup(createElement(RefundsPage))).toContain('<h1>Refund Policy</h1>');
    });

    it('links Terms, Privacy, and Refunds from the shared footer', () => {
        const html = renderToStaticMarkup(createElement(LegalLayout, null, 'Legal content'));
        const footer = html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)?.[1];
        expect(footer).toContain('aria-label="Legal footer"');
        for (const [route, label] of [['terms', 'Terms'], ['privacy', 'Privacy'], ['refunds', 'Refunds']]) {
            expect(footer).toMatch(new RegExp(`<a[^>]*href="/${route}"[^>]*>${label}</a>`));
        }
    });
});

describe('billing disclosures while paid plans are unavailable', () => {
    it('keeps every payment clause conditional and states renewal, credit expiry, and allowances', () => {
        const plans = section(renderToStaticMarkup(createElement(TermsPage)), 'plans-payments-credits');
        expectConditionalParagraphs(plans);
        expect(plans).toContain('Free and EZiL Pro');
        expect(plans).toContain('href="/pricing"');
        expect(plans).toContain('monthly in USD by Stripe on behalf of EZiL LLC');
        expect(plans).toContain('renews automatically until cancelled');
        expect(plans).toContain('Settings → Billing');
        expect(plans).toContain('Pro continues to the end of the paid period');
        expect(plans).toContain('prices exclude applicable taxes');
        expect(plans).toContain('calculated at checkout');
        expect(plans).toContain('flat service fee');
        expect(plans).toContain('no cash value and are not transferable');
        expect(plans).toContain('expires at the end of each billing period');
        expect(plans).toContain('expires 12 months after purchase');
        expect(plans).toContain('at least 30 days’ notice');
        expect(plans).toContain('saves work before stopping');
        expect(plans).toContain('does not force a stop after a failed save');
        expect(plans).toContain('saved storage');
        expect(plans).toContain('free space or choose an available plan');
    });

    it('explains conditional Stripe processing, billing purposes, and retention after deletion', () => {
        const html = renderToStaticMarkup(createElement(PrivacyPage));
        const billing = section(html, 'billing-data');
        expectConditionalParagraphs(billing);
        expect(billing).toContain('name, email, billing country and address');
        expect(billing).toContain('Stripe holds payment method details');
        expect(billing).toContain('EZiL never sees full card numbers');
        expect(section(html, 'purposes')).toMatch(/Administer billing:<\/strong> when paid plans are offered/);
        expect(section(html, 'providers')).toMatch(/Stripe:<\/strong> when paid plans are offered, acts as a processor for payments and tax calculation/);
        expect(section(html, 'retention')).toContain('When paid plans are offered, billing records are retained as required for tax and accounting obligations, even after account deletion');
    });

    it.each(pages.slice(0, 2))('reconciles optional AI connections and built-in credit usage on /$route', ({ Page }) => {
        const html = renderToStaticMarkup(createElement(Page));
        expect(html).toContain('Creating an EZiL OS account does not automatically connect it to an AI model provider');
        expect(html).toContain('When paid plans are offered, where EZiL OS offers a built-in AI assistant, its use is paid from AI credits');
    });

    it('makes refunds conditional and preserves the request windows and consumer remedies', () => {
        const html = renderToStaticMarkup(createElement(RefundsPage));
        for (const id of ['scope', 'pro-refunds', 'credit-refunds', 'requests', 'disputes', 'consumer-rights']) {
            expectConditionalParagraphs(section(html, id));
        }
        expect(section(html, 'pro-refunds')).toContain('within 14 days of a charge if that period’s allowances were not substantially used');
        expect(section(html, 'credit-refunds')).toContain('unused purchased AI credit is refundable on request within 14 days of purchase');
        expect(section(html, 'requests')).toContain('href="mailto:contact@ezil.work"');
        expect(section(html, 'disputes')).toContain('raise a dispute with your payment provider');
        expect(section(html, 'consumer-rights')).toContain('Those rights are not affected');
    });
});
