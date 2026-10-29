import { CATALOG_V3 } from '@/server/billing/v3/contract';

export const pricingMetadata = {
    title: 'Plans · EZiL OS',
    description: 'Start free. Choose longer sessions and a bigger computer when you need them.',
} as const;

export const marketingContent = {
    skipLink: 'Skip to content',
    brand: 'EZiL OS',
    navigationLabel: 'Main navigation',
    plansLink: { label: 'Plans', href: '#plans' },
    startLink: { label: 'Start free', href: '/login' },
    signInLink: { label: 'Sign in', href: '/login?method=email' },
    desktop: { browser: 'Browser', editor: 'VS Code' },
    featuresLabel: 'Your workspace',
    features: [
        { title: 'A real desktop', description: 'Your files and installed tools stay with your computer between sessions.' },
        { title: 'Browser and VS Code built in', description: 'Build and preview without installing anything.' },
        { title: 'EZiL AI in Code and Chat', description: 'Every plan comes with AI credits to use in Code and Chat.' },
    ],
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
                    answer: `A session is one stretch of time while your computer is running. Free sessions last up to 1 hour. Standard and Premium: No session time limit. Fair use still applies to every plan. At the Free session limit, your files are saved and the computer stops. You can start a new session from those files. One computer runs at a time.`,
                },
                {
                    question: 'What does fair use mean?',
                    answer: `Usage is included for everyday work: ${offers.map(offer => `about ${hours(offer.fairUseSeconds)} ${offer.tier === 'premium' ? 'standard-hours' : 'hours'} a month on ${offer.name}`).join(', ')}. Older Free accounts keep ${hours(CATALOG_V3.free_v3.legacyFairUseSeconds!)} hours. If you reach fair use, your computer pauses until your allowance renews, or you can upgrade. Free renews each calendar month in UTC; paid plans renew each billing period. Starting another session does not reset fair use.`,
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
                    question: 'Why do bigger computers use time faster?',
                    answer: 'Bigger computers use more resources: 4 vCPU counts double and 8 vCPU counts four times toward your monthly time. One hour on 2 vCPU uses one hour of that time; on 4 vCPU it uses two, and on 8 vCPU it uses four. Your choice applies to your next session.',
                },
                {
                    question: 'How much storage do I get?',
                    answer: `Storage is the disk on your computer. Standard comes with a ${CATALOG_V3.standard_monthly_v3.storageGiB} GB disk and Premium with a ${CATALOG_V3.premium_monthly_v3.storageGiB} GB disk when your computer is first set up. Some space is used by the system. On Free, your files are saved between sessions. Your computer keeps its disk and your files when you change plan or configuration.`,
                },
            ],
        },
    };
}
