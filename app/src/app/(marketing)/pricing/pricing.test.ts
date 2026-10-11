import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_PACKS, FREE_PLAN, PRO_PLAN, storageCapBytes } from '@/server/billing/catalog';
import { getPricingContent, marketingContent, pricingMetadata } from './pricing-content';

const flags = vi.hoisted(() => ({ pricingPageEnabled: false, largeStorageEnabled: false }));

// Use the real parser with explicit, non-secret inputs; tests never need the host environment.
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
import MarketingLayout, { viewport } from '../layout';
import LoginPage from '../../login/page';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.resolve(here, file), 'utf8').replace(/\r\n/g, '\n');
const pageSource = read('./page.tsx');
const layoutSource = read('../layout.tsx');
const loginSource = read('../../login/page.tsx');

/** Walk values, including nested rows and FAQ answers, rather than a selected copy sample. */
function strings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
    return [];
}

const banned = /faster|instant|unlimited|priority|vcpu|gpu|heavy\s+use|fair\s+use|gpt|claude|gemini|llama/i;

beforeEach(() => {
    flags.pricingPageEnabled = false;
    flags.largeStorageEnabled = false;
});

describe('public pricing copy follows contract §8', () => {
    it.each(['faster', 'INSTANT', 'unlimited', 'priority', 'vCPU', 'GPU', 'heavy use', 'fair use', 'GPT', 'Claude', 'Gemini', 'Llama'])(
        'the scanner catches prohibited copy: %s', word => {
            expect(banned.test(`This plan is ${word}.`)).toBe(true);
        },
    );

    it('scans every string in both storage states, metadata, chrome and source', () => {
        const copy = strings([getPricingContent(false), getPricingContent(true), marketingContent, pricingMetadata]);
        expect(copy).toContain('Open EZiL OS and get to work.');
        expect(copy).toContain('Is a computer always available?');
        expect(banned.test('Build faster')).toBe(true);
        for (const value of [...copy, read('./pricing-content.ts'), pageSource, layoutSource]) {
            expect(value).not.toMatch(banned);
        }
    });

    it.each([false, true])('derives every amount from the catalog (large storage: %s)', largeStorageEnabled => {
        const { plans, topUps } = getPricingContent(largeStorageEnabled);
        const [free, pro] = plans;
        expect(free.price).toBe('$0');
        expect(pro.price).toBe(`$${PRO_PLAN.unitAmountCents / 100} / ${PRO_PLAN.interval}`);
        expect(pro.billingNote).toBe('USD, before applicable tax · billed monthly · cancel anytime');
        expect(free.rows[0].value).toBe(`${FREE_PLAN.workspaceSeconds / 3600} hours / month`);
        expect(pro.rows[0].value).toBe(`${PRO_PLAN.workspaceSeconds / 3600} hours / month`);
        expect(free.rows[1].value).toBe(`${Number(FREE_PLAN.storageBytes) / 1_000_000_000} GB`);
        const cap = `${Number(storageCapBytes('pro', largeStorageEnabled)) / 1_000_000_000} GB`;
        const future = `${Number(PRO_PLAN.storageBytes) / 1_000_000_000} GB`;
        expect(pro.rows[1].value).toBe(largeStorageEnabled ? cap : `${cap} today — ${future} coming soon`);
        expect(free.rows[2].value).toBe(`$${(Number(FREE_PLAN.aiTrialMicro) / 1_000_000).toFixed(2)} one-time trial`);
        expect(pro.rows[2].value).toBe(`$${Number(PRO_PLAN.aiIncludedMicro) / 1_000_000} included every month`);
        expect(topUps.packs).toEqual(AI_PACKS.map(pack => `$${pack.creditCents / 100} of AI credits + $${(pack.serviceFeeCents / 100).toFixed(2)} service fee`));
        expect(topUps.packs).toEqual(['$10 of AI credits + $0.84 service fee', '$25 of AI credits + $1.61 service fee']);
        expect(topUps.note).toBe('Available when the AI assistant launches.');
        for (const plan of plans) {
            expect(plan.rows[2].note).toBe('AI assistant coming soon');
            expect(plan.sharedNote).toBe('Same EZiL OS, same standard computer, same AI assistant.');
        }
    });
});

