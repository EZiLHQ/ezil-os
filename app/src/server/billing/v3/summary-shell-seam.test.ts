/**
 * Seam harness, lane A → lane U (REVERSE-MOVE-CONTRACT §3.4, §6.1, §6.2; r7 integration). The app's REAL summary
 * builder (`buildSummaryV3` with the move computer's input as `billing.summary` passes it) feeds the shell's REAL
 * Computer tab (`computerModel` + `computerHtml`, shell/ezil/ui/Settings/tabs/computers.js) through a JSON round trip,
 * which is what the wire keeps of the DTO. Without 0012 the summary has NO `reverseMove`/`moveOnOpen`/`moveAvailable`
 * keys at all (§6.1.1's "omitted", lane A's `billing.ts`); the tab must read absent keys exactly as `null`/`false`
 * (lane A's builder with `tablePresent: false`): no move card, no offer, the files-held banner only.
 * Only the tab's DOM-bound imports (alert, registry, billing tab, feedback dialog) are stubbed.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn() }));
vi.mock('@/server/auth/auth0', () => ({ auth0Enabled: () => false }));
vi.mock('../../../../../shell/src/UI/UIAlert.js', () => ({ default: async () => 'confirm' }));
vi.mock('../../../../../shell/ezil/apps/registry.js', () => ({ default: { launch: async () => undefined } }));
vi.mock('../../../../../shell/ezil/ui/Settings/tabs/billing.js', () => ({ default: { available: () => true } }));
vi.mock('../../../../../shell/ezil/ui/feedback/feedback.js', () => ({ feedback_enabled: () => true, open_feedback_dialog: () => undefined }));

import { readBillingConfig } from '../config';
import { buildSummaryV3, type ReverseMoveSummaryInput } from './summary';

const C = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-10-30T12:00:00Z');
type Input = Parameters<typeof buildSummaryV3>[0];
const base = (): Input => ({ config: readBillingConfig({ CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'sk_test_fixture' }), now, userCreatedAt: null,
    subs: [], epochs: [], grants: [], consent: null, planChanges: [], paymentIssues: [], storage: [], sizePreference: null, hasCustomer: false,
    placementProvider: 'aws-ec2', awsSize: 'std-2' });
const rm = (over: Partial<ReverseMoveSummaryInput> = {}): ReverseMoveSummaryInput => ({ tablePresent: true, row: null,
    placement: { provider: 'aws-ec2', state: 'STOPPED', leaseEpoch: 12, lifecycleJobId: null, instanceType: 'm6i.large' },
    awsEnabled: true, killSwitchOn: false, founderOwned: false, ...over });
/** What the shell receives: the DTO through JSON (undefined keys vanish, as on the wire). */
const wire = (input: Partial<Input>) => JSON.parse(JSON.stringify(buildSummaryV3({ ...base(), ...input }))) as Record<string, unknown> & {
    computer: Record<string, unknown> };
const me = { id: C, name: 'My computer', slot: 1, createdAt: '2026-10-01T00:00:00Z', lastOpenedAt: null };
const stopped = { version: 2, computerId: C, operation: 'none', lifecycleState: 'STOPPED', needsOperator: false, transition: null, milestones: [],
    hardware: { instanceType: 'm6i.large', source: 'placement' } };
const MOVE_ROLES = /data-role="move-(offer|progress|done|failed|attention|refused)"/;

describe('seam A → U: the summary\'s move keys, absent or null/false, in the shell\'s Computer tab (§6.1, §6.2)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the shell module is plain JS
    let tab: any;
    beforeAll(async () => {
        (globalThis as { html_encode?: (v: unknown) => string }).html_encode = value => String(value ?? '')
            .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
        tab = await import('../../../../../shell/ezil/ui/Settings/tabs/computers.js');
    });
    const render = (data: Record<string, unknown>) => {
        const model = tab.computerModel({ computer: me, data, prog: stopped });
        return { model, html: tab.computerHtml(model, stopped, []) as string };
    };

    it('no 0012: the summary carries no move key at all, and the tab shows the files-held banner with no move card or offer', () => {
        const absent = wire({});
        expect(absent.computer).not.toHaveProperty('reverseMove');
        expect(absent.computer).not.toHaveProperty('moveOnOpen');
        expect(absent.computer).not.toHaveProperty('moveAvailable');
        expect(absent.computer.standing).toBe('files_on_aws');
        const { model, html } = render(absent);
        expect(html).not.toMatch(MOVE_ROLES);
        expect(model.moveOnOpen).toBe(false);
        expect(html).toContain('Your files are still on your AWS (India) computer.');
    });

    it('absent keys render exactly as the builder\'s null/false (tablePresent false)', () => {
        const nulls = wire({ reverseMove: rm({ tablePresent: false }) });
        expect(nulls.computer).toMatchObject({ reverseMove: null, moveOnOpen: false, moveAvailable: false });
        expect(render(wire({})).html).toBe(render(nulls).html);
    });

    it('control: a held computer the move can reach gets the pre-move offer from the same path', () => {
        const live = wire({ reverseMove: rm() });
        expect(live.computer).toMatchObject({ reverseMove: null, moveAvailable: true, moveOnOpen: true });
        const { html } = render(live);
        expect(html).toMatch(/data-role="move-offer"/);
        expect(html).not.toBe(render(wire({})).html);
    });
});
