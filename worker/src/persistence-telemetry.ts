/**
 * The persistence signal — producer half of `docs/PERSISTENCE-SIGNAL-CONTRACT.md`.
 *
 * Answers one question per computer: did the last restore and the last saves
 * of its two persistent layers (`/workspace` and the system layer) succeed,
 * and if not, why. Metadata ONLY — reason codes, counts, size buckets, ages.
 * Never a path, a file or package name, a command or any content: that is
 * what keeps the signal valid once the layers are end-to-end encrypted.
 *
 * Everything here is pure (state in, state + events out) so the Durable
 * Object only has to load the tracker, call {@link observe}, store it and
 * spool what came back.
 */
import { TELEMETRY_SCHEMA_VERSION, type TelemetryEventInput, type TelemetryOutcome } from './telemetry';

export const PERSISTENCE_SITES = [
  'persist.system.restore',
  'persist.workspace.restore',
  'persist.system.flush',
  'persist.workspace.flush',
  'persist.stop',
  'persist.open_blocked',
  'persist.heartbeat',
] as const;
export type PersistenceSite = (typeof PERSISTENCE_SITES)[number];

export const PERSISTENCE_CODES = [
  'ok', 'unchanged',
  'too_large', 'stale', 'not_restored', 'failed', 'busy',
  'no_baseline', 'no_manifest', 'no_computer', 'no_snapshot',
  'already_restored', 'legacy_discarded',
  'container_not_hydrated', 'hydration_incomplete', 'deferred', 'empty_prefix', 'flush_threw',
  'workspace_persistence_unavailable', 'workspace_checkpoint_failed',
  'unknown',
] as const;
export type PersistenceCode = (typeof PERSISTENCE_CODES)[number];

export type PersistenceLayer = 'system' | 'workspace';
export type PersistenceTrigger = 'interval' | 'final' | 'readiness' | 'idle_stop' | 'teardown' | 'open' | 'heartbeat';
export type SizeBucket = 'lt_64m' | 'lt_256m' | 'lt_512m' | 'over_cap';

/** Contract §2 — the only attrs keys a persistence event may carry. */
export const PERSISTENCE_ATTR_KEYS = [
  'entries', 'size_bucket', 'system_age_s', 'workspace_age_s', 'consecutive_failures', 'trigger', 'discarded_unsaved',
] as const;

/** Contract §3. */
export const PERSISTENCE_HEARTBEAT_MS = 15 * 60_000;

const MIB = 1024 * 1024;
/** The snapshot byte cap both layers share (`LIMIT` in the snapshot scripts). */
export const SNAPSHOT_CAP_BYTES = 512 * MIB;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** The ONLY thing ever stamped as `computerId`: a real `ezil_computers.id`, never a sandboxId. */
export function isComputerUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function sizeBucket(bytes: number | undefined): SizeBucket | undefined {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 64 * MIB) return 'lt_64m';
  if (bytes < 256 * MIB) return 'lt_256m';
  if (bytes < SNAPSHOT_CAP_BYTES) return 'lt_512m';
  return 'over_cap';
}

/** Any string that is not a contract code becomes `unknown` — never a free-form code. */
export function toPersistenceCode(value: unknown): PersistenceCode {
  return (PERSISTENCE_CODES as readonly string[]).includes(value as string) ? (value as PersistenceCode) : 'unknown';
}

const OK_CODES: ReadonlySet<PersistenceCode> = new Set(['ok', 'unchanged', 'already_restored', 'no_snapshot']);
const ERROR_CODES: ReadonlySet<PersistenceCode> = new Set([
  'failed', 'flush_threw', 'unknown', 'workspace_persistence_unavailable', 'workspace_checkpoint_failed',
]);
/**
 * Routine, self-resolving outcomes that are NOT a state of the layer: a
 * deferred workspace upload (inside its 60 s window) or a capture that found
 * an install running. Recording them as state would flip ok↔deferred on every
 * edit and turn "transition" into "every cycle". They are neither emitted nor
 * counted as failures.
 */
const TRANSIENT_CODES: ReadonlySet<PersistenceCode> = new Set(['deferred', 'busy']);
const DATA_LOSS_CODES: ReadonlySet<PersistenceCode> = new Set(['too_large', 'stale', 'not_restored', 'failed', 'flush_threw']);

export function outcomeOf(code: PersistenceCode): TelemetryOutcome {
  if (OK_CODES.has(code)) return 'ok';
  if (ERROR_CODES.has(code)) return 'error';
  return 'skipped';
}

/**
 * The transition key for a code: every "saved / nothing to save" spelling is
 * one state, so a workspace alternating between uploaded (`ok`) and
 * `unchanged` as the user edits is not a stream of transitions.
 */
function stateKey(code: PersistenceCode): string {
  return OK_CODES.has(code) ? 'ok' : code;
}

