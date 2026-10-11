import { AI_PACKS, FREE_PLAN, PRO_PLAN, storageCapBytes } from '@/server/billing/catalog';

interface PricingLink {
    label: string;
    href: string;
}

interface PricingRow {
    label: string;
    value: string;
    note?: string;
}

interface PricingPlan {
    id: 'free' | 'pro';
    name: string;
    price: string;
    billingNote?: string;
    description: string;
    rows: readonly PricingRow[];
    sharedNote: string;
    cta: PricingLink;
    ctaNote?: string;
}

interface PricingContent {
    hero: { title: string; description: string };
    plansLabel: string;
    plans: readonly [PricingPlan, PricingPlan];
    topUps: { title: string; packs: readonly string[]; note: string };
    limits: { title: string; rows: readonly PricingRow[] };
    faq: { title: string; items: readonly { question: string; answer: string }[] };
}

export const pricingMetadata = {
    title: 'Plans · EZiL OS',
    description: 'Start free. Upgrade for more AI credits, more workspace time and more storage.',
} as const;

export const marketingContent: {
    skipLink: string;
    brand: string;
    brandSuffix: string;
    brandLabel: string;
    backLink: PricingLink;
    seller: string;
    footerLabel: string;
    links: readonly PricingLink[];
} = {
    skipLink: 'Skip to content',
    brand: 'EZiL',
    brandSuffix: 'OS',
    brandLabel: 'EZiL OS — back to login',
    backLink: { label: 'Back to login', href: '/login' },
    seller: 'Sold by EZiL LLC',
    footerLabel: 'Legal and support',
    links: [
        { label: 'Terms', href: '/terms' },
        { label: 'Privacy', href: '/privacy' },
        { label: 'Refunds', href: '/refunds' },
        { label: 'Support', href: 'mailto:contact@ezil.work' },
    ],
};

/** Keep whole-dollar prices compact while preserving cents on trials and fees. */
function dollars(amount: number): string {
    return `$${amount.toFixed(Number.isInteger(amount) ? 0 : 2)}`;
}

const storage = (bytes: bigint) => `${Number(bytes) / 1_000_000_000} GB`;
const workspace = (seconds: number) => `${seconds / 3600} hours / month`;

/**
 * One scan covers the complete offer, including the storage gate's two states.
 * Catalog values stay authoritative so marketing cannot drift from billing.
 */
export function getPricingContent(largeStorageEnabled: boolean): PricingContent {
    const aiNote = 'AI assistant coming soon';
    const sharedNote = 'Same EZiL OS, same standard computer, same AI assistant.';
    const proStorage = storage(storageCapBytes('pro', largeStorageEnabled));

    return {
        hero: {
            title: 'Open EZiL OS and get to work.',
            description: pricingMetadata.description,
        },
        plansLabel: 'Choose your plan',
        plans: [
            {
                id: 'free',
                name: 'EZiL Free',
                price: dollars(0),
                description: 'Start building with a free workspace and a small AI trial.',
                rows: [
                    { label: 'Workspace time', value: workspace(FREE_PLAN.workspaceSeconds) },
                    { label: 'Saved storage', value: storage(FREE_PLAN.storageBytes) },
                    { label: 'AI credits', value: `${dollars(Number(FREE_PLAN.aiTrialMicro) / 1_000_000)} one-time trial`, note: aiNote },
                ],
                sharedNote,
                cta: { label: 'Start free', href: '/login' },
            },
            {
                id: 'pro',
                name: 'EZiL Pro',
                price: `${dollars(PRO_PLAN.unitAmountCents / 100)} / ${PRO_PLAN.interval}`,
                billingNote: `${PRO_PLAN.currency.toUpperCase()}, before applicable tax · billed monthly · cancel anytime`,
                description: 'More AI credits. More time to build. More storage for your projects.',
                rows: [
                    { label: 'Workspace time', value: workspace(PRO_PLAN.workspaceSeconds) },
                    { label: 'Saved storage', value: largeStorageEnabled ? proStorage : `${proStorage} today — ${storage(PRO_PLAN.storageBytes)} coming soon` },
                    { label: 'AI credits', value: `${dollars(Number(PRO_PLAN.aiIncludedMicro) / 1_000_000)} included every month`, note: aiNote },
                ],
                sharedNote,
                cta: { label: 'Upgrade', href: '/login?next=/os' },
                ctaNote: 'Upgrade from Settings → Billing after you sign in',
            },
        ],
        topUps: {
            title: 'Need more AI? Add credits without changing your plan.',
            packs: AI_PACKS.map(pack => `${dollars(pack.creditCents / 100)} of AI credits + ${dollars(pack.serviceFeeCents / 100)} service fee`),
            note: 'Available when the AI assistant launches.',
        },
        limits: {
            title: 'What happens when you run out',
            rows: [
                { label: 'AI credits', value: 'AI requests pause. Everything else keeps working. Add credits any time.' },
                { label: 'Workspace time', value: 'Your work is saved and the computer pauses until your allowance renews or you upgrade.' },
                { label: 'Saved storage', value: 'New saves pause. Your files stay readable and downloadable.' },
            ],
        },
        faq: {
            title: 'Frequently asked questions',
            items: [
                {
                    question: 'What counts as workspace time?',
                    answer: 'The running time of each computer, from start until stop or sleep. If two computers run at once, both count. Each running interval rounds up to the next whole minute. Your computer stops after 10 minutes without activity. Free time renews each calendar month in UTC; Pro time renews each billing period.',
                },
                {
                    question: 'What does saved storage mean?',
                    answer: 'Your saved project files across your computers, not the computer’s working disk.',
                },
                {
                    question: 'How do AI credits work?',
                    answer: 'AI credits are valued at what the AI provider charges, with no markup. Included credit expires at the end of each billing period. Purchased credit lasts 12 months. Credits have no cash value.',
                },
                {
                    question: 'How do billing and cancellation work?',
                    answer: 'Pro is billed monthly via Stripe. Cancel any time in Settings → Billing. Pro stays active until the billing period ends.',
                },
                {
                    question: 'How are taxes handled?',
                    answer: 'Prices are before applicable tax. Tax is calculated at checkout, and receipts arrive by email. Sold by EZiL LLC.',
                },
                {
                    question: 'Is a computer always available?',
                    answer: 'Computers use shared capacity. Availability is not guaranteed at peak times.',
                },
            ],
        },
    };
}
