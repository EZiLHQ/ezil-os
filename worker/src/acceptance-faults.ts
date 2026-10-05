/** Test faults are available only in the explicitly scoped staging deployment. */
export type AcceptanceFault = 'turn_unavailable' | 'checkpoint_write_failed';
export interface AcceptanceFaultConfig {
  EZIL_ACCEPTANCE_ENV?: string;
  EZIL_ACCEPTANCE_SANDBOX?: string;
}
export interface AcceptanceFaultState { fault: AcceptanceFault; expiresAt: number }
export class AcceptanceFaultError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
export function assertAcceptanceScope(config: AcceptanceFaultConfig, sandbox: string): void {
  if (config.EZIL_ACCEPTANCE_ENV !== 'staging' || !config.EZIL_ACCEPTANCE_SANDBOX
      || !/^guac-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/.test(config.EZIL_ACCEPTANCE_SANDBOX)
      || config.EZIL_ACCEPTANCE_SANDBOX !== sandbox) {
    throw new AcceptanceFaultError(404, 'acceptance_faults_disabled');
  }
}
export function parseAcceptanceFault(raw: unknown, now = Date.now()): AcceptanceFaultState | null {
  const value = raw as { fault?: unknown; durationMs?: unknown } | null;
  if (value?.fault === 'clear') return null;
  if (!value || !['turn_unavailable','checkpoint_write_failed'].includes(String(value.fault))
      || typeof value.durationMs !== 'number' || !Number.isInteger(value.durationMs)
      || value.durationMs < 1000 || value.durationMs > 60000) {
    throw new AcceptanceFaultError(400, 'acceptance_fault_bad_request');
  }
  return { fault: value.fault as AcceptanceFault, expiresAt: now + value.durationMs };
}
export function activeAcceptanceFault(config: AcceptanceFaultConfig, sandbox: string,
    state: AcceptanceFaultState | null | undefined, now = Date.now()): AcceptanceFault | null {
  try { assertAcceptanceScope(config, sandbox); } catch { return null; }
  if (!state || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= now || state.expiresAt > now+60000) return null;
  return ['turn_unavailable','checkpoint_write_failed'].includes(state.fault) ? state.fault : null;
}
/** Wrap the real selected durable store. Reads/cleanup continue; commit writes fail. */
export function failCheckpointWrites<T extends object>(store: T): T {
  return new Proxy(store, { get(target, key) {
    if (key === 'put') return async () => { throw new Error('acceptance_checkpoint_write_failed'); };
    const value = Reflect.get(target,key,target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