describe('pricing is a gated server document', () => {
    it('returns notFound when disabled and renders when enabled', () => {
        expect(() => PricingPage()).toThrow('pricing disabled');
        flags.pricingPageEnabled = true;
        const html = renderToStaticMarkup(PricingPage());
        expect(html).toContain('Open EZiL OS and get to work.');
        expect(html.match(/<article\b/g)).toHaveLength(2);
        expect(html.match(/<details\b/g)).toHaveLength(6);
        expect(html.match(/<summary\b/g)).toHaveLength(6);
        expect(html).toContain('href="/login">Start free</a>');
        expect(html).toContain('href="/login?next=/os">Upgrade</a>');
        expect(html).toContain('2 GB today — 20 GB coming soon');
        flags.largeStorageEnabled = true;
        const enabled = renderToStaticMarkup(PricingPage());
        expect(enabled).toContain('<dd>20 GB</dd>');
        expect(enabled).not.toContain('2 GB today — 20 GB coming soon');
    });

    it('keeps the route dynamic and the refusal before rendering', () => {
        expect(dynamic).toBe('force-dynamic');
        expect(metadata.title).toBe('Plans · EZiL OS');
        expect(pageSource).toMatch(/if\s*\(!readBillingConfig\(\)\.pricingPageEnabled\)\s*notFound\(\)/);
        expect(pageSource.indexOf('notFound();')).toBeLessThan(pageSource.indexOf('return ('));
        const clientDirective = /['"]use client['"]/;
        expect(clientDirective.test("'use client';")).toBe(true);
        expect(pageSource).not.toMatch(clientDirective);
    });

    it('uses document links without importing next/link', () => {
        const linkImport = /from\s+['"]next\/link['"]/;
        expect(linkImport.test("import Link from 'next/link';")).toBe(true);
        for (const source of [pageSource, layoutSource]) {
            expect(source).toMatch(/<a\b/);
            expect(source).not.toMatch(linkImport);
        }
    });

    it('keeps top-ups informational until the assistant launches', () => {
        flags.pricingPageEnabled = true;
        const html = renderToStaticMarkup(PricingPage());
        const topUps = html.match(/<section[^>]*aria-labelledby="top-ups-title"[\s\S]*?<\/section>/)?.[0];
        expect(topUps).toContain('$10 of AI credits + $0.84 service fee');
        expect(topUps).toContain('Available when the AI assistant launches.');
        const purchaseControl = /<(a|button|form)\b/;
        expect(purchaseControl.test('<a href="/checkout">Buy</a>')).toBe(true);
        expect(topUps).not.toMatch(purchaseControl);
    });

    it('restores the document keyboard policy and renders the seller and footer links', () => {
        expect(viewport.interactiveWidget).toBe('resizes-content');
        const html = renderToStaticMarkup(MarketingLayout({ children: null }));
        expect(html).toContain('Sold by EZiL LLC');
        for (const link of marketingContent.links) expect(html).toContain(`href="${link.href}">${link.label}</a>`);
    });
});

describe('login exposes Plans only under the pricing flag', () => {
    it('both pricing CTAs preserve the default document destination of /os', async () => {
        for (const plan of getPricingContent(false).plans) {
            const url = new URL(plan.cta.href, 'https://example.test');
            expect(url.pathname).toBe('/login');
            const searchParams = Promise.resolve(Object.fromEntries(url.searchParams));
            const html = renderToStaticMarkup(await LoginPage({ searchParams }));
            expect(html).toContain('name="returnUrl" value="/os"');
        }
    });

    it('wraps the plain anchor in the same configuration flag', () => {
        expect(loginSource).toMatch(/readBillingConfig\(\)\.pricingPageEnabled && \([\s\S]*?<a href="\/pricing"[^>]*>Plans<\/a>/);
    });

    it('adds only the Plans anchor when enabled and preserves the disabled markup', async () => {
        const render = async () => renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
        const disabled = await render();
        flags.pricingPageEnabled = true;
        const enabled = await render();
        expect(enabled).toMatch(/<a href="\/pricing"[^>]*>Plans<\/a>/);
        expect(disabled).not.toContain('href="/pricing"');
        expect(disabled).toContain('Privacy Policy');
        expect(enabled.replace(/ <a href="\/pricing"[^>]*>Plans<\/a>/, '')).toBe(disabled);
    });
});
