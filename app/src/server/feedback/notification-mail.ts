/** Server-only SMTP2GO transport, reusing the verified EZiL Works sending domain.
 * Acceptance is not mailbox delivery. Ambiguous attempts are retried by the
 * durable outbox, so delivery is at least once; the stable Message-ID helps
 * identify duplicates but is not a provider idempotency guarantee.
 */
import { FEEDBACK_CATEGORIES } from './types';

export const FEEDBACK_NOTIFICATION_TO = 'contact@ezil.work';
export const FEEDBACK_NOTIFICATION_FROM = 'invites@projects.ezil.work';
export const FEEDBACK_NOTIFICATION_URL = 'https://os.ezil.work/admin/feedback';
export const FEEDBACK_MAIL_TIMEOUT_MS = 5_000;
export interface FeedbackNotice { reportId: string; category: string; createdAt: string }
export type MailOutcome = { accepted: true; messageId: string } | { accepted: false };
export type FeedbackMailer = (notice: FeedbackNotice) => Promise<MailOutcome>;

export function feedbackNotificationMailer(apiKey: string | undefined, fetcher: typeof fetch = fetch): FeedbackMailer | null {
    const key = apiKey?.trim();
    if (!key) return null;
    return async notice => {
        if (!/^[0-9a-f-]{36}$/i.test(notice.reportId) || !Number.isFinite(Date.parse(notice.createdAt))) return { accepted: false };
        const category = FEEDBACK_CATEGORIES.find(c => c === notice.category) ?? 'other';
        try {
            const response = await fetcher('https://api.smtp2go.com/v3/email/send', {
                method: 'POST', redirect: 'error',
                headers: { 'X-Smtp2go-Api-Key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({
                    sender: FEEDBACK_NOTIFICATION_FROM, to: [FEEDBACK_NOTIFICATION_TO],
                    subject: `New EZiL OS feedback: ${category} (${notice.reportId.slice(0, 8)})`,
                    text_body: `New feedback was submitted in EZiL OS.\n\nCategory: ${category}\nReport: ${notice.reportId}\nSubmitted: ${notice.createdAt}\n\nReview feedback: ${FEEDBACK_NOTIFICATION_URL}?id=${notice.reportId}\n\nSign in with your authorized admin account to view the report and screenshots.`,
                    custom_headers: [{ header: 'Message-ID', value: `<feedback-${notice.reportId}@projects.ezil.work>` }],
                }),
                signal: AbortSignal.timeout(FEEDBACK_MAIL_TIMEOUT_MS),
            });
            if (!response.ok) return { accepted: false };
            const body: unknown = await response.json();
            const data = (body as { data?: { succeeded?: unknown; failed?: unknown; email_id?: unknown } } | null)?.data;
            return data?.succeeded === 1 && data.failed === 0 && typeof data.email_id === 'string' && data.email_id.trim()
                ? { accepted: true, messageId: data.email_id.trim() } : { accepted: false };
        } catch { return { accepted: false }; } // Never log provider bodies, API keys or submitted data.
    };
}
