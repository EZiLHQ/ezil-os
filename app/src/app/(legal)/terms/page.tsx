import type { Metadata } from 'next';
import Link from 'next/link';

import { LegalDocument, OperatorContact, type LegalSection } from '../legal-document';

export const metadata: Metadata = {
    title: 'Terms and Conditions | EZiL OS',
    description: 'Terms for the hosted EZiL OS service at os.ezil.org: accounts, acceptable use, your content, service limits, and your rights.',
    alternates: { canonical: 'https://os.ezil.org/terms' },
};

const sections: readonly LegalSection[] = [
    {
        id: 'scope', title: 'Who we are and what these terms cover',
        content: <>
            <p>These Terms and Conditions are an agreement between you and EZIL Private Limited (“EZiL,” “we,” “us”). They govern your use of the hosted EZiL OS service at os.ezil.org and the hosted desktop, editor, preview, and computer-management services it provides (the “Service”). By creating an account or using the Service, you agree to these terms.</p>
            <p>Our <Link href="/privacy" prefetch={false}>Privacy Policy</Link> explains how we handle personal information. These terms concern this hosted Service. They do not replace the open-source licenses for the EZiL OS repository or impose a service agreement on people simply downloading, modifying, or running that software independently.</p>
            <p>If you access an independently hosted version, its operator is responsible for that service and its terms. Local applications and third-party websites have their own operating conditions; using them does not by itself mean that your files are stored with us.</p>
        </>,
    },
    {
        id: 'eligibility', title: 'Eligibility and authority',
        content: <>
            <p>The Service is intended for adults. You must be at least 18 and have the legal capacity to enter this agreement. You must also be permitted to use the Service under the laws that apply to you.</p>
            <p>If you use the Service for an organization, you must have authority to act for it and to provide the information and content you use. You remain responsible for following your organization’s policies and obtaining any necessary permission from clients, colleagues, or other people whose information you handle.</p>
        </>,
    },
    {
        id: 'accounts', title: 'Your account and access',
        content: <>
            <p>Use accurate account information and keep your sign-in methods secure. Google sign-in can create a new hosted account. Email and password sign-in is also available for existing accounts that support it. Access to Google and other identity services remains subject to their requirements.</p>
            <p>You are responsible for activity you authorize through your account and for protecting passwords, session tokens, and desktop or preview access links. Share access only with people and applications you trust and only when the Service supports that use. A signed access link may let its holder reach the associated resource until it expires.</p>
            <p>Tell us promptly at <a href="mailto:security@ezil.work">security@ezil.work</a> if you suspect unauthorized access or a security issue. Do not send passwords or access tokens in your report. Signing out ends the session in that browser; it does not delete your account, computers, or files, or necessarily sign you out on other devices or inside third-party websites.</p>
        </>,
    },
    {
        id: 'acceptable-use', title: 'Permitted and prohibited use',
        content: <>
            <p>You may use the Service for lawful browsing, development, and other work within its available capabilities and resource limits. You must have the rights and permissions needed for your activities.</p>
            <p>You must not:</p>
            <ul>
                <li>Break applicable law, infringe intellectual property or privacy rights, or upload or distribute unlawful content.</li>
                <li>Use the Service for fraud, phishing, spam, harassment, exploitation, or distributing malicious software to harm others.</li>
                <li>Access someone else’s account, files, systems, or networks without permission, or attempt to escape a hosted computer’s isolation or bypass access controls.</li>
                <li>Disrupt the Service or other users, conduct unauthorized security testing, evade limits through multiple accounts, or use excessive automated traffic, cryptocurrency mining, or similar workloads that impair shared capacity.</li>
                <li>Misrepresent your identity or authority, or use the Service in breach of applicable export controls or sanctions.</li>
            </ul>
            <p>Security research must stay within authorization for the systems being tested. Contact <a href="mailto:security@ezil.work">security@ezil.work</a> to report a vulnerability or discuss testing that could affect the hosted Service.</p>
        </>,
    },
    {
        id: 'content', title: 'Your content and our permissions',
        content: <>
            <p>You retain your rights in the files, code, documents, and other materials you put into the Service (“your content”). Using EZiL OS does not transfer ownership of your content to us or automatically license it under the repository’s open-source license.</p>
            <p>You give us permission to host, store, copy, transmit, display, and otherwise process your content as necessary to provide the functions you use, maintain and secure the Service, and handle your support requests. This includes passing data to infrastructure providers involved in running your hosted computer. This permission is limited to those purposes, subject to the retention and deletion practices described in the Privacy Policy.</p>
            <p>You are responsible for the content you provide and for securing permission to process personal or confidential information belonging to others. Only place information in the Service if its protections and operating conditions meet your needs. Keep separate copies of important work.</p>
            <p>We may restrict access to content when necessary to address a violation, a credible rights complaint, a security threat, or a legal obligation. We will consider the circumstances and give notice when reasonably possible and legally permitted.</p>
        </>,
    },
    {
        id: 'open-source', title: 'Open-source software',
        content: <>
            <p>The public <a href="https://github.com/EZiLHQ/ezil-os">EZiL OS repository</a> is licensed under the GNU Affero General Public License version 3.0 (AGPL-3.0). Components supplied by other projects may have separate licenses and notices. The applicable license governs your rights to use, study, modify, and redistribute that software.</p>
            <p>These hosted-service terms do not take away rights granted by those licenses. Running a modified version for others may create source-availability obligations under the AGPL; consult the <a href="https://github.com/EZiLHQ/ezil-os/blob/main/LICENSE">license text</a>. Independent operators are responsible for their hosting, security, data handling, and compliance. A license to the code does not guarantee access to our hosted infrastructure or support.</p>
        </>,
    },
    {
        id: 'third-parties', title: 'Third-party services and optional AI',
        content: <>
            <p>Your hosted computer can connect to websites, identity providers, package registries, editor extensions, and other external services. Those services may require their own accounts, permissions, terms, and charges. You are responsible for deciding which to use and what information to send them.</p>
            <p>If you configure an AI tool or connect an external client, including an MCP client, it may receive the information you submit, tool responses, computer details, and access links, and may take actions with the permissions you give it. Review those permissions and the provider’s data-use and retention terms before connecting it. EZiL does not promise that an external AI provider will refrain from retaining data or using it for training.</p>
            <p>Check AI output and automated actions before relying on them. They can be incomplete or wrong and may change or delete work. Third-party products are controlled by their providers, and their availability or compatibility can change.</p>
        </>,
    },
    {
        id: 'limits', title: 'Service status and resource limits',
        content: <>
            <p>The hosted Service is an alpha product. Features can fail, sessions can be interrupted, and a hosted computer may stop or be replaced. Availability, performance, compatibility, and preservation of work are not guaranteed, subject to rights that cannot lawfully be excluded.</p>
            <p>The Service currently allows up to two active computers per account. Compute, memory, storage, network access, session duration, and idle operation are constrained by available capacity and operating limits. We may enforce or adjust limits to keep the Service reliable and prevent abuse, and will give reasonable notice of material changes when practicable.</p>
            <p>Workspace persistence helps carry files between sessions, but it is not a complete backup of a computer. Temporary files, browser profiles, running processes, and some generated data may not survive a restart or replacement. Save and independently back up work you cannot afford to lose. Do not rely on the Service for emergency or safety-critical operations.</p>
        </>,
    },
    {
        id: 'ending-access', title: 'Suspension and ending access',
        content: <>
            <p>You can stop using the Service at any time. To request account closure and deletion of associated personal information, email <a href="mailto:contact@ezil.work">contact@ezil.work</a>. We may need to verify that the request is yours.</p>
            <p>We may limit, suspend, or end access where reasonably necessary because of a material violation of these terms, unlawful activity, a security risk, harm to others, or a legal requirement. We may also discontinue all or part of the Service. Where practicable, we will explain the reason, give notice, and allow time to save your work or address the problem. Immediate action may be needed where delay would create risk or notice is prohibited by law.</p>
            <p>You can contact us to ask for a review of an access decision. Ending access does not automatically erase all associated information. We handle retained information and deletion requests as described in the <Link href="/privacy#retention" prefetch={false}>Privacy Policy</Link>.</p>
        </>,
    },
    {
        id: 'deletion', title: 'Deleting a computer and saving your data',
        content: <>
            <p><strong>“Delete computer” does not erase its stored files.</strong> It removes the computer from your accessible list and frees its slot. The Service attempts to shut down its running desktop, but stored workspace files remain. The interface cannot reopen or restore that deleted computer, and a new computer does not regain its files.</p>
            <p>Deleting a file inside the desktop also does not necessarily remove a copy already saved in persistent storage. Signing out or clearing your browser’s storage does not erase hosted data.</p>
            <p>Save copies you need before deleting a computer or ending access. There is no account-wide self-service data export or account-erasure control. For an export, access, or erasure request, email <a href="mailto:contact@ezil.work">contact@ezil.work</a> and identify the relevant account and computer if known. We will assess the request, explain available options and any applicable limits, and meet obligations imposed by applicable law.</p>
        </>,
    },
    {
        id: 'warranties', title: 'Warranties and your mandatory rights',
        content: <>
            <p>To the extent permitted by law, the Service is provided “as is” and “as available,” without implied warranties of merchantability, fitness for a particular purpose, or non-infringement. We do not warrant that it will be uninterrupted, error-free, or suitable for every intended use.</p>
            <p>Nothing in these terms excludes a statutory guarantee, right to a remedy, duty of care, or other protection that cannot lawfully be excluded. If you are a consumer, the mandatory consumer protections that apply to you continue to apply.</p>
        </>,
    },
    {
        id: 'liability', title: 'Responsibility and liability',
        content: <>
            <p>To the extent permitted by applicable law, EZiL is not liable for indirect or consequential losses arising from use of, or inability to use, the Service, including indirect loss of profits, business opportunities, or data. The nature of a loss and the law that applies determine whether this limitation is valid.</p>
            <p>Nothing limits liability for fraud, deliberate misconduct, gross negligence where it cannot be limited, death or personal injury caused by negligence where applicable, or any other liability that the law does not allow us to exclude or limit. Your mandatory remedies remain available.</p>
        </>,
    },
    {
        id: 'changes', title: 'Changes to the terms',
        content: <>
            <p>We may update these terms to reflect changes to the Service, legal requirements, or operating needs. We will publish the revised terms with a new effective date. For material changes, we will provide notice through the Service or an available account contact method before they take effect, where practicable. Changes urgently required for legal or security reasons may take effect sooner.</p>
            <p>If a change requires your agreement under applicable law, we will obtain it. Otherwise, continued use after the notified effective date signifies acceptance of the updated terms to the extent permitted by law. If you do not agree, stop using the Service and contact us about closing your account and obtaining your data. Changes do not remove rights that have already accrued.</p>
        </>,
    },
    {
        id: 'contact', title: 'Contact and resolving disputes',
        content: <>
            <p>For questions, complaints, rights concerns, or an account decision you would like reviewed, contact us with enough detail to understand the issue:</p>
            <OperatorContact />
            <p>Please contact us so we can try to resolve a concern. You retain the right to use a court, regulator, or other remedy available under applicable law, without first completing an internal complaint process. Applicable law determines governing law and the courts with jurisdiction, including mandatory protections where you live.</p>
            <p>If part of these terms is unenforceable, the remaining provisions continue to apply to the extent lawful. A failure to enforce a provision on one occasion does not waive the right to enforce it later.</p>
        </>,
    },
];

export default function TermsPage() {
    return <LegalDocument
        kind="terms"
        title="Terms and Conditions"
        introduction="The terms for your account, your work, and your use of the hosted EZiL OS desktop."
        summary={<p>Your content stays yours. Use the Service lawfully, protect your account, and keep your own copies of important work. The hosted desktop is an alpha service with limits, and deleting a computer does not erase its stored files.</p>}
        sections={sections}
    />;
}
