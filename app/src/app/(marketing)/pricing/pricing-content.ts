import { AI_PACKS, FREE_PLAN, PRO_PLAN, storageCapBytes } from '@/server/billing/catalog';

interface PricingLink {
    label: string;
    href: string;
}

interface Allowance {
    id: 'workspace' | 'storage' | 'ai';
    label: string;
    value: string;
    unit: string;
    caption: string;
}

interface PricingPlan {
    id: 'free' | 'pro';
    name: string;
    price: string;
    interval: string;
    billingNote: string;
    badge?: string;
    allowances: readonly Allowance[];
    cta: PricingLink;
}

export const pricingMetadata = {
    title: 'Plans · EZiL OS',
    description: 'Start free. Upgrade for more AI credits, more workspace time and more storage.',
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
        { title: 'A real desktop', description: 'Windows, files and apps that stay where you left them.' },
        { title: 'Browser and VS Code built in', description: 'Build and preview without installing anything.' },
        { title: 'AI assistant', badge: 'coming soon' },
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

/** Keep whole-dollar prices compact while preserving cents on trials and fees. */
function dollars(amount: number): string {
    return `$${amount.toFixed(Number.isInteger(amount) ? 0 : 2)}`;
}

const storage = (bytes: bigint) => `${Number(bytes) / 1_000_000_000}`;

/** Both storage states use the billing catalog, so the public offer cannot drift. */
export function getPricingContent(largeStorageEnabled: boolean) {
    const aiNote = 'AI assistant coming soon';
    const billingNote = `${PRO_PLAN.currency.toUpperCase()} · before applicable tax · cancel anytime`;
    const plans: readonly PricingPlan[] = [
        {
            id: 'free',
            // Free has nothing to cancel; its reassurance is that no card is asked for.
            name: 'Free',
            price: dollars(0),
            interval: '',
            billingNote: `${PRO_PLAN.currency.toUpperCase()} · no card needed`,
            cta: marketingContent.startLink,
            allowances: [
                { id: 'workspace', label: 'Workspace time', value: `${FREE_PLAN.workspaceSeconds / 3600}`, unit: 'h/month', caption: 'while a computer runs' },
                { id: 'storage', label: 'Saved storage', value: storage(FREE_PLAN.storageBytes), unit: 'GB', caption: 'for your saved files' },
                { id: 'ai', label: 'AI credits', value: dollars(Number(FREE_PLAN.aiTrialMicro) / 1_000_000), unit: 'one-time', caption: aiNote },
            ],
        },
        {
            id: 'pro',
            name: 'Pro',
            price: dollars(PRO_PLAN.unitAmountCents / 100),
            interval: `/${PRO_PLAN.interval}`,
            billingNote,
            badge: 'Most flexible',
            cta: { label: 'Get Pro', href: '/login?returnUrl=%2Fos%3Fsettings%3Dbilling%26upgrade%3Dpro' },
            allowances: [
                { id: 'workspace', label: 'Workspace time', value: `${PRO_PLAN.workspaceSeconds / 3600}`, unit: 'h/month', caption: 'while a computer runs' },
                {
                    id: 'storage', label: 'Saved storage',
                    value: storage(storageCapBytes('pro', largeStorageEnabled)),
                    unit: largeStorageEnabled ? 'GB' : `GB today · ${storage(PRO_PLAN.storageBytes)} GB soon`,
                    caption: 'for your saved files',
                },
                { id: 'ai', label: 'AI credits', value: dollars(Number(PRO_PLAN.aiIncludedMicro) / 1_000_000), unit: '/month', caption: aiNote },
            ],
        },
    ];

    return {
        hero: {
            eyebrow: 'Your computer in the cloud',
            title: 'Open EZiL OS and get to work.',
            description: 'A full desktop with a browser and VS Code, in any tab. Start free — upgrade when you need more time, storage and AI.',
            caption: 'No card needed for Free.',
        },
        plansLabel: 'Plans',
        plans,
        sharedNote: 'Same EZiL OS, same standard computer, same AI assistant on both plans.',
        topUps: {
            title: `Need more AI? Add credits any time — ${AI_PACKS.map(pack => dollars(pack.creditCents / 100)).join(' or ')} packs, plus a small service fee.`,
            note: 'when the assistant launches',
        },
        limits: {
            title: 'When you run out',
            rows: [
                { label: 'Workspace time', value: 'Your work is saved and the computer pauses until your allowance renews or you upgrade.' },
                { label: 'Saved storage', value: 'New saves pause. Your files stay readable and downloadable.' },
                { label: 'AI credits', value: 'AI requests pause. Everything else keeps working. Add credits any time.' },
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
                    answer: 'Prices are before applicable tax; any applicable tax is shown before you pay, and receipts arrive by email. Sold by EZiL LLC.',
                },
                {
                    question: 'Is a computer always available?',
                    answer: 'Computers use shared capacity. Availability is not guaranteed at peak times.',
                },
            ],
        },
    };
}
