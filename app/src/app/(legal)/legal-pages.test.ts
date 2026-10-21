import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CATALOG_V3 } from '@/server/billing/v3/contract';

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
        expect(html).toContain('30 N Gould St STE R');
        expect(html).toContain('Sheridan, WY 82801, USA');
        expect(html).toContain('href="mailto:contact@ezil.work">contact@ezil.work</a>');
        expect(html).toMatch(/<time datetime="2026-10-21">21 October 2026<\/time>/i);
        expect(html).toContain('What changed:');
        expect(html.indexOf('What changed:')).toBeLessThan(html.indexOf('<article'));
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

describe('Free, Standard and Premium billing disclosures', () => {
    it('rejects retired offers and unsupported payment claims in production copy and metadata', () => {
        const retiredCopy = /EZiL Pro|\bPro\b|when paid plans are offered|merchant of record|AI[ -]credits?/i;
        for (const file of legalSources(here)) {
            expect(readFileSync(file, 'utf8'), path.relative(here, file)).not.toMatch(retiredCopy);
        }
        for (const { Page } of pages) {
            expect(renderToStaticMarkup(createElement(Page))).not.toMatch(retiredCopy);
        }
    });

    it.each(Object.values(CATALOG_V3))('matches the catalog name, price and fair use for $name', (offer) => {
        const plans = section(renderToStaticMarkup(createElement(TermsPage)), 'plans-payments');
        const price = `$${offer.priceCents / 100}${offer.interval ? `/${offer.interval}` : ''}`;
        const item = [...plans.matchAll(/<li>([\s\S]*?)<\/li>/g)]
            .map((match) => match[1]!)
            .find((html) => html.includes(`<strong>${offer.name} —`));
        expect(item).toBeDefined();
        expect(item).toContain(`<strong>${offer.name} — ${price}:</strong>`);
        expect(item).toContain(`about ${offer.fairUseSeconds / 3600} standard-hours/month`);
        const refunds = section(renderToStaticMarkup(createElement(RefundsPage)), 'scope');
        expect(refunds).toContain(`${offer.name} (${price})`);
    });

    it('discloses hardware, session policy and weighted fair use', () => {
        const plans = section(renderToStaticMarkup(createElement(TermsPage)), 'plans-payments');
        const free = CATALOG_V3.free_v3;
        const standard = CATALOG_V3.standard_monthly_v3;
        expect(plans).toContain(`${free.vcpu} vCPU · ${free.memoryGiB} GB computer on Cloudflare`);
        expect(plans).toContain(`sessions up to ${free.sessionMaxSeconds! / 3600} hour`);
        expect(plans).toContain(`Older accounts keep ${free.legacyFairUseSeconds! / 3600} standard-hours/month`);
        expect(plans).toContain(`${standard.vcpu} vCPU · ${standard.memoryGiB} GB computer on AWS in Mumbai`);
        expect(plans).toContain('choose 2, 4 or 8 vCPU (8, 16 or 32 GB) on AWS in Mumbai');
        // S5 explicitly removes paid session caps; the existing catalog still needs a separate update.
        const paidItems = [...plans.matchAll(/<li>([\s\S]*?)<\/li>/g)].slice(1);
        expect(paidItems).toHaveLength(2);
        for (const [, item] of paidItems) expect(item).toContain('no session time limit');
        expect(plans).toContain('4 vCPU uses time at ×2 and 8 vCPU at ×4');
        expect(plans).toContain('does not remove monthly fair-use limits');
    });

    it('requires payment confirmation and explains renewals and plan changes', () => {
        const plans = section(renderToStaticMarkup(createElement(TermsPage)), 'plans-payments');
        expect(plans).toContain('Prices are in USD, before tax. Tax is added where it applies');
        expect(plans).toContain('Paid plans are billed monthly through Stripe and renew automatically until cancelled');
        expect(plans).toContain('A paid plan starts and its Mumbai computer is prepared only after payment succeeds: on signed payment confirmation, not a checkout redirect.');
        expect(plans).toContain('An upgrade from Standard to Premium is charged on a prorated basis and takes effect only after payment succeeds');
        expect(plans).toContain('Downgrades and cancellations take effect at the end of the paid period');
        expect(plans).toContain('If a renewal payment fails, paid computer use pauses until the payment is fixed. Your files are kept.');
        expect(plans).toContain('Use the customer portal in Settings → Billing to update your payment method');
        expect(plans).toContain('at least 30 days’ notice');
    });

    it('explains file migration, excluded software and 14-day paid disk retention', () => {
        const files = section(renderToStaticMarkup(createElement(TermsPage)), 'plan-changes-files');
        expect(files).toContain('project files and HOME directory move to the new computer');
        expect(files).toContain('dotfiles, SSH keys, git configuration, and AI chat history');
        expect(files).toContain('Software installed with apt or npm -g, or in /opt, does not move and must be reinstalled');
        expect(files).toContain('Running processes stop during the move');
        expect(files).toContain('your files move back to the Free computer');
        expect(files).toContain('The paid computer’s disk is kept for 14 days and then deleted.');
        expect(files).toContain('Free storage limits still apply to what is kept');
    });

    it('explains Stripe payment data and compute usage without changing retention periods', () => {
        const html = renderToStaticMarkup(createElement(PrivacyPage));
        const billing = section(html, 'billing-data');
        expect(billing).toContain('name, email, billing country and address');
        expect(billing).toContain('Stripe handles payment data and holds payment method details; EZiL does not store card numbers');
        expect(billing).toContain('We process compute usage to run and bill the Service: session start and stop times, machine size, and provider and region information (Cloudflare or AWS in Mumbai)');
        expect(section(html, 'purposes')).toContain('measure compute usage against fair-use limits');
        expect(section(html, 'providers')).toContain('provides the Standard and Premium computers in Mumbai');
        const retention = section(html, 'retention');
        expect(retention).toContain('There is no automatic general erasure deadline');
        expect(retention).toContain('individual event records older than 14 days and hourly counts linked to a user pseudonym older than 90 days');
        expect(retention).toContain('low-volume summaries not seen for a year are eligible for cleanup');
        expect(retention).toContain('Billing records are retained as required for tax and accounting obligations, even after account deletion');
    });

    it.each(pages)('states that AI is not included on /$route', ({ Page }) => {
        expect(renderToStaticMarkup(createElement(Page))).toContain('AI is not included in any plan');
    });

    it('preserves the refund window and consumer rights, using strictly less than 10% of weighted fair use', () => {
        const html = renderToStaticMarkup(createElement(RefundsPage));
        const refunds = section(html, 'plan-refunds');
        expect(refunds).toContain('within 14 days of a charge');
        expect(refunds).toContain('This applies to an initial charge or a renewal');
        expect(refunds).toContain('less than 10% of the plan’s monthly fair use');
        expect(refunds).toContain('Usage at or above 10% does not meet this condition');
        for (const offer of Object.values(CATALOG_V3).filter((plan) => plan.priceCents > 0)) {
            expect(refunds).toContain(`under ${offer.fairUseSeconds / 3600 * 0.1} standard-hours for ${offer.name}`);
        }
        expect(refunds).toContain('4 vCPU computer uses 2 standard-hours per hour');
        expect(refunds).toContain('8 vCPU computer uses 4 standard-hours per hour');
        expect(refunds).toContain('Cancellation alone does not request a refund');
        expect(section(html, 'requests')).toContain('href="mailto:contact@ezil.work"');
        expect(section(html, 'disputes')).toContain('raise a dispute with your payment provider');
        expect(section(html, 'consumer-rights')).toContain('Those rights are not affected');
    });

    it('keeps governing law unspecified', () => {
        const contact = section(renderToStaticMarkup(createElement(TermsPage)), 'contact');
        expect(contact).toContain('Applicable law determines governing law and the courts with jurisdiction, including mandatory protections where you live.');
    });
});
