import type { Metadata } from 'next';
import Link from 'next/link';

import { LegalDocument, OperatorContact, type LegalSection } from '../legal-document';

export const metadata: Metadata = {
    title: 'Privacy Policy | EZiL OS',
    description: 'How hosted EZiL OS handles account information, desktop files, cookies, diagnostics, service providers, and access or deletion requests.',
    alternates: { canonical: 'https://os.ezil.org/privacy' },
};

const sections: readonly LegalSection[] = [
    {
        id: 'operator', title: 'Who handles your information',
        content: <>
            <p>EZIL Private Limited operates the hosted EZiL OS service at os.ezil.org. This policy explains how we handle personal information when you visit the Service, create an account, use a hosted computer, or contact us. For account administration and operation of this Service, EZiL is responsible for deciding why and how that information is processed.</p>
            <OperatorContact />
            <p>This policy covers the hosted Service and its supporting infrastructure. It does not describe the independent practices of websites you visit, tools you connect, or people who run their own copy of the public EZiL OS software.</p>
        </>,
    },
    {
        id: 'account-data', title: 'Account information and its sources',
        content: <>
            <p>We receive information from you and the sign-in service you use. With Google sign-in, our authentication service receives an account identifier, email address, and profile information Google makes available, such as your name and profile image information. The account display uses your name, email, sign-in method, and account creation date.</p>
            <p>Supabase provides authentication and manages account records, linked sign-in identities, and session information. If you use email and password sign-in, your credentials are processed by the Service and Supabase to authenticate you. We do not receive your Google password when you use Google sign-in.</p>
            <p>EZiL OS uses the shared EZiL authentication system also used by related EZiL services. An existing EZiL identity may therefore be recognized when you sign in. Each service’s privacy notice covers the information it processes beyond those shared account and sign-in records.</p>
            <p>We also hold computer records linked to your account: computer identifiers, names, slot allocation, creation and last-opened times, deletion status, and associated metadata where used. Older invitation records may include an email address, who issued an invitation, dates, and an associated account identifier.</p>
            <p>When you contact us, we receive your contact details, message, and any attachments or diagnostic information you choose to send. Avoid including passwords, access tokens, or information unrelated to the request.</p>
        </>,
    },
    {
        id: 'desktop-data', title: 'Hosted desktops, files, and browser data',
        content: <>
            <p>A hosted computer runs on remote infrastructure. Files you upload or create, code you execute, documents you open, and information you enter into applications are processed there. This can include other people’s personal information or credentials you choose to place in your workspace.</p>
            <p>Workspace files are copied from persistent storage into a running computer and saved back as they change. Persistent storage contains file contents and paths, associated computer or workspace identifiers, and file metadata used for saving and restoring work. Some generated directories and temporary data are excluded from this process; persistence is not a full backup of the computer.</p>
            <p>Desktop streaming transmits the remote display and your keyboard, pointer, and other control input between your device and the hosted computer. Audio and clipboard data may also pass through when those functions are available and used. Connection services process network addressing and session information needed to establish and relay the connection. Streaming content is processed to deliver the session; our structured diagnostic records are not a recording of the desktop’s screen or keystrokes.</p>
            <p>The browser running inside your hosted computer is separate from the browser you use to visit os.ezil.org. It can hold browsing history, cookies, website sessions, downloads, and other website data in that remote environment. Hosted browser profiles use temporary storage by default and may be lost when a computer is replaced. A download saved into the persistent workspace can remain there. Do not assume closing a window clears a website session or that browser data will survive a restart.</p>
            <p>Websites, package services, extensions, and development servers receive requests and content as you use them. A site opened in the hosted browser generally receives the hosted computer’s network address; a site loaded directly on your device receives that device’s connection information. Preview links can expose the application and data served by your project to someone holding a valid link.</p>
        </>,
    },
    {
        id: 'device-storage', title: 'Cookies and storage on your device',
        content: <>
            <p>Authentication cookies maintain your sign-in session and support the sign-in flow. On HTTPS, the Service uses a host-scoped authentication cookie named <strong>__Host-ezil-os-auth</strong>, which may be split into multiple cookies, with related sign-in verification cookies. These are used for account access rather than advertising.</p>
            <p>The desktop also uses your browser’s local storage for preferences such as wallpaper, accent color, pinned apps, taskbar position, and a remembered preview port. These preferences can remain after signing out. They are separate from files stored in your hosted workspace.</p>
            <p>You can remove cookies and site storage through your browser settings. Removing authentication cookies signs you out; blocking them can prevent sign-in. Removing local storage resets saved preferences. Neither action deletes hosted files or account records.</p>
            <p>The Service does not use advertising cookies or a third-party advertising analytics integration. Websites and applications you open may use their own cookies, tracking, or storage under their own policies. Their storage may be inside the hosted browser rather than on your device, so manage it in the browser where you used that service.</p>
        </>,
    },
    {
        id: 'diagnostics', title: 'Diagnostics and operational information',
        content: <>
            <p>We process technical information to operate the Service and diagnose failures: boot and connection outcomes, error types, timestamps, durations, request or trace identifiers, and, where available, computer identifiers. We also process recent-activity timing and display settings needed to manage an active desktop and idle resources.</p>
            <p>Structured diagnostics use a pseudonym derived from an account identifier to count affected users. <strong>Pseudonymous does not mean anonymous:</strong> we can potentially link those records to an account using other information we hold.</p>
            <p>The diagnostic pipeline limits accepted fields and shortens and scrubs error descriptions for items such as tokens, email addresses, URLs, and file paths. It is designed to avoid collecting file contents, full browsing histories, or a trail of typed input. Scrubbing can miss information in unusual error text, and operational server logs are separate from these structured records. Those logs may include computer identifiers, file paths associated with a failure, and error details.</p>
            <p>Hosting, authentication, and connection providers necessarily process request and connection information, including IP addresses. Their operational logging can also include request metadata, browser information, timing, and errors, depending on the service and its configuration. Limits on our structured diagnostics do not mean that no technical information is processed elsewhere.</p>
            <p>The troubleshooting tools can prepare a diagnostic report for you to copy and share. Review it before sending it. There is no in-product diagnostic opt-out switch. Blocking the browser’s diagnostic requests can prevent that browser submission, but does not stop the server-side processing and logging needed to operate the Service.</p>
        </>,
    },
    {
        id: 'purposes', title: 'Why we use information',
        content: <>
            <ul>
                <li><strong>Provide the Service:</strong> authenticate you, associate computers with your account, save and restore workspace files, run applications, and deliver desktop connections.</li>
                <li><strong>Keep it working:</strong> allocate resources, manage idle sessions, troubleshoot errors, maintain security, and investigate misuse.</li>
                <li><strong>Respond to you:</strong> handle support, account, privacy, and security requests and communicate relevant service or policy changes.</li>
                <li><strong>Meet obligations:</strong> respond to valid legal requests, protect rights, and establish or defend legal claims.</li>
            </ul>
            <p>Where applicable law requires a legal basis, we rely on performance of our agreement for essential account and service functions, legitimate interests for proportionate reliability, security, and support activities, and legal obligations where processing is required by law. Where consent is required, we will ask for it and let you withdraw it. Withdrawal does not undo processing lawfully carried out beforehand.</p>
            <p>We do not use hosted workspace content to target advertising. You decide what you put in a workspace; you are responsible for having a lawful basis and any required permissions to use other people’s information there.</p>
        </>,
    },
    {
        id: 'providers', title: 'Infrastructure and service providers',
        content: <>
            <p>The hosted Service uses the following providers to perform its core functions:</p>
            <ul>
                <li><strong>Vercel:</strong> hosts the web application and its server routes, processing page and API requests and operational information.</li>
                <li><strong>Supabase:</strong> provides authentication and the database for account-linked computer records and structured diagnostics.</li>
                <li><strong>Cloudflare:</strong> provides hosted computer infrastructure, request routing, persistent workspace storage, and diagnostic storage. Cloudflare’s connection relay service is used when configured for desktop streaming.</li>
                <li><strong>Google:</strong> provides Google sign-in when you choose it and processes sign-in information under its own terms and privacy policy.</li>
            </ul>
            <p>Infrastructure providers process the information needed for the functions they deliver. Browser, editor, and streaming software also forms part of the Service; including open-source software does not by itself mean its authors receive your data. Separately, the services that software contacts can receive information when you use their features.</p>
        </>,
    },
    {
        id: 'integrations', title: 'External apps, clients, and AI tools',
        content: <>
            <p>When you visit a website, install an extension, use an external development service, or configure an AI provider, information flows to that service according to your actions and its functionality. This may include prompts, code, documents, website data, and outputs. Those providers determine their own retention and other uses under their policies.</p>
            <p>If you connect an external client to your EZiL account, the client receives the data returned for its authorized operations. For example, the optional MCP connector can return computer details and desktop, editor, or preview access links, and can manage computers with your account’s permissions. Your chosen client or AI provider may receive that information.</p>
            <p>Creating an EZiL OS account does not automatically connect it to an AI model provider. We make no general promise about an external provider’s model training, data retention, or confidentiality. Check the provider, selected account settings, and permissions before sending sensitive information. Revoking a connection does not recall data already sent to that provider.</p>
        </>,
    },
    {
        id: 'access-sharing', title: 'Administrative access and other disclosures',
        content: <>
            <p>Authorized operators and infrastructure providers can technically access information in the systems they administer. Account and workspace access controls help separate users, but the Service is not designed so that only you can decrypt hosted files. Administrative access may be needed for support, maintenance, security investigations, or legal obligations. The diagnostic review interface is restricted to designated administrators.</p>
            <p>We may disclose relevant information when required by law or a valid legal process, to protect people and the Service from harm or abuse, or to establish or defend legal rights. We may also disclose information at your direction, such as when you share work or authorize an integration.</p>
            <p>If operation of the Service transfers as part of a merger, acquisition, or sale, relevant information may transfer with it, subject to applicable law. We will notify you of a material change in who handles your information or how it is used.</p>
        </>,
    },
    {
        id: 'retention', title: 'How long information remains',
        content: <>
            <p>Account and computer records and persistent workspace files can remain while needed to operate the Service and after a computer is removed from the interface. There is no automatic general erasure deadline for those records or retained workspace files. Ask us for deletion if you want retained information assessed for removal.</p>
            <p>Structured diagnostic cleanup is configured to remove individual event records older than 14 days and hourly counts linked to a user pseudonym older than 90 days. Error-type summaries can remain longer; low-volume summaries not seen for a year are eligible for cleanup. These are cleanup thresholds, not a guarantee that every copy disappears at that exact age: completion depends on maintenance jobs running successfully, and queued diagnostic batches, infrastructure logs, and backups have separate handling.</p>
            <p>For support communications, operational records, and information subject to a deletion request, we consider the purpose of the information, whether it is still needed, security and abuse-prevention needs, and any legal preservation obligation. Where a backup or retained record cannot be removed immediately, or an exception applies, we will explain relevant limits when responding to your request. We do not promise a fixed deletion period for all systems.</p>
        </>,
    },
    {
        id: 'deletion-export', title: 'Deletion, account closure, and export',
        content: <>
            <p><strong>The “Delete computer” control is not a data-erasure control.</strong> It removes access to that computer and frees its slot, while retaining its files in persistent storage. There is no restore control for a deleted computer. Removing a file within a running desktop also does not necessarily erase an earlier persistent copy.</p>
            <p>Signing out, closing a desktop, uninstalling a local client, or clearing browser cookies does not close your hosted account or erase hosted data. There is currently no account-wide self-service export or account-deletion page.</p>
            <p>To request access, a copy or export, correction, account closure, or erasure, email <a href="mailto:contact@ezil.work">contact@ezil.work</a>. Explain what you need and provide the account email and relevant computer name or identifier if known. Use the account email where possible. We may ask for proportionate information to verify your identity or an agent’s authority; do not send a password or session token.</p>
            <p>We will assess the request under applicable law and explain the outcome, any available export format, and any limits or exceptions. Save important work before deleting a computer. Copies you sent to another person or an external service are subject to that recipient’s controls and may require a separate request to them.</p>
        </>,
    },
    {
        id: 'security-transfers', title: 'Security and international processing',
        content: <>
            <p>The hosted Service uses HTTPS, authenticated access, computer ownership checks, and controls on desktop access links. Diagnostic filtering reduces the information included in structured errors. These measures do not eliminate every security risk or make the Service end-to-end encrypted or inaccessible to administrators.</p>
            <p>Protect your sign-in method, secure devices you use, review connected tools, and avoid sharing access links. Report a suspected vulnerability or unauthorized access privately to <a href="mailto:security@ezil.work">security@ezil.work</a>.</p>
            <p>EZIL Private Limited operates from India. Our infrastructure providers may process information in India, the United States, and other countries where their systems or support operations run. The Service does not promise storage only in your country. Legal protections can differ between countries. Where applicable law requires safeguards for an international transfer, the transfer must meet those requirements. Contact us for information about the locations and safeguards relevant to your data.</p>
        </>,
    },
    {
        id: 'rights', title: 'Your privacy rights',
        content: <>
            <p>Depending on where you live and the law that applies, you may have rights to access or receive a copy of your personal information, correct it, request erasure, restrict or object to processing, request portability, or withdraw consent. Rights can be subject to identity checks and legal exceptions.</p>
            <p>For users in India, applicable data protection law may also provide rights to grievance redressal and to nominate another person to exercise certain rights in the event of death or incapacity. Send privacy requests and grievances to <a href="mailto:contact@ezil.work">contact@ezil.work</a>; identify the right you wish to exercise so we can respond under the law in effect.</p>
            <p>You can make a request at <a href="mailto:contact@ezil.work">contact@ezil.work</a>, including through an authorized representative where the law permits. We will respond within applicable legal time limits. If we cannot fulfill a request, we will explain why and any review or appeal route available to you. You may also complain to the privacy regulator or other competent authority where you live or work, as applicable. You do not have to contact us before exercising that right.</p>
            <p>We will not penalize you for exercising a privacy right. Some information is necessary to provide an authenticated hosted computer; removing it may mean that we can no longer provide that function or maintain the account.</p>
        </>,
    },
    {
        id: 'local-software', title: 'Local software and independent hosting',
        content: <>
            <p>The <a href="https://github.com/EZiLHQ/ezil-os">public EZiL OS project</a> also includes local software and can be hosted independently. Running that software locally does not by itself create a hosted account or upload a workspace to us. Local guest startup does not require EZiL authentication, and automatic synchronization of local workspaces to this hosted Service is not enabled.</p>
            <p>In the native Mac application, managed workspace files, browser profiles, editor data, and desktop preferences are stored on the Mac. Local commands and extensions run with the Mac user’s permissions. Local websites, package downloads, and tools you configure can still communicate with external services. Removing the application alone does not necessarily erase its local data.</p>
            <p>If you use someone else’s EZiL OS deployment, consult that operator’s privacy notice. If you connect local software to our hosted Service, this policy applies to information processed by our Service through that connection.</p>
        </>,
    },
    {
        id: 'children', title: 'Children',
        content: <>
            <p>The hosted Service is intended for adults aged 18 and over, as set out in the <Link href="/terms#eligibility" prefetch={false}>Terms and Conditions</Link>. It is not directed to children. If you believe a child has supplied personal information to us, contact <a href="mailto:contact@ezil.work">contact@ezil.work</a> so we can investigate and take appropriate action, including deletion where required.</p>
        </>,
    },
    {
        id: 'changes-contact', title: 'Policy changes and contacting us',
        content: <>
            <p>We will update this policy when our practices or legal requirements change and show the effective date on this page. We will give notice of material changes through the Service or an available account contact method, and obtain consent before a new use where the law requires it. A new policy does not remove rights that apply to information we already hold.</p>
            <p>For privacy questions or requests, contact <a href="mailto:contact@ezil.work">contact@ezil.work</a> or write to EZIL Private Limited at BHIVE Workspace, Brigade Metropolis, Bengaluru, Karnataka 560048, India. For security reports, use <a href="mailto:security@ezil.work">security@ezil.work</a>.</p>
        </>,
    },
];

export default function PrivacyPage() {
    return <LegalDocument
        kind="privacy"
        title="Privacy Policy"
        introduction="What the hosted Service processes, where your work lives, and how to ask for access or deletion."
        summary={<p>A hosted desktop processes your work on remote infrastructure. Account records, workspace files, and diagnostics have different storage and deletion behavior. Deleting a computer does not erase its stored files; contact us for an erasure or export request.</p>}
        sections={sections}
    />;
}
