import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CATALOG_V3 } from '@/server/billing/v3/contract';

import TermsPage from './page';

// The public Terms must state the offer the catalog and billing actually run (founder 2026-11-05: no Free session
// length as a number; paid sessions up to six hours with no monthly hours allowance; included AI credits; the
// Standard free month; files stay with the computer when a paid plan ends).
const here = path.dirname(fileURLToPath(import.meta.url));
const html = renderToStaticMarkup(createElement(TermsPage));
const free = CATALOG_V3.free_v3;
const standard = CATALOG_V3.standard_monthly_v3;
const premium = CATALOG_V3.premium_monthly_v3;
const hours = (seconds: number) => seconds / 3600;
const price = (cents: number) => `$${cents / 100}`;

function section(id: string): string {
    const match = html.match(new RegExp(`<section[^>]* id="${id}"[^>]*>([\\s\\S]*?)</section>`));
    expect(match, `section ${id} must be rendered`).toBeTruthy();
    return match![1]!;
}

function planItem(name: string): string {
    const item = [...section('plans-payments').matchAll(/<li>([\s\S]*?)<\/li>/g)]
        .map((match) => match[1]!)
        .find((text) => text.includes(`<strong>${name} —`));
    expect(item, `${name} plan item`).toBeDefined();
    return item!;
}

describe('Terms plan facts follow the v3 catalog', () => {
    it('lists exactly Free, Standard and Premium with catalog price, computer, disk, sessions and AI credits', () => {
        expect([...section('plans-payments').matchAll(/<li>/g)]).toHaveLength(3);
        const freeItem = planItem(free.name);
        expect(freeItem).toContain(`<strong>Free — ${price(free.priceCents)}:</strong>`);
        expect(freeItem).toContain(`${free.vcpu} vCPU · ${free.memoryGiB} GB computer on Cloudflare`);
        expect(freeItem).toContain('shorter sessions than paid plans');
        expect(freeItem).toContain(`about ${hours(free.fairUseSeconds)} hours of computer time a month`);
        expect(freeItem).toContain(`older Free accounts keep ${hours(free.legacyFairUseSeconds!)} hours`);
        expect(free.aiCredits.per).toBe('once');
        expect(freeItem).toContain(`${free.aiCredits.amount} AI credits once`);
        for (const offer of [standard, premium]) {
            const item = planItem(offer.name);
            expect(item).toContain(`<strong>${offer.name} — ${price(offer.priceCents)}/${offer.interval}:</strong>`);
            expect(item).toContain(`with a ${offer.storageGiB} GB disk`);
            expect(item).toContain(`sessions up to ${hours(offer.sessionMaxSeconds!)} hours`);
            expect(offer.aiCredits.per).toBe('period');
            expect(item).toContain(`${offer.aiCredits.amount.toLocaleString('en-US')} AI credits each billing period`);
        }
        expect(planItem(standard.name)).toContain(`your own ${standard.vcpu} vCPU · ${standard.memoryGiB} GB computer on AWS in Mumbai`);
        expect(planItem(premium.name)).toContain('choose 2, 4 or 8 vCPU (8, 16 or 32 GB) on AWS in Mumbai');
    });

    it('describes sessions and computer time as billing enforces them', () => {
        const plans = section('plans-payments');
        expect(plans).toContain(`Standard and Premium have no monthly computer-hours allowance: each session lasts up to ${hours(standard.sessionMaxSeconds!)} hours, and starting a computer depends on available capacity.`);
        expect(plans).toContain('Free’s computer time renews each calendar month in UTC.');
        expect(plans).toContain('At the session limit, your files are saved and the computer stops');
    });

    it('discloses the Standard free month: price, consent, cancellation and a failed first payment', () => {
        const plans = section('plans-payments');
        expect(plans).toContain('<strong>Standard free month.</strong>');
        expect(plans).toContain('you can start Standard at $0 for one calendar month');
        expect(plans).toContain('Stripe Checkout collects a payment method and your consent to the recurring charge');
        expect(plans).toContain(`Standard renews at ${price(standard.priceCents)}/${standard.interval} unless you cancel before then`);
        expect(plans).toContain('The free month is for Standard only, once per person');
        expect(plans).toContain('If you cancel during the free month, Standard stays available until it ends and you are not charged; then you move to Free.');
        expect(plans).toContain('If that payment does not succeed, paid access ends and you move to Free; your files are kept');
        expect(plans).toContain('or for the Standard free month once Stripe confirms it: on signed confirmation from Stripe, not a checkout redirect.');
    });

    it('keeps the disk and files when a paid plan ends and never promises a bigger existing disk', () => {
        expect(section('plans-payments')).toContain('A computer keeps its existing disk when you change plan, so a plan change does not make that disk larger.');
        const files = section('plan-changes-files');
        expect(files).toContain('your account moves to Free and your computer keeps its disk and files');
        expect(files).toContain('Files on an AWS computer stay on that computer and are not moved to a Free computer automatically.');
        expect(files).toContain('a 4 or 8 vCPU computer can’t open on the Free plan');
    });

    it('states that plans include AI credits', () => {
        expect(section('third-parties')).toContain('Plans include AI credits for EZiL AI in Code and Chat');
    });
});

describe('Terms carry none of the retired or contradicting claims', () => {
    const retired: readonly [string, RegExp][] = [
        ['a numeric Free session length', /sessions? (of |up to )?(1|one) ?-?hours?\b|\b(1|one)[- ]hour sessions?|up to 60 minutes/i],
        ['unlimited paid sessions', /no session time limit/i],
        ['monthly paid-hour fair use', /standard-hours?|fair[- ]use|×\s?[24]\b/i],
        ['paid monthly hours', /about (40|500) (standard-)?hours/i],
        ['AI not included', /AI is not included|not included in any plan/i],
        ['an automatic move back to Free', /move back to the Free computer/i],
        ['14-day paid disk deletion', /14 days|then deleted/i],
    ];

    it.each(retired)('rendered Terms never state %s', (_, pattern) => {
        expect(html).not.toMatch(pattern);
    });

    it.each(retired)('the Terms source never states %s', (_, pattern) => {
        expect(readFileSync(path.join(here, 'page.tsx'), 'utf8')).not.toMatch(pattern);
    });
});
