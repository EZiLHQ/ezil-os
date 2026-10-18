import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPrinter, createSourceFile, ScriptKind, ScriptTarget } from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FREE_PLAN, storageCapBytes } from '@/server/billing/catalog';
import {
    CATALOG_V2, SIZES, FREE_V2_EFFECTIVE_AT, SECONDS_PER_HOUR,
    OVERAGE_DEFAULT_CAP_CENTS, OVERAGE_MAX_CAP_CENTS, OVERAGE_CENTS_PER_STD_HOUR,
    SESSION_MAX_SECONDS, IDLE_SLEEP_SECONDS,
} from '@/server/billing/v2/contract';
import { getPricingContent, marketingContent, pricingMetadata } from './pricing-content';

const flags = vi.hoisted(() => ({ pricingPageEnabled: false, largeStorageEnabled: false }));

// Explicit inputs keep the test independent of the host's flags and provider configuration.
vi.mock('@/server/billing/config', async importOriginal => {
    const actual = await importOriginal<typeof import('@/server/billing/config')>();
    return {
        ...actual,
        readBillingConfig: () => actual.readBillingConfig({
            PRICING_PAGE_ENABLED: flags.pricingPageEnabled ? '1' : undefined,
            BILLING_LARGE_STORAGE: flags.largeStorageEnabled ? '1' : undefined,
        }),
    };
});
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('pricing disabled'); } }));
vi.mock('../../login/actions', () => ({ signInWithGoogle: vi.fn(), signInWithPassword: vi.fn() }));

import PricingPage, { dynamic, metadata } from './page';
import MarketingHome from '../_components/home-page';
import styles from '../marketing.module.css';
import { viewport } from '../layout';
import LoginPage from '../../login/page';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.resolve(here, file), 'utf8').replace(/\r\n/g, '\n');
const sources = ['./page.tsx', '../layout.tsx', '../_components/home-page.tsx', './pricing-content.ts'].map(read);
const css = read('../marketing.module.css');
const banned = /faster|instant|unlimited|priority|gpu|heavy\s+use|fair\s+use|gpt|claude|gemini|llama|memory\s+is\s+kept|memory\s+survives|processes\s+keep\s+running|ai\s+included|includes\s+ai/i;
const effectiveDate = '2026-10-18T00:00:00Z';

/** Include metadata and accessible names as well as all rendered text and FAQ answers. */
function strings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
    return [];
}
const render = (largeStorageEnabled = false, focusPlans = false, freeV2EffectiveAt: string | null = FREE_V2_EFFECTIVE_AT) =>
    renderToStaticMarkup(MarketingHome({ largeStorageEnabled, focusPlans, freeV2EffectiveAt }));
const textContent = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

/** Comments are not public copy; parsing preserves strings and JSX in every source branch. */
function withoutComments(source: string): string {
    return createPrinter({ removeComments: true }).printFile(
        createSourceFile('copy.tsx', source, ScriptTarget.Latest, true, ScriptKind.TSX),
    );
}

function expectSectionOrder(html: string, markers: string[]): void {
    let previous = -1;
    for (const marker of markers) {
        expect(html.indexOf(marker), marker).toBeGreaterThan(previous);
        previous = html.indexOf(marker);
    }
}

beforeEach(() => {
    flags.pricingPageEnabled = false;
    flags.largeStorageEnabled = false;
});

