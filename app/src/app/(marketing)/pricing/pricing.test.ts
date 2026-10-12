import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
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
import { viewport } from '../layout';
import LoginPage from '../../login/page';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.resolve(here, file), 'utf8').replace(/\r\n/g, '\n');
const sources = ['./page.tsx', '../layout.tsx', '../_components/home-page.tsx', './pricing-content.ts'].map(read);
const css = read('../marketing.module.css');
const banned = /faster|instant|unlimited|priority|vcpu|gpu|heavy\s+use|fair\s+use|gpt|claude|gemini|llama/i;

/** Include metadata and accessible names as well as all rendered text, even closed FAQ answers. */
function strings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
    return [];
}
const render = (largeStorageEnabled = false, focusPlans = false) => renderToStaticMarkup(MarketingHome({ largeStorageEnabled, focusPlans }));
const textContent = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

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
        const html = render(storage);
        expect(copy).toContain('Open EZiL OS and get to work.');
        expect(html).toContain('Is a computer always available?');
        expect(banned.test('Build faster')).toBe(true);
        for (const value of [...copy, textContent(html), ...sources]) expect(value).not.toMatch(banned);
    });

    it.each([false, true])('derives prices and all six allowances from the catalog (storage: %s)', storage => {
        const { plans, topUps } = getPricingContent(storage);
        const [free, pro] = plans;
        expect(free.price).toBe('$0');
        expect(pro.price).toBe(`$${PRO_PLAN.unitAmountCents / 100}`);
        expect(pro.interval).toBe(`/${PRO_PLAN.interval}`);
        for (const plan of plans) {
            expect(plan.billingNote).toBe('USD · before applicable tax · cancel anytime');
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
    it('gates /pricing per request, then renders the same home with native plans focus', () => {
        expect(() => PricingPage()).toThrow('pricing disabled');
        flags.pricingPageEnabled = true;
        const html = renderToStaticMarkup(PricingPage());
        expect(html).toBe(render(false, true));
        expect(html).toMatch(/<section id="plans"[^>]*tabindex="-1"[^>]*autofocus=""/);
        expect(dynamic).toBe('force-dynamic');
        expect(metadata.title).toBe('Plans · EZiL OS');
        expect(viewport.interactiveWidget).toBe('resizes-content');
        flags.largeStorageEnabled = true;
        expect(renderToStaticMarkup(PricingPage())).toBe(render(true, true));
        expect(render(false)).toContain('GB today · 20 GB soon');
        expect(render(true)).not.toContain('GB today · 20 GB soon');
    });

    it('renders all ten sections in order and every pinned selector', () => {
        const html = render();
        expect(html.match(/<h1\b/g)).toHaveLength(1);
        expect(html.match(/<article\b/g)).toHaveLength(2);
        expect(html.match(/<details\b/g)).toHaveLength(6);
        expect(html.match(/<summary\b/g)).toHaveLength(6);
        let previous = -1;
        for (const marker of ['<header', 'data-testid="home-hero"', 'aria-hidden="true"', 'aria-label="Your workspace"', 'id="plans"', 'id="top-ups-title"', 'id="limits-title"', 'id="faq-title"', 'id="closing-title"', '<footer']) {
            expect(html.indexOf(marker)).toBeGreaterThan(previous);
            previous = html.indexOf(marker);
        }
        for (const id of ['home-hero', 'cta-start-free', 'cta-sign-in', 'plan-free', 'plan-pro', 'cta-get-pro']) {
            expect(html).toContain(`data-testid="${id}"`);
        }
        for (const link of marketingContent.links) expect(html).toContain(`href="${link.href}">${link.label}</a>`);
        expect(html).toContain('Sold by EZiL LLC');
        for (const match of html.matchAll(/<(a|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
            expect(textContent(match[2]).trim().length).toBeGreaterThan(0);
        }
    });

    it('pins CTA destinations and their placement before the allowance tiles', () => {
        const html = render();
        expect(html).toMatch(/data-testid="cta-start-free"[^>]*href="\/login">Start free<\/a>/);
        expect(html).toMatch(/data-testid="cta-sign-in"[^>]*href="\/login\?method=email">Sign in<\/a>/);
        expect(html).toMatch(/data-testid="cta-get-pro"[^>]*href="\/login\?returnUrl=%2Fos%3Fsettings%3Dbilling%26upgrade%3Dpro">Get Pro<\/a>/);
        for (const plan of ['free', 'pro']) {
            const card = html.match(new RegExp(`<article[^>]*data-testid="plan-${plan}"[\\s\\S]*?</article>`))?.[0] ?? '';
            expect(card).toContain('before applicable tax');
            expect(card.indexOf('<a ')).toBeGreaterThan(card.indexOf('before applicable tax'));
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
