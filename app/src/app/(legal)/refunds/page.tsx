import type { Metadata } from 'next';
import Link from 'next/link';

import { LegalDocument, OperatorContact, type LegalSection } from '../legal-document';

export const metadata: Metadata = {
    title: 'Refund Policy | EZiL OS',
    description: 'Refunds for monthly EZiL Pro charges and unused purchased AI credit when paid plans are offered, and how to contact EZiL LLC about a payment.',
    alternates: { canonical: 'https://os.ezil.org/refunds' },
};

const sections: readonly LegalSection[] = [
    {
        id: 'scope', title: 'When this policy applies',
        content: <>
            <p>When paid plans are offered, this policy covers purchases of EZiL Pro and AI credit for the hosted EZiL OS service from EZiL LLC. Review the <Link href="/pricing" prefetch={false}>pricing page</Link> and <Link href="/terms#plans-payments-credits" prefetch={false}>Plans, payments and credits</Link> terms before purchasing.</p>
        </>,
    },
    {
        id: 'pro-refunds', title: 'Monthly Pro charges',
        content: <>
            <p>When paid plans are offered, monthly EZiL Pro charges can be refunded on request within 14 days of a charge if that period’s allowances were not substantially used. This applies to an initial charge or a renewal. We assess the workspace time, saved storage, and included AI credit used during that period when reviewing a request.</p>
            <p>When paid plans are offered, you can cancel any time in Settings → Billing to prevent future renewals, and Pro continues to the end of the paid period. Cancellation alone does not request a refund; contact us using the details below if you want a charge reviewed.</p>
        </>,
    },
    {
        id: 'credit-refunds', title: 'Purchased AI credit',
        content: <>
            <p>When paid plans are offered, unused purchased AI credit is refundable on request within 14 days of purchase. Identify the purchase in your request so we can check its unused credit. Refunded credit is removed from the balance available to spend.</p>
        </>,
    },
    {
        id: 'requests', title: 'How to request a refund',
        content: <>
            <p>When paid plans are offered, email <a href="mailto:contact@ezil.work">contact@ezil.work</a> within the applicable 14-day window. Include your account email, the charge or purchase date, and a receipt or transaction reference if available. Explain which charge or unused credit you want refunded. Do not send full card numbers, passwords, or access tokens. We may need to verify the request and will explain the outcome by email.</p>
            <OperatorContact />
        </>,
    },
    {
        id: 'disputes', title: 'Payment questions and disputes',
        content: <>
            <p>When paid plans are offered, contact <a href="mailto:contact@ezil.work">contact@ezil.work</a> if you do not recognize a charge, believe it is incorrect, or disagree with a refund decision. We will review the relevant payment and usage records and explain our decision. You may also raise a dispute with your payment provider or use a court, regulator, or other remedy available under applicable law; contacting us first is not a condition of those rights.</p>
        </>,
    },
    {
        id: 'consumer-rights', title: 'Your statutory rights',
        content: <>
            <p>When paid plans are offered, this policy provides refund terms in addition to your statutory consumer rights. Those rights are not affected, including any mandatory cancellation right or remedy for a service that does not meet legal requirements. The 14-day windows and usage conditions above do not limit a right that applicable law gives you.</p>
        </>,
    },
];

export default function RefundsPage() {
    return <LegalDocument
        kind="refunds"
        title="Refund Policy"
        introduction="How to ask EZiL LLC about a refund or payment when paid plans are offered."
        summary={<>
            <p>When paid plans are offered, request a refund within 14 days of a monthly Pro charge if the period’s allowances were not substantially used, or within 14 days of purchasing unused AI credit. Your statutory consumer rights are not affected.</p>
            <p>What changed: added refund terms for the hosted Service that apply when paid plans are offered.</p>
        </>}
        sections={sections}
    />;
}