describe('the complete public offer follows the copy contract', () => {
    it.each(['faster', 'instant', 'unlimited', 'priority', 'gpu', 'heavy use', 'fair use', 'gpt', 'claude', 'gemini', 'llama', 'memory is kept', 'memory survives', 'processes keep running', 'ai included', 'includes ai'])(
        'catches prohibited copy: %s', word => {
            expect(banned.test(`This plan is ${word.toUpperCase()}.`)).toBe(true);
            expect(banned.test(word.replaceAll(' ', '\n\t '))).toBe(true);
        },
    );

    it.each([false, true])('scans all content, metadata, accessible labels and rendered text (storage: %s)', storage => {
        const copy = strings([getPricingContent(storage, null), getPricingContent(storage, effectiveDate), marketingContent, pricingMetadata]);
        const pages = [null, effectiveDate].flatMap(date => [render(storage, false, date), render(storage, true, date)]);
        expect(copy).toContain('Open EZiL OS and get to work.');
        for (const html of pages) {
            expect(html).toContain('Is a computer always available?');
            expect(html).toContain(`aria-label="${marketingContent.navigationLabel}"`);
        }
        expect(banned.test('Build faster')).toBe(true);
        for (const value of [...copy, ...pages, ...pages.map(textContent), ...sources.map(withoutComments)]) expect(value).not.toMatch(banned);
    });

    it('allows v2 size and session copy', () => {
        expect(`2 vCPU · 8 GiB. Sessions run up to ${SESSION_MAX_SECONDS / SECONDS_PER_HOUR} hours, then your work is saved and the computer restarts. Files and installed tools are kept; running processes start fresh.`).not.toMatch(banned);
    });

    it('excludes comments from the copy scan while preserving metadata, labels and JSX text', () => {
        const comment = '// Build faster\n/* unlimited */\nconst copy = <p>{/* instant */}Start free</p>;';
        expect(comment).toMatch(banned);
        expect(withoutComments(comment)).toContain('Start free');
        expect(withoutComments(comment)).not.toMatch(banned);
        for (const source of [
            "const metadata = { title: 'Build faster' };",
            'const label = <nav aria-label="Build faster" />;',
            'const heading = <h1>Build faster</h1>;',
        ]) expect(withoutComments(source)).toMatch(banned);
    });

    it.each([false, true])('derives prices and all nine allowance tiles from the catalogs (storage: %s)', storage => {
        const { plans } = getPricingContent(storage, null);
        const offers = [CATALOG_V2.free_v1_legacy, CATALOG_V2.standard_monthly_v2, CATALOG_V2.compute_monthly_v2];
        expect(plans.map(plan => plan.name)).toEqual(['Free', 'Standard', 'Compute']);
        for (const [index, plan] of plans.entries()) {
            const offer = offers[index];
            const sizes = offer.sizes.map(code => SIZES[code]);
            expect(plan.price).toBe(`$${offer.priceCents / 100}`);
            expect(plan.interval).toBe(offer.interval ? `/${offer.interval}` : '');
            expect(plan.billingNote).toBe(plan.id === 'free' ? 'USD · no card needed' : 'USD · before tax · cancel anytime');
            expect(plan.allowances.map(tile => tile.id)).toEqual(['compute', 'computer', 'storage']);
            expect(plan.allowances.map(tile => tile.label)).toEqual(['Compute time', 'Computer', 'Saved storage']);
            expect(plan.allowances[0].value).toBe(`${offer.allowanceStdSeconds / SECONDS_PER_HOUR}`);
            expect(plan.allowances[0].unit).toBe(plan.id === 'free' ? 'h/month' : 'standard-hours/period');
            expect(plan.allowances[1].value).toBe(sizes.length === 1 ? `${sizes[0].vcpu} vCPU` : `${sizes[0].vcpu}–${sizes.at(-1)!.vcpu} vCPU`);
            expect(plan.allowances[1].unit).toBe(sizes.length === 1 ? `${sizes[0].memoryGiB} GiB` : `up to ${sizes.at(-1)!.memoryGiB} GiB`);
            expect(plan.allowances[2].value).toBe(`${Number(plan.id === 'free' ? FREE_PLAN.storageBytes : storageCapBytes('pro', storage)) / 1_000_000_000}`);
            expect(plan.allowances[2].unit).toBe('GB');
            for (const tile of plan.allowances) {
                const html = render(storage, false, null);
                expect(html).toContain(`data-testid="allowance-${plan.id}-${tile.id}"`);
                expect(html).toContain(`<strong>${tile.value}</strong>`);
            }
        }
        expect(plans[0].allowances[0].caption).toBe('while a computer runs');
        expect(plans[2].badge).toBe('Larger computers');
    });

    it.each([null, effectiveDate])('discloses the Free policy only once it is effective (%s)', date => {
        const free = getPricingContent(false, date).plans[0];
        expect(free.allowances[0].value).toBe(`${CATALOG_V2[date ? 'free_v2' : 'free_v1_legacy'].allowanceStdSeconds / SECONDS_PER_HOUR}`);
        const disclosure = `Accounts created from October 18, 2026 get ${CATALOG_V2.free_v2.allowanceStdSeconds / SECONDS_PER_HOUR} h a month; earlier accounts keep ${CATALOG_V2.free_v1_legacy.allowanceStdSeconds / SECONDS_PER_HOUR} h.`;
        expect(free.disclosure).toBe(date ? disclosure : undefined);
        for (const focusPlans of [false, true]) {
            const card = render(false, focusPlans, date).match(/<article[^>]*data-testid="plan-free"[\s\S]*?<\/article>/)?.[0];
            expect(card).toContain(`<strong>${free.allowances[0].value}</strong>`);
            if (date) expect(card).toContain(disclosure);
            else expect(card).not.toContain('Accounts created from');
        }
        expect(getPricingContent(false)).toEqual(getPricingContent(false, FREE_V2_EFFECTIVE_AT));
        expect(renderToStaticMarkup(MarketingHome({ largeStorageEnabled: false }))).toBe(render());
    });

    it.each([false, true])('keeps AI only in the coming-soon feature tile and offers no target storage (storage: %s)', storage => {
        expect(marketingContent.features.filter(feature => /AI/.test(feature.title))).toEqual([{ title: 'AI assistant', badge: 'coming soon' }]);
        for (const date of [null, effectiveDate]) {
            const copy = strings(getPricingContent(storage, date)).join(' ');
            expect(copy).not.toMatch(/\bAI\b|60\s*GB|\bPro\b/i);
            const html = render(storage, false, date);
            const feature = html.match(new RegExp(`<div class="${styles.feature}">[^]*?<h2>AI assistant</h2>[^]*?</div>`))?.[0];
            expect(feature).toContain('coming soon');
            expect(feature).not.toContain('$');
            expect(html).not.toMatch(/60\s*GB|AI credits/);
        }
        expect(pricingMetadata.description).toBe('Start free. Upgrade for more compute time and larger computers.');
    });
});

