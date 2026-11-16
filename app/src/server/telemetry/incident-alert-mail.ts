/** Server-only incident alert mail over SMTP2GO, reusing the verified sender and internal recipient. Metadata only: a KNOWN server-owned code/site label (`incident-labels.ts`, else `(other)`), counts, a window and the admin link. Never a
 * description, URL, token, user or computer id. At least once; the stable Message-ID helps spot a duplicate.
 */
import { EVENT_CLASSES } from './types';
import { KNOWN_CODES, KNOWN_SITES, knownLabel } from './incident-labels';
export const INCIDENT_ALERT_TO = 'contact@ezil.work';
export const INCIDENT_ALERT_FROM = 'invites@projects.ezil.work';
export const INCIDENT_MAIL_TIMEOUT_MS = 5_000;
export type MailOutcome = { accepted: true; messageId: string } | { accepted: false };

export const INCIDENT_ALERT_URL = 'https://os-staging.ezil.work/admin/telemetry';
export interface IncidentNotice { fingerprint: string; eventClass: string; site: string; code: string; distinctUsers: number; events: number; windowStart: string; windowEnd: string; createdAt: string }
export type IncidentMailer = (notice: IncidentNotice) => Promise<MailOutcome>;

const classLabel = (value: string): string => (EVENT_CLASSES as readonly string[]).includes(value) || value === 'collection' ? value : '(other)';

export function incidentAlertMailer(apiKey: string | undefined, fetcher: typeof fetch = fetch): IncidentMailer | null {
    const key = apiKey?.trim();
    if (!key) return null;
    return async notice => {
        const times = [notice.windowStart, notice.windowEnd, notice.createdAt];
        if (!/^(fp_[0-9a-f]{16}|collection_silent)$/.test(notice.fingerprint) || times.some(t => !Number.isFinite(Date.parse(t)))
            || ![notice.distinctUsers, notice.events].every(n => Number.isSafeInteger(n) && n >= 0)) return { accepted: false };
        const code = knownLabel(notice.code, KNOWN_CODES), site = knownLabel(notice.site, KNOWN_SITES), eventClass = classLabel(notice.eventClass);
        const silent = notice.fingerprint === 'collection_silent';
        try {
            const response = await fetcher('https://api.smtp2go.com/v3/email/send', {
                method: 'POST', redirect: 'error',
                headers: { 'X-Smtp2go-Api-Key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({
                    sender: INCIDENT_ALERT_FROM, to: [INCIDENT_ALERT_TO],
                    subject: silent ? '[staging] EZiL OS telemetry collection is silent' : `[staging] EZiL OS incident: ${code} at ${site} (${notice.distinctUsers} users)`,
                    text_body: silent
                        ? `No telemetry events have been received since ${notice.windowEnd}.\n\nReview telemetry: ${INCIDENT_ALERT_URL}`
                        : `Users are hitting a terminal or repeated failure in EZiL OS.\n\nClass: ${eventClass}\nSite: ${site}\nCode: ${code}\nDistinct users: ${notice.distinctUsers}\nEvents: ${notice.events}\nWindow: ${notice.windowStart} to ${notice.windowEnd}\nFingerprint: ${notice.fingerprint}\n\nReview telemetry: ${INCIDENT_ALERT_URL}`,
                    custom_headers: [{ header: 'Message-ID', value: `<incident-${notice.fingerprint}-${Date.parse(notice.createdAt)}@projects.ezil.work>` }],
                }),
                signal: AbortSignal.timeout(INCIDENT_MAIL_TIMEOUT_MS),
            });
            if (!response.ok) return { accepted: false };
            const data = ((await response.json()) as { data?: { succeeded?: unknown; failed?: unknown; email_id?: unknown } } | null)?.data;
            return data?.succeeded === 1 && data.failed === 0 && typeof data.email_id === 'string' && data.email_id.trim()
                ? { accepted: true, messageId: data.email_id.trim() } : { accepted: false };
        } catch { return { accepted: false }; } // Never log provider bodies, API keys or event data.
    };
}
