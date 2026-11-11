import { describe, expect, it, vi } from 'vitest';
import { feedbackNotificationMailer } from './notification-mail';
const notice = { reportId: '550e8400-e29b-41d4-a716-446655440002', category: 'bug', createdAt: '2026-11-11T20:00:00.000Z' };
describe('feedback notification mail', () => {
    it('never sends without a configured server credential', () => {
        const fetcher = vi.fn();
        expect(feedbackNotificationMailer(undefined, fetcher)).toBeNull();
        expect(feedbackNotificationMailer('  ', fetcher)).toBeNull();
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('sends fixed recipient, metadata and admin link, with no submitted content', async () => {
        const fetcher = vi.fn(async () => Response.json({ data: { succeeded: 1, failed: 0, email_id: 'accepted-123' } }));
        const send = feedbackNotificationMailer('server-credential', fetcher)!;
        expect(await send(notice)).toEqual({ accepted: true, messageId: 'accepted-123' });
        const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://api.smtp2go.com/v3/email/send');
        expect(init.headers).toMatchObject({ 'X-Smtp2go-Api-Key': 'server-credential' });
        const body = JSON.parse(init.body as string);
        expect(body.to).toEqual(['contact@ezil.work']);
        expect(body.sender).toBe('invites@projects.ezil.work');
        expect(body.text_body).toContain('https://os.ezil.work/admin/feedback');
        expect(body.text_body).toContain(notice.reportId);
        expect(Object.keys(body).sort()).toEqual(['custom_headers', 'sender', 'subject', 'text_body', 'to']);
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.redirect).toBe('error');
    });
    it.each([
        () => Response.json({ data: { succeeded: 0, failed: 1, email_id: 'no' } }),
        () => Response.json({ data: { succeeded: 1, failed: 0 } }),
        () => Response.json({ data: { succeeded: 1, failed: 0, email_id: ' ' } }),
        () => Response.json({ data: { error: 'secret-provider-message' } }, { status: 429 }),
        () => new Response('not-json'),
        () => { throw new Error('secret-network-message'); },
    ])('keeps nonacceptance retryable without exposing provider errors', async response => {
        const send = feedbackNotificationMailer('server-credential', vi.fn(async () => response()))!;
        expect(await send(notice)).toEqual({ accepted: false });
    });
    it('does not allow untrusted metadata to add recipient or headers', async () => {
        const fetcher = vi.fn();
        const send = feedbackNotificationMailer('server-credential', fetcher)!;
        expect(await send({ ...notice, reportId: 'x\r\nBcc: attacker@example.com' })).toEqual({ accepted: false });
        expect(fetcher).not.toHaveBeenCalled();
    });
});
