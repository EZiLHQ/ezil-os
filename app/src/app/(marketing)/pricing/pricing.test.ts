import { v3CopyForAudit, honestyBans } from '../../../../../shell/ezil/ui/Settings/billing-copy-test-helpers.mjs';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPrinter, createSourceFile, ScriptKind, ScriptTarget } from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_V3 } from '@/server/billing/v3/contract';
import { getPricingContent, marketingContent, pricingMetadata } from './pricing-content';

const flags = vi.hoisted(() => ({ pricingPageEnabled: false, largeStorageEnabled: false }));
vi.mock('@/server/billing/config', () => ({ readBillingConfig: () => flags }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('pricing disabled'); } }));
import PricingPage, { dynamic, metadata } from './page';
import MarketingHome from '../_components/home-page';
import styles from '../marketing.module.css';

const banned = /faster|instant|unlimited|priority|gpu|heavy\s+use|gpt|claude|gemini|llama|memory\s+is\s+kept|memory\s+survives|processes\s+keep\s+running|ai\s+included|includes\s+ai|compute\s+hours|standard-hour/i;
const terms = ['faster', 'instant', 'unlimited', 'priority', 'gpu', 'heavy use', 'gpt', 'claude', 'gemini', 'llama', 'memory is kept', 'memory survives', 'processes keep running', 'ai included', 'includes ai', 'compute hours', 'standard-hour'];
const render = (focusPlans = false) => renderToStaticMarkup(MarketingHome({ focusPlans }));
const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const withoutComments = (text: string) => createPrinter({ removeComments: true }).printFile(createSourceFile('copy.tsx', text, ScriptTarget.Latest, true, ScriptKind.TSX));
const cards = (html: string) => [...html.matchAll(/<article\b[\s\S]*?<\/article>/g)].map(match => match[0]);
beforeEach(() => { flags.pricingPageEnabled = false; });

describe('v3 public plans', () => {
    it.each([false, true])('shows three comparable cards on home/pricing (%s)', focus => {
        const html = render(focus);
        const articles = cards(html);
        expect(articles).toHaveLength(3);
        const offers = Object.values(CATALOG_V3);
        offers.forEach((offer, index) => {
            const card = articles[index];
            expect(card).toContain(`plan-${offer.tier}`);
            expect(card).toContain(offer.tagline);
            expect(card).toContain(`$${offer.priceCents / 100}`);
            expect(card.match(/<a\b/g)).toHaveLength(1);
            expect(card.match(/<li\b/g)).toHaveLength(offer.bullets.length);
            expect(card).not.toMatch(/progressbar|standard-hour|overage/i);
            for (const bullet of offer.bullets) expect(card).toContain(bullet);
            expect(card).not.toContain('Most popular');
            expect(card.includes(styles.premium)).toBe(offer.highlighted);
        });
        expect(articles[1]).toContain('Everything in Free, plus:');
        expect(articles[2]).toContain('Everything in Standard, plus:');
        expect(html).toContain('Prices before tax.');
        expect(html.includes('data-testid="home-hero"')).toBe(!focus);
        expect(html.match(/<h1\b/g)).toHaveLength(1);
    });

    it.each([false, true])('Standard trial: only the Standard card offers the free month, with no date (%s)', focus => {
        const articles = cards(render(focus));
        const trialLine = 'Try one month free — $0 today, then $20/month unless you cancel';
        expect(CATALOG_V3.standard_monthly_v3.priceCents).toBe(2000);
        expect(articles[1]).toContain(trialLine);
        expect(articles[1]).toContain('data-testid="plan-standard-trial"');
        // A paragraph, not a bullet or a second link: the card keeps one CTA and its catalog bullets.
        expect(articles[1]).toMatch(/<p [^>]*data-testid="plan-standard-trial"[^>]*>Try one month free/);
        for (const index of [0, 2]) expect(articles[index]).not.toMatch(/free month|one month free|\$0 today|trial/i);
        // Unauthenticated: never a date (the exact end is shown in Settings → Billing before checkout).
        expect(articles[1]).not.toMatch(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b|\d{4}-\d{2}-\d{2}/);
        expect(getPricingContent().plans.map(plan => plan.trialNote)).toEqual([null, trialLine, null]);
    });

    it('carries each paid plan through login to the billing deep link', () => {
        for (const plan of getPricingContent().plans) {
            const card = cards(render()).find(card => card.includes(`plan-${plan.id}`))!;
            if (plan.id === 'free') expect(plan.cta.href).toBe('/login');
            else {
                const link = new URL(plan.cta.href, 'https://example.test');
                expect(link.pathname).toBe('/login');
                expect(link.searchParams.get('returnUrl')).toBe(`/os?settings=billing&upgrade=${plan.id}`);
                expect(card).toContain(plan.cta.href);
            }
        }
    });

    it('explains sessions, fair use, persistence, billing changes and storage in six FAQs', () => {
        const faq = getPricingContent().faq.items;
        expect(faq).toHaveLength(6);
        expect(faq[0].answer).not.toMatch(/sessions? (last|up to)|[0-9]+ hours?\b/i);
        expect(faq[0].answer).toContain('computer stops');
        // Paid compute policy v1: Free keeps its monthly allowance; no paid plan is sold monthly hours (or "unlimited").
        expect(faq[1].question).toBe('How much computer time is included?');
        expect(faq[1].answer).toContain('Free includes about 5 hours of computer time a month; older Free accounts keep 8 hours.');
        expect(faq[1].answer).toContain('Standard and Premium have no monthly computer-hours allowance, and starting a computer depends on available capacity.');
        expect(faq[1].answer).toContain('does not reset it');
        expect(faq[1].answer).not.toMatch(/40 hours|500|standard-hours/);
        expect(JSON.stringify(faq)).not.toMatch(/monthly time|No session time limit|sessions? (last|up to)/i);
        expect(JSON.stringify(getPricingContent())).not.toMatch(/longer sessions|long sessions|sessions? up to/i);
        expect(faq[2].answer).toContain('files and installed tools stay');
        expect(faq[2].answer).toContain('Running processes stop');
        expect(faq[3].answer).toContain('once payment succeeds');
        expect(faq[3].answer).toContain('end of your billing period');
        expect(faq[4].question).toBe('Which computer sizes can I choose?');
        expect(faq[4].answer).toContain('Premium lets you choose 2, 4 or 8 vCPU (8, 16 or 32 GB)');
        expect(cards(render()).join('')).not.toMatch(/standard-hour|500|40 hours a month|5 hours a month/);
        expect(cards(render())[0]).toContain('2 vCPU · 6 GB');
        expect(cards(render())[2]).toContain('Choose 2, 4 or 8 vCPU (8, 16 or 32 GB) on AWS (India)');
    });

    it('round 5 (D6): a storage FAQ with each plan\'s disk, from the catalog', () => {
        const storage = getPricingContent().faq.items[5];
        expect(storage.question).toBe('How much storage do I get?');
        expect(storage.answer).toContain(`Standard comes with a ${CATALOG_V3.standard_monthly_v3.storageGiB} GB disk`);
        expect(storage.answer).toContain(`Premium with a ${CATALOG_V3.premium_monthly_v3.storageGiB} GB disk`);
        expect(storage.answer).toContain('On Free, your files are saved between sessions.');
        expect(storage.answer).toContain('Some space is used by the system.');
        expect(CATALOG_V3.free_v3.storageGiB).toBeNull();
        expect(render()).toContain('How much storage do I get?');
    });

    it('round 5 (D6): no "coming soon" AI feature on the marketing page', () => {
        expect(JSON.stringify(marketingContent)).not.toMatch(/coming soon/i);
        expect(render()).not.toMatch(/coming soon/i);
        expect(render(true)).not.toMatch(/coming soon/i);
    });

    it('respects the pricing gate with fake config, including the unavailable state', () => {
        expect(() => PricingPage()).toThrow('pricing disabled');
        flags.pricingPageEnabled = true;
        expect(renderToStaticMarkup(PricingPage())).toBe(render(true));
        expect(dynamic).toBe('force-dynamic');
        expect(metadata).toEqual(pricingMetadata);
    });
});

