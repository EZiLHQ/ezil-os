import type { Metadata } from 'next';
import Link from 'next/link';

import { LegalDocument, OperatorContact, type LegalSection } from '../legal-document';

export const metadata: Metadata = {
    title: 'Refund Policy | EZiL OS',
    description: 'Refunds for monthly Standard and Premium charges within 14 days when less than 10% of monthly fair use is used, and how to contact EZiL LLC about a payment.',
    alternates: { canonical: 'https://os.ezil.work/refunds' },
};

const sections: readonly LegalSection[] = [
    {
        id: 'scope', title: 'When this policy applies',
        content: <>
            <p>EZiL LLC offers Free ($0), Standard ($20/month), and Premium ($100/month) for the hosted EZiL OS service. Prices are in USD, before tax; tax is added where it applies. This policy covers monthly Standard and Premium charges. AI is not included in any plan.</p>
            <p>Review the <Link href="/pricing" prefetch={false}>pricing page</Link> and <Link href="/terms#plans-payments" prefetch={false}>Plans and payments</Link> terms before purchasing.</p>
        </>,
    },
    {
        id: 'plan-refunds', title: 'Monthly Standard and Premium charges',
        content: <>
            <p>Monthly Standard and Premium charges can be refunded on request within 14 days of a charge if that period’s fair use was not substantially used. This applies to an initial charge or a renewal.</p>
            <p>“Not substantially used” means using less than 10% of the plan’s monthly fair use during that paid period, measured in standard-hours: under 4 standard-hours for Standard (about 40 standard-hours/month) or under 50 standard-hours for Premium (about 500 standard-hours/month). Usage at or above 10% does not meet this condition.</p>
            <p>One standard-hour is one hour on a 2 vCPU computer. Premium’s 4 vCPU computer uses 2 standard-hours per hour and its 8 vCPU computer uses 4 standard-hours per hour. We assess this weighted compute usage when reviewing a request.</p>
            <p>You can cancel any time in Settings → Billing to prevent future renewals. Downgrades and cancellations take effect at the end of the paid period. Cancellation alone does not request a refund; contact us using the details below if you want a charge reviewed. See <Link href="/terms#plan-changes-files" prefetch={false}>what happens to your files on plan changes</Link>.</p>
        </>,
    },
    {
        id: 'requests', title: 'How to request a refund',
        content: <>
            <p>Email <a href="mailto:contact@ezil.work">contact@ezil.work</a> within the 14-day window. Include your account email, the charge date, and a receipt or transaction reference if available. Explain which charge you want refunded. Do not send full card numbers, passwords, or access tokens. We may need to verify the request and will explain the outcome by email.</p>
            <OperatorContact />
        </>,
    },
    {
        id: 'disputes', title: 'Payment questions and disputes',
        content: <>
            <p>Contact <a href="mailto:contact@ezil.work">contact@ezil.work</a> if you do not recognize a charge, believe it is incorrect, or disagree with a refund decision. We will review the relevant payment and usage records and explain our decision. You may also raise a dispute with your payment provider or use a court, regulator, or other remedy available under applicable law; contacting us first is not a condition of those rights.</p>
        </>,
    },
    {
        id: 'consumer-rights', title: 'Your statutory rights',
        content: <>
            <p>This policy provides refund terms in addition to your statutory consumer rights. Those rights are not affected, including any mandatory cancellation right or remedy for a service that does not meet legal requirements. The 14-day window and usage conditions above do not limit a right that applicable law gives you.</p>
        </>,
    },
];

export default function RefundsPage() {
    return <LegalDocument
        kind="refunds"
        title="Refund Policy"
        introduction="How to ask EZiL LLC about a Standard or Premium refund or payment."
        changeSummary="Applied the 14-day refund window to Standard and Premium with a threshold below 10% of monthly fair use."
        summary={<>
            <p>Request a refund within 14 days of a monthly Standard or Premium charge if less than 10% of the plan’s monthly fair use was used during that paid period. Your statutory consumer rights are not affected.</p>
        </>}
        sections={sections}
    />;
}
