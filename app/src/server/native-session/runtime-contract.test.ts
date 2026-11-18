import { describe, expect, it } from 'vitest';
import { projectCoreReceipt, projectInitialTaskObservation, projectRuntimeEvent, projectPromptContext } from './runtime-contract';
const id = '11111111-1111-4111-8111-111111111111', runtime = '22222222-2222-4222-8222-222222222222', digest = `sha256:${'a'.repeat(64)}`;
describe('runtime closed producer guards', () => {
 it('accepts genuine claimed cancel tombstones and rejects forged send effects', () => {
  const r = { requestId: id, kind: 'cancel', requestDigest: digest, state: 'cancelled', effect: 'tombstone_before_dispatch', reason: null, runtimeId: runtime };
  expect(projectCoreReceipt(id, 'cancel', digest, runtime, r)).not.toBeNull();
  expect(projectCoreReceipt(id, 'send', digest, runtime, { ...r, kind: 'send' })).toBeNull();
 });
 it('keeps adopted Core UUID before SDK ACK and refuses native claims without UUID', () => {
  const r = { requestId: id, kind: 'initial_task', state: 'starting', effect: 'recorded', reason: null, runtimeId: runtime };
  expect(projectInitialTaskObservation(id, r)?.runtimeId).toBe(runtime);
  expect(projectInitialTaskObservation(id, { ...r, state: 'accepted', runtimeId: null, effect: 'native_observed' })).toBeNull();
  expect(projectInitialTaskObservation(id, { ...r, state: 'unknown', runtimeId: null, effect: 'unknown' })).not.toBeNull();
 });
});