export interface LayerTrack {
  site: PersistenceSite | null;
  code: PersistenceCode | null;
  outcome: TelemetryOutcome | null;
  /** Epoch ms of the last OK commit of this layer (`ok`/`unchanged` flush). */
  lastOkCommitAt: number | null;
  consecutiveFailures: number;
}

/** Serialisable; lives in DO storage under one key. */
export interface PersistenceTrackerState {
  v: 1;
  system: LayerTrack;
  workspace: LayerTrack;
  /** Epoch ms of the last persistence event spooled (any site). */
  lastEventAt: number | null;
  lastStopDiscardedUnsaved: boolean;
}

export function emptyTrackerState(): PersistenceTrackerState {
  const layer = (): LayerTrack => ({ site: null, code: null, outcome: null, lastOkCommitAt: null, consecutiveFailures: 0 });
  return { v: 1, system: layer(), workspace: layer(), lastEventAt: null, lastStopDiscardedUnsaved: false };
}

/** Accepts whatever DO storage returned; anything unrecognisable starts fresh. */
export function loadTrackerState(raw: unknown): PersistenceTrackerState {
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return emptyTrackerState();
  const r = raw as PersistenceTrackerState;
  if (!r.system || !r.workspace) return emptyTrackerState();
  return r;
}

export type PersistenceObservation =
  | {
      kind: 'flush' | 'restore';
      layer: PersistenceLayer;
      code: PersistenceCode;
      trigger: PersistenceTrigger;
      durationMs?: number;
      entries?: number;
      bytes?: number;
    }
  | { kind: 'stop'; trigger: 'idle_stop' | 'teardown' }
  | { kind: 'open_blocked'; code: 'workspace_persistence_unavailable' | 'workspace_checkpoint_failed' }
  | { kind: 'heartbeat'; running: boolean };

export interface ObserveContext {
  computerId?: unknown;
  correlationId?: string;
  newEventId?: () => string;
}

function ageS(at: number | null, now: number): number {
  return at === null ? -1 : Math.max(0, Math.floor((now - at) / 1000));
}

/** First non-OK layer code (system wins), else `ok`. */
function worstCode(state: PersistenceTrackerState): PersistenceCode {
  for (const layer of ['system', 'workspace'] as const) {
    const code = state[layer].code;
    if (code && !OK_CODES.has(code)) return code;
  }
  return 'ok';
}

function buildEvent(
  site: PersistenceSite,
  code: PersistenceCode,
  state: PersistenceTrackerState,
  now: number,
  ctx: ObserveContext,
  extra: { trigger: PersistenceTrigger; durationMs?: number; entries?: number; bytes?: number;
    consecutiveFailures?: number; discardedUnsaved?: boolean; tooLarge?: boolean },
): TelemetryEventInput {
  const attrs: Record<string, string | number | boolean> = {
    system_age_s: ageS(state.system.lastOkCommitAt, now),
    workspace_age_s: ageS(state.workspace.lastOkCommitAt, now),
    trigger: extra.trigger,
  };
  if (typeof extra.entries === 'number' && Number.isFinite(extra.entries)) attrs.entries = Math.max(0, Math.floor(extra.entries));
  const bucket = sizeBucket(extra.bytes) ?? (extra.tooLarge ? 'over_cap' : undefined);
  if (bucket) attrs.size_bucket = bucket;
  if (typeof extra.consecutiveFailures === 'number') attrs.consecutive_failures = extra.consecutiveFailures;
  if (typeof extra.discardedUnsaved === 'boolean') attrs.discarded_unsaved = extra.discardedUnsaved;
  const event: TelemetryEventInput = {
    eventId: (ctx.newEventId ?? (() => crypto.randomUUID()))(),
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventClass: 'persistence',
    source: 'worker',
    occurredAt: new Date(now).toISOString(),
    site,
    code,
    outcome: outcomeOf(code),
    attrs,
  };
  if (typeof extra.durationMs === 'number' && Number.isFinite(extra.durationMs) && extra.durationMs >= 0) {
    event.durationMs = Math.min(Math.floor(extra.durationMs), 24 * 60 * 60 * 1000);
  }
  if (ctx.correlationId) event.correlationId = ctx.correlationId.slice(0, 64);
  if (isComputerUuid(ctx.computerId)) event.computerId = ctx.computerId.toLowerCase();
  return event;
}

/**
 * Contract §3. Returns the events to spool NOW and the next tracker state.
 * - flush/restore: emitted only when the layer's (site, state) changed;
 *   identical repeats — e.g. the failed-capture loop — are suppressed.
 * - stop / open_blocked: always emitted.
 * - heartbeat: emitted when ≥ 15 min since the last persistence event and
 *   the container is running.
 */
