import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { readBillingConfig } from '@/server/billing/config';
import MarketingHome from '../_components/home-page';
import { pricingMetadata } from './pricing-content';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = pricingMetadata;

export default function PricingPage() {
    const config = readBillingConfig();
    if (!config.pricingPageEnabled) notFound();

    return <MarketingHome largeStorageEnabled={config.largeStorageEnabled} focusPlans />;
}