describe('shared home document', () => {
    it('gates /pricing per request, then renders plans first with one plans h1', () => {
        expect(() => PricingPage()).toThrow('pricing disabled');
        flags.pricingPageEnabled = true;
        const html = renderToStaticMarkup(PricingPage());
        expect(html).toBe(render(false, true));
        expect(html).toMatch(/<main\b[^>]*><section id="plans"[^>]*><h1 id="plans-title">Plans<\/h1>/);
        expect(html.match(/<h1\b/g)).toHaveLength(1);
        expect(html.match(/<section\b/g)).toHaveLength(5);
        expectSectionOrder(html, ['<header', 'id="plans"', 'id="overage-title"', 'id="limits-title"', 'id="faq-title"', 'id="closing-title"', '<footer']);
        expect(html).toContain('href="#plans"');
        expect(html).toContain('Sold by EZiL LLC');
        for (const id of ['plan-free', 'plan-standard', 'plan-compute', 'cta-get-standard', 'cta-get-compute']) expect(html).toContain(`data-testid="${id}"`);
        const home = render();
        for (const marker of ['data-testid="home-hero"', `class="${styles.desktop}"`, `aria-label="${marketingContent.featuresLabel}"`]) {
            expect(home).toContain(marker);
            expect(html).not.toContain(marker);
        }
        const focusAttribute = /\s(?:autofocus|tabindex)=/i;
        for (const attribute of ['autofocus=""', 'tabindex="-1"']) expect(`<section ${attribute}>`).toMatch(focusAttribute);
        const plans = html.match(/<section id="plans"[^>]*>/)?.[0];
        expect(plans).toContain('aria-labelledby="plans-title"');
        expect(plans).not.toMatch(focusAttribute);
        expect('<section autofocus="">').toMatch(/\sautofocus=/i);
        expect(html).not.toMatch(/\sautofocus=/i);
        expect(dynamic).toBe('force-dynamic');
        expect(metadata.title).toBe('Plans · EZiL OS');
        expect(viewport.interactiveWidget).toBe('resizes-content');
        flags.largeStorageEnabled = true;
        expect(renderToStaticMarkup(PricingPage())).toBe(render(true, true));
        expect(render(false)).not.toContain('GB soon');
        expect(render(true)).not.toContain('GB soon');
        flags.pricingPageEnabled = false;
        expect(() => PricingPage()).toThrow('pricing disabled');
    });

    it('renders all ten sections in order and every pinned selector', () => {
        const html = render();
        expect(html.match(/<h1\b/g)).toHaveLength(1);
        expect(html).toMatch(/data-testid="home-hero"[^>]*>[\s\S]*?<h1 id="home-title">Open EZiL OS and get to work\.<\/h1>/);
        expect(html).toContain('<h2 id="plans-title">Plans</h2>');
        expect(html.match(/<article\b/g)).toHaveLength(3);
        expect(html.match(/<section\b/g)).toHaveLength(7);
        expectSectionOrder(html, ['<header', 'data-testid="home-hero"', `class="${styles.desktop}" aria-hidden="true"`, 'aria-label="Your workspace"', 'id="plans"', 'id="overage-title"', 'id="limits-title"', 'id="faq-title"', 'id="closing-title"', '<footer']);
        for (const id of ['home-hero', 'cta-start-free', 'cta-sign-in', 'plan-free', 'plan-standard', 'plan-compute', 'cta-get-standard', 'cta-get-compute']) {
            expect(html).toContain(`data-testid="${id}"`);
        }
        for (const link of marketingContent.links) expect(html).toContain(`href="${link.href}">${link.label}</a>`);
        expect(html).toContain('Sold by EZiL LLC');
        for (const match of html.matchAll(/<(a)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
            expect(textContent(match[2]).trim().length).toBeGreaterThan(0);
        }
    });

    it.each([false, true])('renders all FAQ questions as h3 headings with visible answers (plans first: %s)', focusPlans => {
        const html = render(false, focusPlans);
        const faq = html.match(/<section[^>]*aria-labelledby="faq-title"[\s\S]*?<\/section>/)?.[0] ?? '';
        expect(faq).toContain('<h2 id="faq-title">Frequently asked questions</h2>');
        expect(faq.match(/<h3\b/g)).toHaveLength(getPricingContent(false).faq.items.length);
        expect(faq.match(/<p\b/g)).toHaveLength(getPricingContent(false).faq.items.length);
        for (const item of getPricingContent(false).faq.items) {
            expect(faq).toContain(`<div class="${styles.faq}"><h3>${item.question}</h3><p>${item.answer}</p></div>`);
        }
        const disclosure = /<\/?(?:details|summary)\b/i;
        for (const control of ['<details>Answer</details>', '<summary>Question</summary>']) expect(control).toMatch(disclosure);
        expect(html).not.toMatch(disclosure);
    });

    it('pins CTA destinations and their placement before the allowance tiles', () => {
        const html = render();
        expect(html).toMatch(/data-testid="cta-start-free"[^>]*href="\/login">Start free<\/a>/);
        expect(html).toMatch(/data-testid="cta-sign-in"[^>]*href="\/login\?method=email">Sign in<\/a>/);
        expect(html).toMatch(/data-testid="cta-get-standard"[^>]*href="\/login\?returnUrl=%2Fos%3Fsettings%3Dbilling%26upgrade%3Dstandard">Get Standard<\/a>/);
        expect(html).toMatch(/data-testid="cta-get-compute"[^>]*href="\/login\?returnUrl=%2Fos%3Fsettings%3Dbilling%26upgrade%3Dcompute">Get Compute<\/a>/);
        expectSectionOrder(html, ['data-testid="plan-free"', 'data-testid="plan-standard"', 'data-testid="plan-compute"']);
        for (const plan of ['free', 'standard', 'compute']) {
            const card = html.match(new RegExp(`<article[^>]*data-testid="plan-${plan}"[\\s\\S]*?</article>`))?.[0] ?? '';
            const note = plan === 'free' ? 'no card needed' : 'before tax';
            expectSectionOrder(card, [`id="plan-${plan}-title"`, `class="${styles.price}"`, note, '<a ', '<dl ']);
            expect(card.includes(styles.compute)).toBe(plan === 'compute');
            if (plan === 'free') expect(card).toMatch(/href="\/login">Start free<\/a>/);
        }
        const plans = html.match(/<section id="plans"[\s\S]*?<\/section>/)?.[0] ?? '';
        expect(textContent(plans)).toContain('Prices before tax. One computer runs at a time on each plan.');
    });

    it('has no client components, image loads, scripts, or soft links', () => {
        const clientCode = /['"]use client['"]|from\s+['"]next\/link['"]|<Link\b/;
        for (const control of ["'use client';", "import Link from 'next/link';", '<Link href="/os" />']) expect(clientCode.test(control)).toBe(true);
        for (const source of sources) expect(source).not.toMatch(clientCode);
        const assets = /<(script|img|iframe)\b/;
        expect(assets.test('<img src="desktop.png" />')).toBe(true);
        expect(render()).not.toMatch(assets);
        expect(render()).toContain('Browser');
        expect(render()).toContain('VS Code');
    });

    it('derives overage terms from the contract and keeps the section informational', () => {
        const { overage, plans } = getPricingContent(false);
        const section = render().match(/<section[^>]*aria-labelledby="overage-title"[\s\S]*?<\/section>/)?.[0];
        expect(section).toContain('<h2 id="overage-title">Usage beyond your allowance (Compute)</h2>');
        for (const value of [OVERAGE_CENTS_PER_STD_HOUR, OVERAGE_DEFAULT_CAP_CENTS, OVERAGE_MAX_CAP_CENTS]) {
            expect(overage.body).toContain(`$${value / 100}`);
            expect(plans[2].note).toContain(`$${value / 100}`);
            expect(section).toContain(`$${value / 100}`);
        }
        expect(plans[2].note).toBe(`Optional overage at $${OVERAGE_CENTS_PER_STD_HOUR / 100} per standard-hour, off by default, with a monthly cap you set (default $${OVERAGE_DEFAULT_CAP_CENTS / 100}, up to $${OVERAGE_MAX_CAP_CENTS / 100}).`);
        for (const fragment of ['off by default', `whole dollars from $0 to $${OVERAGE_MAX_CAP_CENTS / 100}`, 'your work is saved and the computer pauses', 'billed separately after each billing period on its own invoice']) {
            expect(overage.body).toContain(fragment);
        }
        const purchaseControl = /<(a|button|form|input)\b/;
        expect(purchaseControl.test('<button>Buy</button>')).toBe(true);
        expect(section).not.toMatch(purchaseControl);
    });

    it('explains all v2 FAQ topics with contract-derived size weights and session times', () => {
        const { faq, limits } = getPricingContent(false);
        const answers = Object.fromEntries(faq.items.map(item => [item.question, item.answer]));
        expect(Object.keys(answers)).toEqual(expect.arrayContaining([
            'What is a standard-hour?', 'Which computer sizes are there?', 'How long can a session run?',
            'What is kept when a computer restarts?', 'How does the overage cap work?', 'When am I billed?',
            'How are taxes handled?', 'Is a computer always available?',
        ]));
        const standardHours = CATALOG_V2.compute_monthly_v2.allowanceStdSeconds / SECONDS_PER_HOUR;
        expect(answers['What is a standard-hour?']).toContain(`1 standard-hour is 1 hour at ${SIZES['std-2'].vcpu} vCPU`);
        for (const code of CATALOG_V2.compute_monthly_v2.sizes) {
            const size = SIZES[code];
            expect(answers['What is a standard-hour?']).toContain(`${standardHours / size.weight} h at ${size.vcpu} vCPU`);
            if (size.weight > 1) expect(answers['What is a standard-hour?']).toContain(`${size.vcpu} vCPU uses ${size.weight} per hour`);
        }
        expect(answers['Which computer sizes are there?']).toContain(`Free has ${SIZES['free-cf'].vcpu} vCPU / ${SIZES['free-cf'].memoryGiB} GiB`);
        expect(answers['Which computer sizes are there?']).toContain(`Standard has ${SIZES['std-2'].vcpu} vCPU / ${SIZES['std-2'].memoryGiB} GiB`);
        expect(answers['Which computer sizes are there?']).toContain(`Compute has ${SIZES['std-2'].vcpu}, ${SIZES['cmp-4'].vcpu} or ${SIZES['cmp-8'].vcpu} vCPU with ${SIZES['std-2'].memoryGiB}, ${SIZES['cmp-4'].memoryGiB} or ${SIZES['cmp-8'].memoryGiB} GiB`);
        expect(answers['How long can a session run?']).toContain(`up to ${SESSION_MAX_SECONDS / SECONDS_PER_HOUR} hours, then your work is saved and the computer restarts`);
        expect(answers['How long can a session run?']).toContain(`Idle computers sleep after ${IDLE_SLEEP_SECONDS / 60} minutes`);
        expect(answers['What is kept when a computer restarts?']).toBe('Files, the editor state on disk and installed tools are kept; running processes start fresh.');
        expect(answers['How does the overage cap work?']).toBe(getPricingContent(false).overage.body);
        for (const fragment of ['monthly in advance via Stripe', 'in arrears on its own invoice', 'Cancel or switch to Standard', 'takes effect at period end', 'once the prorated payment succeeds']) {
            expect(answers['When am I billed?']).toContain(fragment);
        }
        expect(answers['How are taxes handled?']).toBe('Prices are before applicable tax; any applicable tax is shown before you pay, and receipts arrive by email. Sold by EZiL LLC.');
        expect(answers['Is a computer always available?']).toBe('Computers use shared capacity. Availability is not guaranteed at peak times.');
        expect(limits.rows).toEqual([
            { label: 'Compute time', value: 'Your work is saved and the computer pauses until your allowance renews, you upgrade, or — on Compute — you turn on overage.' },
            { label: 'Saved storage', value: 'New saves pause. Your files stay readable and downloadable.' },
        ]);
    });

    it('pins Horizon, responsive sizing, focus and reduced motion', () => {
        const shell = read('../../../../../shell/ezil/ui/ezil-shell.css');
        const layers = (source: string) => source.match(/background-image:\s*([\s\S]*?);/)?.[1].replace(/\s+/g, ' ');
        expect(layers(css)).toContain('radial-gradient');
        expect(layers(css)).toBe(layers(shell));
        expect(css).toContain('aspect-ratio: 16 / 10');
        expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
        expect(css).toMatch(/@media \(min-width: 1024px\)\s*\{\s*\.plans\s*\{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
        expect(css).toMatch(/@media \(max-width: 767px\)\s*\{\s*\.plans\s*\{ grid-template-columns: minmax\(0, 1fr\);/);
        expect(css).toContain('@media (max-width: 639px)');
        expect(css).toContain('.card { min-width: 0;');
        expect(css).toContain('overflow-wrap: anywhere;');
        expect(css).toContain('.cardHeading { display: flex; flex-wrap: wrap;');
        expect(css).toContain('.compute { border-color: var(--accent); }');
        expect(css).toContain('outline: 2px solid var(--accent); outline-offset: 2px');
        expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    });
});

describe('login entry preserves document destinations', () => {
    it('carries each paid upgrade deep link through the existing returnUrl validation', async () => {
        for (const plan of getPricingContent(false).plans) {
            const url = new URL(plan.cta.href, 'https://example.test');
            const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }));
            expect(html).toContain(plan.id === 'free' ? 'name="returnUrl" value="/os"' : `name="returnUrl" value="/os?settings=billing&amp;upgrade=${plan.id}"`);
        }
    });

    it('shows a plain Plans link only when enabled', async () => {
        const login = async () => renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
        const disabled = await login();
        flags.pricingPageEnabled = true;
        const enabled = await login();
        expect(enabled).toMatch(/<a href="\/pricing"[^>]*>Plans<\/a>/);
        expect(disabled).not.toContain('href="/pricing"');
        expect(disabled).toContain('Privacy Policy');
        expect(enabled.replace(/ <a href="\/pricing"[^>]*>Plans<\/a>/, '')).toBe(disabled);
    });
});
