import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPrinter, createSourceFile, ScriptKind, ScriptTarget } from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_PACKS, FREE_PLAN, PRO_PLAN, storageCapBytes } from '@/server/billing/catalog';
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
const banned = /faster|instant|unlimited|priority|vcpu|gpu|heavy\s+use|fair\s+use|gpt|claude|gemini|llama/i;

/** Include metadata and accessible names as well as all rendered text and FAQ answers. */
function strings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
    return [];
}
const render = (largeStorageEnabled = false, focusPlans = false) => renderToStaticMarkup(MarketingHome({ largeStorageEnabled, focusPlans }));
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
    it.each(['faster', 'INSTANT', 'unlimited', 'priority', 'vCPU', 'GPU', 'heavy use', 'fair use', 'GPT', 'Claude', 'Gemini', 'Llama'])(
        'catches prohibited copy: %s', word => expect(banned.test(`This plan is ${word}.`)).toBe(true),
    );

    it.each([false, true])('scans all content, metadata, accessible labels and rendered text (storage: %s)', storage => {
        const copy = strings([getPricingContent(storage), marketingContent, pricingMetadata]);
        const pages = [render(storage), render(storage, true)];
        expect(copy).toContain('Open EZiL OS and get to work.');
        for (const html of pages) {
            expect(html).toContain('Is a computer always available?');
            expect(html).toContain(`aria-label="${marketingContent.navigationLabel}"`);
        }
        expect(banned.test('Build faster')).toBe(true);
        for (const value of [...copy, ...pages, ...pages.map(textContent), ...sources.map(withoutComments)]) expect(value).not.toMatch(banned);
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

    it.each([false, true])('derives prices and all six allowances from the catalog (storage: %s)', storage => {
        const { plans, topUps } = getPricingContent(storage);
        const [free, pro] = plans;
        expect(free.price).toBe('$0');
        expect(pro.price).toBe(`$${PRO_PLAN.unitAmountCents / 100}`);
        expect(pro.interval).toBe(`/${PRO_PLAN.interval}`);
        expect(free.billingNote).toBe('USD · no card needed');
        expect(pro.billingNote).toBe('USD · before applicable tax · cancel anytime');
        for (const plan of plans) {
            expect(plan.allowances[2].caption).toBe('AI assistant coming soon');
            for (const tile of plan.allowances) {
                expect(render(storage)).toContain(`data-testid="allowance-${plan.id}-${tile.id}"`);
                expect(render(storage)).toContain(`<strong>${tile.value}</strong>`);
            }
        }
        expect(free.allowances[0].value).toBe(`${FREE_PLAN.workspaceSeconds / 3600}`);
        expect(pro.allowances[0].value).toBe(`${PRO_PLAN.workspaceSeconds / 3600}`);
        expect(free.allowances[1].value).toBe(`${Number(FREE_PLAN.storageBytes) / 1_000_000_000}`);
        expect(pro.allowances[1].value).toBe(`${Number(storageCapBytes('pro', storage)) / 1_000_000_000}`);
        expect(pro.allowances[1].unit).toBe(storage ? 'GB' : `GB today · ${Number(PRO_PLAN.storageBytes) / 1_000_000_000} GB soon`);
        expect(free.allowances[2].value).toBe(`$${(Number(FREE_PLAN.aiTrialMicro) / 1_000_000).toFixed(2)}`);
        expect(pro.allowances[2].value).toBe(`$${Number(PRO_PLAN.aiIncludedMicro) / 1_000_000}`);
        for (const pack of AI_PACKS) expect(topUps.title).toContain(`$${pack.creditCents / 100}`);
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
        expectSectionOrder(html, ['<header', 'id="plans"', 'id="top-ups-title"', 'id="limits-title"', 'id="faq-title"', 'id="closing-title"', '<footer']);
        expect(html).toContain('href="#plans"');
        expect(html).toContain('Sold by EZiL LLC');
        for (const id of ['plan-free', 'plan-pro', 'cta-get-pro']) expect(html).toContain(`data-testid="${id}"`);
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
        expect(render(false)).toContain('GB today · 20 GB soon');
        expect(render(true)).not.toContain('GB today · 20 GB soon');
        flags.pricingPageEnabled = false;
        expect(() => PricingPage()).toThrow('pricing disabled');
    });

    it('renders all ten sections in order and every pinned selector', () => {
        const html = render();
        expect(html.match(/<h1\b/g)).toHaveLength(1);
        expect(html).toMatch(/data-testid="home-hero"[^>]*>[\s\S]*?<h1 id="home-title">Open EZiL OS and get to work\.<\/h1>/);
        expect(html).toContain('<h2 id="plans-title">Plans</h2>');
        expect(html.match(/<article\b/g)).toHaveLength(2);
        expect(html.match(/<section\b/g)).toHaveLength(7);
        expectSectionOrder(html, ['<header', 'data-testid="home-hero"', `class="${styles.desktop}" aria-hidden="true"`, 'aria-label="Your workspace"', 'id="plans"', 'id="top-ups-title"', 'id="limits-title"', 'id="faq-title"', 'id="closing-title"', '<footer']);
        for (const id of ['home-hero', 'cta-start-free', 'cta-sign-in', 'plan-free', 'plan-pro', 'cta-get-pro']) {
            expect(html).toContain(`data-testid="${id}"`);
        }
        for (const link of marketingContent.links) expect(html).toContain(`href="${link.href}">${link.label}</a>`);
        expect(html).toContain('Sold by EZiL LLC');
        for (const match of html.matchAll(/<(a)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
            expect(textContent(match[2]).trim().length).toBeGreaterThan(0);
        }
    });

    it.each([false, true])('renders six FAQ questions as h3 headings with visible answers (plans first: %s)', focusPlans => {
        const html = render(false, focusPlans);
        const faq = html.match(/<section[^>]*aria-labelledby="faq-title"[\s\S]*?<\/section>/)?.[0] ?? '';
        expect(faq).toContain('<h2 id="faq-title">Frequently asked questions</h2>');
        expect(faq.match(/<h3\b/g)).toHaveLength(6);
        expect(faq.match(/<p\b/g)).toHaveLength(6);
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
        expect(html).toMatch(/data-testid="cta-get-pro"[^>]*href="\/login\?returnUrl=%2Fos%3Fsettings%3Dbilling%26upgrade%3Dpro">Get Pro<\/a>/);
        for (const plan of ['free', 'pro']) {
            const card = html.match(new RegExp(`<article[^>]*data-testid="plan-${plan}"[\\s\\S]*?</article>`))?.[0] ?? '';
            const note = plan === 'pro' ? 'before applicable tax' : 'no card needed';
            expect(card).toContain(note);
            expect(card.indexOf('<a ')).toBeGreaterThan(card.indexOf(note));
            expect(card.indexOf('<dl ')).toBeGreaterThan(card.indexOf('<a '));
        }
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

    it('keeps top-ups informational before the assistant launches', () => {
        const topUps = render().match(/<section[^>]*aria-labelledby="top-ups-title"[\s\S]*?<\/section>/)?.[0];
        expect(topUps).toContain('$10 or $25 packs, plus a small service fee.');
        expect(topUps).toContain('when the assistant launches');
        const purchaseControl = /<(a|button|form)\b/;
        expect(purchaseControl.test('<button>Buy</button>')).toBe(true);
        expect(topUps).not.toMatch(purchaseControl);
    });

    it('pins Horizon, responsive sizing, focus and reduced motion', () => {
        const shell = read('../../../../../shell/ezil/ui/ezil-shell.css');
        const layers = (source: string) => source.match(/background-image:\s*([\s\S]*?);/)?.[1].replace(/\s+/g, ' ');
        expect(layers(css)).toContain('radial-gradient');
        expect(layers(css)).toBe(layers(shell));
        expect(css).toContain('aspect-ratio: 16 / 10');
        expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
        expect(css).toContain('@media (max-width: 767px)');
        expect(css).toContain('@media (max-width: 639px)');
        expect(css).toContain('outline: 2px solid var(--accent); outline-offset: 2px');
        expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    });
});

describe('login entry preserves document destinations', () => {
    it('carries the exact Pro upgrade deep link through the existing returnUrl validation', async () => {
        for (const plan of getPricingContent(false).plans) {
            const url = new URL(plan.cta.href, 'https://example.test');
            const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }));
            expect(html).toContain(plan.id === 'pro' ? 'name="returnUrl" value="/os?settings=billing&amp;upgrade=pro"' : 'name="returnUrl" value="/os"');
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
