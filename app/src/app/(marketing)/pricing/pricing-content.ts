import { FREE_PLAN, storageCapBytes } from '@/server/billing/catalog';
import {
    CATALOG_V2, SIZES, FREE_V2_EFFECTIVE_AT, SECONDS_PER_HOUR,
    OVERAGE_DEFAULT_CAP_CENTS, OVERAGE_MAX_CAP_CENTS, OVERAGE_CENTS_PER_STD_HOUR,
    SESSION_MAX_SECONDS, IDLE_SLEEP_SECONDS,
} from '@/server/billing/v2/contract';

interface PricingLink {
    label: string;
    href: string;
}

interface Allowance {
    id: 'compute' | 'computer' | 'storage';
    label: string;
    value: string;
    unit: string;
    caption?: string;
}

interface PricingPlan {
    id: 'free' | 'standard' | 'compute';
    name: string;
    price: string;
    interval: string;
    billingNote: string;
    badge?: string;
    note?: string;
    disclosure?: string;
    allowances: readonly Allowance[];
    cta: PricingLink;
}

export const pricingMetadata = {
    title: 'Plans · EZiL OS',
    description: 'Start free. Upgrade for more compute time and larger computers.',
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

/** Catalog money is integer cents; keep whole dollars compact without losing cents. */
function dollars(cents: number): string {
    const value = BigInt(cents);
    const centsPerDollar = BigInt(100);
    const remainder = value % centsPerDollar;
    return `$${value / centsPerDollar}${remainder ? `.${String(remainder).padStart(2, '0')}` : ''}`;
}

const storage = (bytes: bigint) => `${Number(bytes) / 1_000_000_000}`;
const hours = (seconds: number) => seconds / SECONDS_PER_HOUR;
const alternatives = (values: readonly (string | number)[]) => `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;

/** Both storage states use the billing catalog, so the public offer cannot drift. */
export function getPricingContent(largeStorageEnabled: boolean, freeV2EffectiveAt: string | null = FREE_V2_EFFECTIVE_AT) {
    const free = CATALOG_V2[freeV2EffectiveAt ? 'free_v2' : 'free_v1_legacy'];
    const standard = CATALOG_V2.standard_monthly_v2;
    const compute = CATALOG_V2.compute_monthly_v2;
    const freeSize = SIZES[free.defaultSize];
    const standardSize = SIZES[standard.defaultSize];
    const computeSizes = compute.sizes.map(code => SIZES[code]);
    const maxCpu = Math.max(...computeSizes.map(size => size.vcpu));
    const maxMemory = Math.max(...computeSizes.map(size => size.memoryGiB));
    const rate = dollars(OVERAGE_CENTS_PER_STD_HOUR);
    const defaultCap = dollars(OVERAGE_DEFAULT_CAP_CENTS);
    const maxCap = dollars(OVERAGE_MAX_CAP_CENTS);
    const billingNote = `${standard.currency.toUpperCase()} · before tax · cancel anytime`;
    const savedStorage: Allowance = {
        id: 'storage', label: 'Saved storage', value: storage(storageCapBytes('pro', largeStorageEnabled)),
        unit: 'GB', caption: 'for your saved files',
    };
    const overageBody = `Overage is off by default. On Compute, usage beyond your allowance costs ${rate} per standard-hour. You set a monthly cap in whole dollars from ${dollars(free.priceCents)} to ${maxCap} (default ${defaultCap}). At the cap, your work is saved and the computer pauses. Usage is billed separately after each billing period on its own invoice.`;
    const plans: readonly PricingPlan[] = [
        {
            id: 'free',
            name: 'Free',
            price: dollars(free.priceCents),
            interval: '',
            billingNote: `${free.currency.toUpperCase()} · no card needed`,
            cta: marketingContent.startLink,
            disclosure: freeV2EffectiveAt ? `Accounts created from ${new Date(freeV2EffectiveAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })} get ${hours(CATALOG_V2.free_v2.allowanceStdSeconds)} h a month; earlier accounts keep ${hours(CATALOG_V2.free_v1_legacy.allowanceStdSeconds)} h.` : undefined,
            allowances: [
                { id: 'compute', label: 'Compute time', value: `${hours(free.allowanceStdSeconds)}`, unit: 'h/month', caption: 'while a computer runs' },
                { id: 'computer', label: 'Computer', value: `${freeSize.vcpu} vCPU`, unit: `${freeSize.memoryGiB} GiB` },
                { id: 'storage', label: 'Saved storage', value: storage(FREE_PLAN.storageBytes), unit: 'GB', caption: 'for your saved files' },
            ],
        },
        {
            id: 'standard',
            name: 'Standard',
            price: dollars(standard.priceCents),
            interval: `/${standard.interval}`,
            billingNote,
            cta: { label: 'Get Standard', href: '/login?returnUrl=%2Fos%3Fsettings%3Dbilling%26upgrade%3Dstandard' },
            allowances: [
                { id: 'compute', label: 'Compute time', value: `${hours(standard.allowanceStdSeconds)}`, unit: 'standard-hours/period' },
                { id: 'computer', label: 'Computer', value: `${standardSize.vcpu} vCPU`, unit: `${standardSize.memoryGiB} GiB` },
                savedStorage,
            ],
        },
        {
            id: 'compute',
            name: 'Compute',
            price: dollars(compute.priceCents),
            interval: `/${compute.interval}`,
            billingNote,
            badge: 'Larger computers',
            note: `Optional overage at ${rate} per standard-hour, off by default, with a monthly cap you set (default ${defaultCap}, up to ${maxCap}).`,
            cta: { label: 'Get Compute', href: '/login?returnUrl=%2Fos%3Fsettings%3Dbilling%26upgrade%3Dcompute' },
            allowances: [
                { id: 'compute', label: 'Compute time', value: `${hours(compute.allowanceStdSeconds)}`, unit: 'standard-hours/period' },
                { id: 'computer', label: 'Computer', value: `${Math.min(...computeSizes.map(size => size.vcpu))}–${maxCpu} vCPU`, unit: `up to ${maxMemory} GiB` },
                savedStorage,
            ],
        },
    ];

    return {
        hero: {
            eyebrow: 'Your computer in the cloud',
            title: 'Open EZiL OS and get to work.',
            description: 'A full desktop with a browser and VS Code, in any tab. Start free — upgrade when you need more compute time or a larger computer.',
            caption: 'No card needed for Free.',
        },
        plansLabel: 'Plans',
        plans,
        sharedNote: 'Prices before tax. One computer runs at a time on each plan.',
        overage: {
            title: 'Usage beyond your allowance (Compute)',
            body: overageBody,
        },
        limits: {
            title: 'When you run out',
            rows: [
                { label: 'Compute time', value: 'Your work is saved and the computer pauses until your allowance renews, you upgrade, or — on Compute — you turn on overage.' },
                { label: 'Saved storage', value: 'New saves pause. Your files stay readable and downloadable.' },
            ],
        },
        faq: {
            title: 'Frequently asked questions',
            items: [
                {
                    question: 'What is a standard-hour?',
                    answer: `${standardSize.weight} standard-hour is ${standardSize.weight} hour at ${standardSize.vcpu} vCPU. ${computeSizes.filter(size => size.weight > standardSize.weight).map(size => `${size.vcpu} vCPU uses ${size.weight} per hour`).join('; ')}. So ${hours(compute.allowanceStdSeconds)} standard-hours is ${alternatives(computeSizes.map(size => `${hours(compute.allowanceStdSeconds) / size.weight} h at ${size.vcpu} vCPU`))}. Free time renews each calendar month in UTC; paid allowances renew each billing period.`,
                },
                {
                    question: 'Which computer sizes are there?',
                    answer: `Free has ${freeSize.vcpu} vCPU / ${freeSize.memoryGiB} GiB. Standard has ${standardSize.vcpu} vCPU / ${standardSize.memoryGiB} GiB. Compute has ${alternatives(computeSizes.map(size => size.vcpu))} vCPU with ${alternatives(computeSizes.map(size => size.memoryGiB))} GiB, respectively.`,
                },
                {
                    question: 'How long can a session run?',
                    answer: `Sessions run up to ${hours(SESSION_MAX_SECONDS)} hours, then your work is saved and the computer restarts. Idle computers sleep after ${IDLE_SLEEP_SECONDS / 60} minutes. Restarting does not reset your allowance.`,
                },
                {
                    question: 'What is kept when a computer restarts?',
                    answer: 'Files, the editor state on disk and installed tools are kept; running processes start fresh.',
                },
                {
                    question: 'What does saved storage mean?',
                    answer: 'Your saved project files across your computers, not the computer’s working disk.',
                },
                {
                    question: 'How does the overage cap work?',
                    answer: overageBody,
                },
                {
                    question: 'When am I billed?',
                    answer: 'Paid plans are billed monthly in advance via Stripe. Overage is billed in arrears on its own invoice after each billing period. Cancel or switch to Standard in Settings → Billing; the change takes effect at period end. Upgrades to Compute apply once the prorated payment succeeds.',
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
