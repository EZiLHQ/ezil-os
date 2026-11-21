/**
 * `account.mcpSetSetting`: the EZiL MCP `set_setting` write (docs/STAGING-COMPUTER-TOOLS-MCP.md section 6).
 * It renames an owned computer, changes its size only within the account's allowed sizes, or hands back a
 * confirmation link to the upgrade sheet for a plan change. It never previews, confirms or writes billing.
 * Refusals are values, never thrown, so the MCP can relay the reason.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { loadComputeBillingState } from '@/server/billing/v2/compute-access';
import type { SwitchConfigurationOutputV3 } from '@/server/billing/v3/contract';
import { computers } from '@/server/db/schema';

import { requireOnboardingCaller } from './onboarding-delegation';
import { liveOwnedComputer } from './routers/computer-store';
import type { TRPCContext } from './trpc';

export const SETTINGS_WRITE_PROCEDURE = 'account.mcpSetSetting' as const;
export const UPGRADE_SHEET_ORIGIN = 'https://os-staging.ezil.work';
export const COMPUTER_SIZES = ['free-cf', 'std-2', 'cmp-4', 'cmp-8'] as const;
export const PLAN_SKUS = ['standard', 'premium', 'compute', 'pro'] as const;

export const settingsWriteInput = z.object({
    id: z.enum(['computer.name', 'computer.size', 'plan.sku']),
    value: z.string(),
    computerId: z.string().uuid().optional(),
    idempotencyKey: z.string().uuid(),
}).strict();
export type SettingsWriteInput = z.infer<typeof settingsWriteInput>;

export type SettingRefusal = 'size_not_allowed' | 'computer_not_found' | 'computer_busy' | 'invalid_value';
export interface SettingsWriteOutput {
    id: SettingsWriteInput['id'];
    status: 'applied' | 'unchanged' | 'refused' | 'pending' | 'confirmation_required';
    value: string | null;
    reason: SettingRefusal | null;
    confirmUrl: string | null;
}

type BillingState = Awaited<ReturnType<typeof loadComputeBillingState>>;

/** The sizes the account may choose: what `account.mcpSettings` reports, null when billing is unreadable. */
export function allowedComputerSizes(billing: BillingState | null): string[] | null {
    return !billing ? null
        : billing.summary.version === 3 ? billing.summary.computer.machineChoice.map(option => option.size)
        : [billing.entitledSize];
}

/** A signed write reaches this only through the onboarding delegation and only while the write gate is open (read per request). */
export function requireSettingsWriteCaller(ctx: Pick<TRPCContext, 'delegation' | 'user'>, env: Record<string, string | undefined> = process.env) {
    if (env.EZIL_DELEGATED_SETTINGS_WRITE !== 'enabled') throw new TRPCError({ code: 'UNAUTHORIZED' });
    return requireOnboardingCaller(ctx, SETTINGS_WRITE_PROCEDURE);
}

export interface SettingsWriteDeps {
    db: {
        query: { computers: { findFirst(args: { where: ReturnType<typeof liveOwnedComputer>; columns: { id: true; name: true } }): Promise<{ id: string; name: string } | undefined> } };
        update(table: typeof computers): {
            set(values: { name: string }): { where(where: ReturnType<typeof liveOwnedComputer>): { returning(): Promise<{ id: string }[]> } };
        };
    };
    allowedSizes(): Promise<string[] | null>;
    switchSize(computerId: string, size: string, requestId: string): Promise<SwitchConfigurationOutputV3>;
}

const refused = (id: SettingsWriteInput['id'], reason: SettingRefusal): SettingsWriteOutput =>
    ({ id, status: 'refused', value: null, reason, confirmUrl: null });
const done = (id: SettingsWriteInput['id'], status: 'applied' | 'unchanged' | 'pending', value: string): SettingsWriteOutput =>
    ({ id, status, value, reason: null, confirmUrl: null });

/** The switch's own refusals folded into section 6: an entitlement or cap is a size the account may not have, anything else is busy. */
function switchRefusal(reason: Extract<SwitchConfigurationOutputV3, { ok: false }>['reason']): SettingRefusal {
    return reason === 'foreign_computer' ? 'computer_not_found'
        : reason === 'not_entitled' || reason === 'aws_monthly_cap' ? 'size_not_allowed' : 'computer_busy';
}

export async function applySetting(deps: SettingsWriteDeps, userId: string, input: SettingsWriteInput): Promise<SettingsWriteOutput> {
    const { id, computerId } = input;
    if (id === 'plan.sku') {
        const sku = PLAN_SKUS.find(known => known === input.value);
        if (!sku || computerId !== undefined) return refused(id, 'invalid_value');
        return {
            id, status: 'confirmation_required', value: sku, reason: null,
            confirmUrl: `${UPGRADE_SHEET_ORIGIN}/os?settings=billing&upgrade=${sku}`,
        };
    }
    const name = input.value.trim();
    const size = COMPUTER_SIZES.find(known => known === input.value);
    if (computerId === undefined || (id === 'computer.name' ? name.length < 1 || name.length > 200 : !size)) {
        return refused(id, 'invalid_value');
    }
    const owned = await deps.db.query.computers.findFirst({ where: liveOwnedComputer(userId, computerId), columns: { id: true, name: true } });
    if (!owned) return refused(id, 'computer_not_found');

    if (id === 'computer.name') {
        if (owned.name === name) return done(id, 'unchanged', name);
        const [updated] = await deps.db.update(computers).set({ name }).where(liveOwnedComputer(userId, computerId)).returning();
        return updated ? done(id, 'applied', name) : refused(id, 'computer_not_found');
    }

    if (!(await deps.allowedSizes())?.includes(input.value)) return refused(id, 'size_not_allowed');
    const result = await deps.switchSize(computerId, input.value, input.idempotencyKey);
    if (!result.ok) return refused(id, switchRefusal(result.reason));
    return result.effective === 'switching' ? done(id, 'pending', input.value)
        : done(id, result.current === result.target ? 'unchanged' : 'applied', input.value);
}
