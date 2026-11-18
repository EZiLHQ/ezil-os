import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { feedbackSubmitSchema } from './types';
import { sanitizeDiagnostics } from './redact';
const SHELL = path.resolve(__dirname, '../../../../shell/ezil');
afterEach(() => vi.unstubAllGlobals());
function page() {
    vi.stubGlobal('window', { __EZIL_BOOT__: { desktopState: { ui: { feedbackReportBundle: true, feedbackEventDiagnostics: true } } },
        innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
    vi.stubGlobal('navigator', { userAgent: '', onLine: true });
    vi.stubGlobal('document', { body: { classList: { contains: () => false } }, querySelectorAll: () => [], visibilityState: 'visible', fullscreenElement: null });
}
describe('feedback reports the failed window trace rather than the last settings visit', () => {
    it('keeps Code phases and server failure reference through the actual builder, submit schema and sanitizer', async () => {
        page();
        const { beginTrace } = await import(`${SHELL}/trace.js`);
        const { capture } = await import(`${SHELL}/telemetry.js`);
        const { build_diagnostics } = await import(`${SHELL}/ui/feedback/diagnostics.js`);
        const code = beginTrace('code'); code.step('launch_start'); code.step('project_refused'); code.end('error');
        capture({ eventClass: 'api_failure', site: 'ezil-os:apps/code#project', code: 'repo_open_failed',
            reason: 'repo_open:worker_http_502:clone_failed', serverCorrelationId: '33333333-3333-4333-8333-333333333333' });
        const settings = beginTrace('settings'); settings.step('open_resolved'); settings.end('ok');
        const diagnostics = build_diagnostics({ traceId: code.id });
        const report = feedbackSubmitSchema.parse({ v: 1, clientRequestId: '44444444-4444-4444-8444-444444444444', category: 'bug',
            description: '', diagnostics });
        const stored = sanitizeDiagnostics(report.diagnostics);
        expect(stored).toMatchObject({ traceApp: 'code', traceId: code.id,
            tracePhases: [{ code: 'launch_start', tMs: expect.any(Number) }, { code: 'project_refused', tMs: expect.any(Number) }] });
        expect(stored!.recentEvents!.at(-1)).toMatchObject({ reason: 'repo_open:worker_http_502:clone_failed',
            correlationId: '33333333-3333-4333-8333-333333333333' });
        expect(build_diagnostics().traceApp).toBe('settings');
    });
    it('omits an unavailable explicit trace instead of claiming a different app is the failed one', async () => {
        page();
        const { beginTrace } = await import(`${SHELL}/trace.js`);
        const { build_diagnostics } = await import(`${SHELL}/ui/feedback/diagnostics.js`);
        const settings = beginTrace('settings'); settings.step('open_resolved');
        // A canonical v4 ID that was never registered: the lookup misses and nothing of Settings is borrowed.
        const unknown = build_diagnostics({ computerId: '11111111-1111-4111-8111-111111111111', appSession: 's',
            traceId: '99999999-9999-4999-8999-999999999999' });
        expect(unknown).not.toHaveProperty('traceId');
        expect(unknown).not.toHaveProperty('traceApp');
        expect(unknown.tracePhases).toEqual([]);
        expect(build_diagnostics().traceApp).toBe('settings');
        settings.end('ok');
    });
});