export function observe(
  prev: PersistenceTrackerState,
  obs: PersistenceObservation,
  now: number,
  ctx: ObserveContext = {},
): { events: TelemetryEventInput[]; state: PersistenceTrackerState } {
  let state = prev;
  const events: TelemetryEventInput[] = [];

  if (obs.kind === 'flush' || obs.kind === 'restore') {
    const code = toPersistenceCode(obs.code);
    // The container was already hydrated: no restore occurred, and this must
    // not overwrite its real restore outcome or break flush suppression.
    if (obs.kind === 'restore' && code === 'already_restored') return { events, state: prev };
    if (TRANSIENT_CODES.has(code)) return { events, state: prev };
    const site: PersistenceSite = `persist.${obs.layer}.${obs.kind}` as PersistenceSite;
    const track = prev[obs.layer];
    const changed = track.site !== site || track.code === null || stateKey(track.code) !== stateKey(code);
    const outcome = outcomeOf(code);
    const nextTrack: LayerTrack = {
      site, code, outcome,
      consecutiveFailures: outcome === 'ok' ? 0 : track.consecutiveFailures + 1,
      lastOkCommitAt: obs.kind === 'flush' && (code === 'ok' || code === 'unchanged') ? now : track.lastOkCommitAt,
    };
    if (track.site !== nextTrack.site || track.code !== nextTrack.code || track.outcome !== nextTrack.outcome
        || track.consecutiveFailures !== nextTrack.consecutiveFailures || track.lastOkCommitAt !== nextTrack.lastOkCommitAt) {
      state = { ...prev, [obs.layer]: nextTrack };
    }
    if (changed) {
      events.push(buildEvent(site, code, state, now, ctx, {
        trigger: obs.trigger, durationMs: obs.durationMs, entries: obs.entries, bytes: obs.bytes,
        consecutiveFailures: nextTrack.consecutiveFailures, tooLarge: code === 'too_large',
      }));
    }
  } else if (obs.kind === 'stop') {
    const code = worstCode(state);
    const discardedUnsaved = [state.system, state.workspace].some((layer) => layer.code !== null && DATA_LOSS_CODES.has(layer.code));
    if (discardedUnsaved !== state.lastStopDiscardedUnsaved) state = { ...state, lastStopDiscardedUnsaved: discardedUnsaved };
    events.push(buildEvent('persist.stop', code, state, now, ctx, { trigger: obs.trigger, discardedUnsaved }));
  } else if (obs.kind === 'open_blocked') {
    events.push(buildEvent('persist.open_blocked', obs.code, state, now, ctx, { trigger: 'open' }));
  } else if (obs.kind === 'heartbeat') {
    if (obs.running && (state.lastEventAt === null || now - state.lastEventAt >= PERSISTENCE_HEARTBEAT_MS)) {
      events.push(buildEvent('persist.heartbeat', worstCode(state), state, now, ctx, { trigger: 'heartbeat' }));
    }
  }

  if (events.length > 0 && state.lastEventAt !== now) state = { ...state, lastEventAt: now };
  return { events, state };
}

export interface PersistenceLayerStatus {
  code: PersistenceCode;
  outcome: TelemetryOutcome;
  committedAgeS: number | null;
}

/** Contract §5. */
export interface PersistenceStatus {
  system: PersistenceLayerStatus;
  workspace: PersistenceLayerStatus;
  savingPaused: boolean;
  pausedLayer: PersistenceLayer | null;
  pausedReason: 'too_large' | 'stale' | 'not_restored' | null;
  lastStopDiscardedUnsaved: boolean;
}

const SYSTEM_PAUSE_CODES: ReadonlySet<PersistenceCode> = new Set(['too_large', 'stale', 'not_restored']);

export function statusFrom(state: PersistenceTrackerState, now: number): PersistenceStatus {
  const layer = (t: LayerTrack): PersistenceLayerStatus => {
    const code = t.code ?? 'unknown';
    return {
      code,
      outcome: t.code ? (t.outcome ?? outcomeOf(code)) : 'skipped',
      committedAgeS: t.lastOkCommitAt === null ? null : Math.max(0, Math.floor((now - t.lastOkCommitAt) / 1000)),
    };
  };
  const system = layer(state.system);
  const workspace = layer(state.workspace);
  let pausedLayer: PersistenceLayer | null = null;
  let pausedReason: PersistenceStatus['pausedReason'] = null;
  if (state.system.code && SYSTEM_PAUSE_CODES.has(state.system.code)) {
    pausedLayer = 'system';
    pausedReason = state.system.code as 'too_large' | 'stale' | 'not_restored';
  } else if (state.workspace.code === 'too_large') {
    pausedLayer = 'workspace';
    pausedReason = 'too_large';
  }
  return {
    system,
    workspace,
    savingPaused: pausedLayer !== null,
    pausedLayer,
    pausedReason,
    lastStopDiscardedUnsaved: state.lastStopDiscardedUnsaved,
  };
}