describe('v3 copy contract', () => {
    it.each(terms)('rejects %s, including case and whitespace variants', term => {
        expect(term.toUpperCase()).toMatch(banned);
        expect(term.replaceAll(' ', '\n\t ')).toMatch(banned);
    });
    it('scans content, metadata, rendered accessible names and comment-free sources', () => {
        for (const value of [JSON.stringify([getPricingContent(), marketingContent, pricingMetadata]), render(), render(true),
            ...['./page.tsx', '../_components/home-page.tsx', './pricing-content.ts'].map(file => withoutComments(source(file)))]) {
            expect(v3CopyForAudit(value, { faq: true }).replaceAll("offer.tier === 'premium' ? 'standard-hours' : 'hours'", '')).not.toMatch(banned);
            expect(value).not.toMatch(honestyBans);
        }
        expect('Opens from a ready computer').toMatch(honestyBans);
        expect(v3CopyForAudit('Your computer opens faster')).toMatch(banned);
        expect(v3CopyForAudit('500 standard-hours')).toMatch(banned);
        expect(withoutComments('// unlimited\nconst title = "Free";')).not.toMatch(banned);
        expect(withoutComments('const el = <nav aria-label="instant" />;')).toMatch(banned);
    });
    it('keeps all five copy-ban sites and shared format list in sync', () => {
        for (const file of ['../../../../../shell/ezil/ui/Settings/billing-test.mjs', '../../../../../shell/ezil/ui/Settings/upgrade-sheet-test.mjs', '../../../../../e2e/billing-e2e-lib.mjs', '../../../../../e2e/billing-e2e.test.mjs', '../../../../../shell/ezil/ui/Settings/billing-format.js']) {
            const text = source(file);
            const list = text.match(/\['faster'[^\]]+\]/)?.[0];
            if (list) expect(JSON.parse(list.replaceAll("'", '"'))).toEqual(terms);
            else expect(text).toContain(banned.toString());
        }
    });
});
