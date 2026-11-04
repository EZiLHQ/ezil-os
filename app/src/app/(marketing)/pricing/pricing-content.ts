import { CATALOG_V3 } from '@/server/billing/v3/contract';

export const pricingMetadata = {
    title: 'Plans · EZiL OS',
    description: 'Start free. Choose longer sessions and a bigger computer when you need them.',
} as const;

/** A home-page feature tile: a description, or a short badge (none ships today). */
type MarketingFeature = { readonly title: string; readonly description?: string; readonly badge?: string };
const features: readonly MarketingFeature[] = [
    { title: 'A real desktop', description: 'Your files and installed tools stay with your computer between sessions.' },
    { title: 'Browser and VS Code built in', description: 'Build and preview without installing anything.' },
    { title: 'EZiL AI in Code and Chat', description: 'Every plan comes with AI credits to use in Code and Chat.' },
];

export const marketingContent = {
    skipLink: 'Skip to content',
    brand: 'EZiL OS',
    navigationLabel: 'Main navigation',
    plansLink: { label: 'Plans', href: '#plans' },
    startLink: { label: 'Start free', href: '/login' },
    signInLink: { label: 'Sign in', href: '/login?method=email' },
    desktop: { browser: 'Browser', editor: 'VS Code' },
    featuresLabel: 'Your workspace',
    features,
    closing: 'Start building for free',
    seller: 'Sold by EZiL LLC',
    footerLabel: 'Legal and support',
    links: [
        { label: 'Terms', href: '/terms' },
        { label: 'Privacy', href: '/privacy' },
        { label: 'Refunds', href: '/refunds' },
        { label: 'Support', href: 'mailto:contact@ezil.work' },
    ],
} as const;

const hours = (seconds: number) => seconds / 3600;
const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** The public offer and both routes follow the pinned v3 catalog. */
export function getPricingContent(...legacyDisplayOptions: [boolean?, (string | null)?]) {
    // Older callers pass display flags; v3 always uses the same public catalog.
    void legacyDisplayOptions;
    const offers = Object.values(CATALOG_V3);
    return {
        hero: {
            eyebrow: 'Your computer in the cloud',
            title: 'Open EZiL OS and get to work.',
            description: 'A full desktop with a browser and VS Code, in any tab. Start free and choose longer sessions when you need them.',
            caption: 'No card needed for Free.',
        },
        plansLabel: 'Choose your plan',
        plans: offers.map((offer, index) => ({
            id: offer.tier,
            name: offer.name,
            tagline: offer.tagline,
            price: dollars(offer.priceCents),
            interval: offer.interval ? `/${offer.interval}` : '',
            billingNote: offer.interval ? 'Usage included · billed monthly' : 'No card needed',
            // Standard trial (Standard only, never Premium). No date: this page is unauthenticated; Settings → Billing
            // shows the exact end, which is the first charge, before checkout.
            trialNote: offer.tier === 'standard' && offer.interval
                ? `Try one month free — $0 today, then ${dollars(offer.priceCents)}/${offer.interval} unless you cancel` : null,
            highlighted: offer.highlighted,
            badge: offer.badge,
            includes: index ? `Everything in ${offers[index - 1].name}, plus:` : 'Included with Free:',
            bullets: offer.bullets,
            cta: offer.tier === 'free' ? marketingContent.startLink : {
                label: `Get ${offer.name}`,
                href: `/login?returnUrl=${encodeURIComponent(`/os?settings=billing&upgrade=${offer.tier}`)}`,
            },
        })),
        sharedNote: 'Prices before tax.',
        faq: {
            title: 'Frequently asked questions',
            items: [
                {
                    question: 'What is a session?',
                    answer: `A session is one stretch of time while your computer is running. Free sessions last up to ${hours(CATALOG_V3.free_v3.sessionMaxSeconds!)} hour. Standard and Premium sessions last up to ${hours(CATALOG_V3.standard_monthly_v3.sessionMaxSeconds!)} hours. At the session limit, your files are saved and the computer stops. You can start a new session from those files. One computer runs at a time.`,
                },
                {
                    // Paid compute policy v1 (founder e713d157): Free keeps a monthly allowance; Standard and Premium have none.
                    question: 'How much computer time is included?',
                    answer: `Free includes about ${hours(CATALOG_V3.free_v3.fairUseSeconds)} hours of computer time a month; older Free accounts keep ${hours(CATALOG_V3.free_v3.legacyFairUseSeconds!)} hours. If you reach it, your computer pauses until it renews each calendar month in UTC, or you can upgrade. Starting another session does not reset it. Standard and Premium have no monthly computer-hours allowance: each session lasts up to ${hours(CATALOG_V3.standard_monthly_v3.sessionMaxSeconds!)} hours, and starting a computer depends on available capacity.`,
                },
                {
                    question: 'What stays after a session?',
                    answer: 'Your files and installed tools stay. Running processes stop; they start fresh in the next session.',
                },
                {
                    question: 'How do upgrades and cancellations work?',
                    answer: 'Start a paid plan from Settings → Billing. Standard to Premium upgrades show the prorated price before you pay and apply once payment succeeds. Cancellations and changes to a lower plan take effect at the end of your billing period. Your paid plan stays active until then.',
                },
                {
                    question: 'Which computer sizes can I choose?',
                    answer: 'Free runs a 2 vCPU computer on Cloudflare. Standard runs your own 2 vCPU · 8 GB computer on AWS (India). Premium lets you choose 2, 4 or 8 vCPU (8, 16 or 32 GB). Your choice applies to your next session.',
                },
                {
                    question: 'How much storage do I get?',
                    answer: `Storage is the disk on your computer. Standard comes with a ${CATALOG_V3.standard_monthly_v3.storageGiB} GB disk and Premium with a ${CATALOG_V3.premium_monthly_v3.storageGiB} GB disk when your computer is first set up. Some space is used by the system. On Free, your files are saved between sessions. Your computer keeps its disk and your files when you change plan or configuration.`,
                },
            ],
        },
    };
}
