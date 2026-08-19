/**
 * Unit tests for the Worker-side telemetry helpers (`./telemetry.ts`).
 *
 * Pure — no network/container/R2. Run with `bun test`.
 */

import { describe, expect, it } from 'bun:test';
import type { LogEvent } from './observability';
import {
  TELEMETRY_DRAIN_MAX_OBJECTS,
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_SPOOL_PREFIX,
  buildTelemetryR2Key,
  clampDrainLimit,
  parseContainerTelemetryLines,
  parseTelemetryAckKeys,
  parseTelemetryDrainBody,
  selectTelemetryWorthy,
  serializeTelemetryBatch,
  telemetryDrainDisabled,
  toTelemetryEventInput,
} from './telemetry';

function logEvent(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: '2026-08-03T08:00:00.000Z',
    correlationId: 'cid-1',
    event: 'sandbox.preview.workspace_mount',
    schemaVersion: 1,
    stage: 'workspace_mount',
    outcome: 'ok',
    ...overrides,
  };
}

describe('selectTelemetryWorthy', () => {
  it('keeps every error event', () => {
    const events = [logEvent({ outcome: 'error', errorCode: 'boom' })];
    expect(selectTelemetryWorthy(events)).toEqual(events);
  });

  it('keeps sandbox.preview.desktop_ready even when ok — the boot-summary denominator', () => {
    const events = [logEvent({ event: 'sandbox.preview.desktop_ready', outcome: 'ok' })];
    expect(selectTelemetryWorthy(events)).toEqual(events);
  });

  it('drops a healthy, non-boot-summary event (already covered by console.log alone)', () => {
    const events = [logEvent({ event: 'sandbox.preview.authorize', outcome: 'ok' })];
    expect(selectTelemetryWorthy(events)).toEqual([]);
  });

  it('keeps errors AND the summary, drops everything else, preserving order', () => {
    const keep1 = logEvent({ event: 'sandbox.preview.authorize', outcome: 'error', errorCode: 'bad' });
    const drop = logEvent({ event: 'sandbox.preview.identity', outcome: 'ok' });
    const keep2 = logEvent({ event: 'sandbox.preview.desktop_ready', outcome: 'ok' });
    expect(selectTelemetryWorthy([keep1, drop, keep2])).toEqual([keep1, keep2]);
  });
});

describe('toTelemetryEventInput', () => {
  it('maps sandbox.preview.desktop_ready to boot_summary, even on the SUCCESS path', () => {
    const out = toTelemetryEventInput(
      logEvent({ event: 'sandbox.preview.desktop_ready', outcome: 'ok', sandboxId: 'guac-abc' }),
    );
    expect(out.eventClass).toBe('boot_summary');
    expect(out.source).toBe('worker');
    expect(out.outcome).toBe('ok');
    expect(out.code).toBe('ok');
    expect(out.site).toBe('sandbox.preview.desktop_ready');
    expect(out.schemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);
  });

  it('maps a failed desktop_ready to boot_summary too (both directions of the denominator)', () => {
    const out = toTelemetryEventInput(
      logEvent({ event: 'sandbox.preview.desktop_ready', outcome: 'error', errorCode: 'desktop_failed_to_start' }),
    );
    expect(out.eventClass).toBe('boot_summary');
    expect(out.outcome).toBe('error');
    expect(out.code).toBe('desktop_failed_to_start');
  });

  it('maps any other error event to worker_exception, using errorCode as the code', () => {
    const out = toTelemetryEventInput(
      logEvent({ event: 'sandbox.preview.authorize', outcome: 'error', errorCode: 'hmac_required' }),
    );
    expect(out.eventClass).toBe('worker_exception');
    expect(out.code).toBe('hmac_required');
  });

  it('falls back to unexpected_error when an error event carries no errorCode', () => {
    const out = toTelemetryEventInput(logEvent({ outcome: 'error' }));
    expect(out.code).toBe('unexpected_error');
  });

  it('carries durationMs, correlationId and a sanitized detail through unchanged', () => {
    const out = toTelemetryEventInput(
      logEvent({ durationMs: 1234.6, correlationId: 'cid-xyz', detail: 'already sanitized detail' }),
    );
    expect(out.durationMs).toBe(1235); // rounded
    expect(out.correlationId).toBe('cid-xyz');
    expect(out.detail).toBe('already sanitized detail');
  });

  it('mints a fresh eventId on every call (never derived from correlationId alone)', () => {
    const a = toTelemetryEventInput(logEvent());
    const b = toTelemetryEventInput(logEvent());
    expect(a.eventId).not.toBe(b.eventId);
  });

  it('never emits a computerId when sandboxId is absent (no accidental empty-string column)', () => {
    const out = toTelemetryEventInput(logEvent());
    expect(out.computerId).toBeUndefined();
  });

  /**
   * 🔴 NEVER emits a computerId when a sandboxId IS present either — the case
   * that actually shipped. `sandboxId` is
   * `guac-<16 alnum of userId>-<16 alnum of computerId>`, which is (a) not a
   * UUID, so `app/src/server/telemetry/schema.ts`'s `.strict()` parse drops
   * the WHOLE event (measured: `{ events: [], droppedInvalid: 1 }` with the
   * field, clean without it), and (b) 64 bits of the raw Supabase user id,
   * which is a re-identifiable identity, not an opaque token.
   *
   * Both halves are asserted: nothing named computerId, and no substring of
   * the sandboxId anywhere in the serialised event.
   */
  it('🔴 never puts the sandboxId in computerId — it is not a UUID and not anonymous', () => {
    const out = toTelemetryEventInput(
      logEvent({ event: 'sandbox.preview.desktop_ready', outcome: 'ok', sandboxId: 'guac-abcdef0123456789-fedcba9876543210' }),
    );
    expect(out.computerId).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('abcdef0123456789');
    expect(JSON.stringify(out)).not.toContain('guac-');
  });
});

describe('parseContainerTelemetryLines (emit_telemetry() NDJSON drain)', () => {
  const ctx = { correlationId: 'cid-boot', sandboxId: 'guac-boot-1' };

  it('parses a well-formed boot_phase line exactly as emit_telemetry() writes it', () => {
    const raw = '{"eventClass":"boot_phase","source":"container","site":"xvfb","code":"error","outcome":"error","durationMs":420}\n';
    const events = parseContainerTelemetryLines(raw, ctx);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventClass: 'boot_phase',
      source: 'container',
      site: 'xvfb',
      code: 'error',
      outcome: 'error',
      durationMs: 420,
      correlationId: 'cid-boot',
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
    });
    expect(typeof events[0].occurredAt).toBe('string');
    expect(typeof events[0].eventId).toBe('string');
  });

  it('parses multiple lines, one event per line, both success and failure outcomes', () => {
    const raw = [
      '{"eventClass":"boot_phase","source":"container","site":"workspace_hydration","code":"ok","outcome":"ok","durationMs":12}',
      '{"eventClass":"boot_summary","source":"container","site":"ready","code":"ok","outcome":"ok","durationMs":5900}',
    ].join('\n');
    const events = parseContainerTelemetryLines(raw, ctx);
    expect(events).toHaveLength(2);
    expect(events[0].outcome).toBe('ok');
    expect(events[1].eventClass).toBe('boot_summary');
  });

  it('drops a line that is not valid JSON, keeping every other valid line (fails closed per-line)', () => {
    const raw = [
      'not json at all',
      '{"eventClass":"boot_phase","site":"xvfb","code":"ok","outcome":"ok"}',
    ].join('\n');
    const events = parseContainerTelemetryLines(raw, ctx);
    expect(events).toHaveLength(1);
    expect(events[0].site).toBe('xvfb');
  });

  it('drops a line with an eventClass outside the closed set', () => {
    const raw = '{"eventClass":"totally_made_up","site":"x","code":"ok","outcome":"ok"}';
    expect(parseContainerTelemetryLines(raw, ctx)).toEqual([]);
  });

  it('drops a line with a missing/empty site or code', () => {
    expect(parseContainerTelemetryLines('{"eventClass":"boot_phase","site":"","code":"ok","outcome":"ok"}', ctx)).toEqual([]);
    expect(parseContainerTelemetryLines('{"eventClass":"boot_phase","site":"x","code":"","outcome":"ok"}', ctx)).toEqual([]);
  });

  it('drops a line with an outcome outside {ok,error,skipped}', () => {
    const raw = '{"eventClass":"boot_phase","site":"x","code":"y","outcome":"weird"}';
    expect(parseContainerTelemetryLines(raw, ctx)).toEqual([]);
  });

  it('drops a JSON array or scalar line (not an object)', () => {
    expect(parseContainerTelemetryLines('[1,2,3]', ctx)).toEqual([]);
    expect(parseContainerTelemetryLines('42', ctx)).toEqual([]);
    expect(parseContainerTelemetryLines('"a string"', ctx)).toEqual([]);
  });

  it('ignores blank lines and surrounding whitespace', () => {
    const raw = '\n\n  {"eventClass":"boot_phase","site":"x","code":"y","outcome":"ok"}  \n\n';
    expect(parseContainerTelemetryLines(raw, ctx)).toHaveLength(1);
  });

  it('returns an empty array for null/undefined/empty input, never throwing', () => {
    expect(parseContainerTelemetryLines(null, ctx)).toEqual([]);
    expect(parseContainerTelemetryLines(undefined, ctx)).toEqual([]);
    expect(parseContainerTelemetryLines('', ctx)).toEqual([]);
  });

  it('omits durationMs when the line does not carry one, rather than inventing 0', () => {
    const raw = '{"eventClass":"boot_phase","site":"x","code":"y","outcome":"skipped"}';
    const [event] = parseContainerTelemetryLines(raw, ctx);
    expect(event.durationMs).toBeUndefined();
  });

  it('omits computerId when the context carries no sandboxId', () => {
    const raw = '{"eventClass":"boot_phase","site":"x","code":"y","outcome":"ok"}';
    const [event] = parseContainerTelemetryLines(raw, { correlationId: 'cid-only' });
    expect(event.computerId).toBeUndefined();
    expect(event.correlationId).toBe('cid-only');
  });

  /** Same rule as the worker path — see that test's header. */
  it('🔴 omits computerId even when the context DOES carry a sandboxId', () => {
    const raw = '{"eventClass":"boot_phase","site":"x","code":"y","outcome":"ok"}';
    const [event] = parseContainerTelemetryLines(raw, ctx);
    expect(event.computerId).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain('guac-');
  });

  it('uses the injectable `now` for a deterministic occurredAt', () => {
    const raw = '{"eventClass":"boot_phase","site":"x","code":"y","outcome":"ok"}';
    const [event] = parseContainerTelemetryLines(raw, { ...ctx, now: new Date('2026-01-02T03:04:05.000Z') });
    expect(event.occurredAt).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('serializeTelemetryBatch', () => {
  it('writes one JSON object per line, in order', () => {
    const events = parseContainerTelemetryLines(
      [
        '{"eventClass":"boot_phase","site":"a","code":"ok","outcome":"ok"}',
        '{"eventClass":"boot_phase","site":"b","code":"ok","outcome":"ok"}',
      ].join('\n'),
      { correlationId: 'cid' },
    );
    const body = serializeTelemetryBatch(events);
    const lines = body.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).site).toBe('a');
    expect(JSON.parse(lines[1]).site).toBe('b');
  });

  it('produces the empty string for an empty batch', () => {
    expect(serializeTelemetryBatch([])).toBe('');
  });
});

describe('buildTelemetryR2Key', () => {
  it('builds the exact v1/dt=/hh=/ layout the design doc specifies', () => {
    const key = buildTelemetryR2Key(new Date('2026-08-03T14:05:00.000Z'), 'cid-abc-123');
    expect(key).toBe('v1/dt=2026-08-03/hh=14/cid-abc-123.ndjson');
  });

  it('sanitizes a correlation id that is not a safe path segment', () => {
    const key = buildTelemetryR2Key(new Date('2026-08-03T00:00:00.000Z'), '../../etc/passwd');
    expect(key).not.toContain('..');
    expect(key.startsWith('v1/dt=2026-08-03/hh=00/')).toBe(true);
  });

  it('falls back to "unknown" for an empty correlation id', () => {
    const key = buildTelemetryR2Key(new Date('2026-08-03T00:00:00.000Z'), '');
    expect(key).toBe('v1/dt=2026-08-03/hh=00/unknown.ndjson');
  });

  it('zero-pads month/day/hour', () => {
    const key = buildTelemetryR2Key(new Date('2026-01-05T03:00:00.000Z'), 'x');
    expect(key).toBe('v1/dt=2026-01-05/hh=03/x.ndjson');
  });
});

// ── The R2 drain: telemetryDrainDisabled / clampDrainLimit / body parsers ────
// These back `POST /telemetry/drain` + `/telemetry/ack` (`./index.ts`) — the
// headline defect this module's own top-of-file "KNOWN GAP" note calls out:
// `spoolTelemetry()` has been writing all along, nothing ever read it back.

describe('telemetryDrainDisabled — same kill-switch vocabulary as focusDisabled/restartDisabled', () => {
  it('is enabled (not disabled) by default — undefined/empty flag', () => {
    expect(telemetryDrainDisabled(undefined)).toBe(false);
    expect(telemetryDrainDisabled('')).toBe(false);
  });

  it('disables on off/false/0/disabled/no, case- and whitespace-insensitive', () => {
    for (const v of ['off', 'FALSE', ' 0 ', 'Disabled', 'no']) {
      expect(telemetryDrainDisabled(v)).toBe(true);
    }
  });

  it('anything else (a typo, an unrelated value) leaves the route enabled, never silently disables it', () => {
    expect(telemetryDrainDisabled('onn')).toBe(false);
    expect(telemetryDrainDisabled('true')).toBe(false);
  });
});

describe('clampDrainLimit', () => {
  it('defaults to the ceiling when nothing/non-numeric is requested', () => {
    expect(clampDrainLimit(undefined)).toBe(TELEMETRY_DRAIN_MAX_OBJECTS);
    expect(clampDrainLimit('200')).toBe(TELEMETRY_DRAIN_MAX_OBJECTS);
    expect(clampDrainLimit(NaN)).toBe(TELEMETRY_DRAIN_MAX_OBJECTS);
  });

  it('🔴 clamps an oversized request DOWN to the 200-object ceiling — never lets a caller demand more', () => {
    expect(clampDrainLimit(999_999)).toBe(TELEMETRY_DRAIN_MAX_OBJECTS);
  });

  it('clamps a non-positive request UP to at least 1', () => {
    expect(clampDrainLimit(0)).toBe(1);
    expect(clampDrainLimit(-5)).toBe(1);
  });

  it('passes a valid in-range request through unchanged', () => {
    expect(clampDrainLimit(50)).toBe(50);
  });
});

describe('parseTelemetryDrainBody', () => {
  it('extracts a valid cursor and limit', () => {
    expect(parseTelemetryDrainBody({ cursor: 'abc', limit: 10 })).toEqual({ cursor: 'abc', limit: 10 });
  });

  it('never throws on a malformed body — empty object, not an exception', () => {
    expect(parseTelemetryDrainBody(null)).toEqual({});
    expect(parseTelemetryDrainBody(undefined)).toEqual({});
    expect(parseTelemetryDrainBody('not an object')).toEqual({});
    expect(parseTelemetryDrainBody([1, 2, 3])).toEqual({});
  });

  it('drops a blank-string cursor and a non-number limit rather than passing them through', () => {
    expect(parseTelemetryDrainBody({ cursor: '   ', limit: 'ten' })).toEqual({});
  });
});

describe('parseTelemetryAckKeys — the delete-list allowlist', () => {
  it('accepts keys rooted under the spool prefix', () => {
    const keys = [`${TELEMETRY_SPOOL_PREFIX}dt=2026-08-03/hh=14/a.ndjson`, `${TELEMETRY_SPOOL_PREFIX}dt=2026-08-03/hh=14/b.ndjson`];
    expect(parseTelemetryAckKeys({ keys })).toEqual(keys);
  });

  it('🔴 REJECTS a key outside the spool prefix, even if the caller holds a valid HMAC token — never a delete-anything primitive', () => {
    const keys = ['some-other-bucket-object.txt', '../etc/passwd', 'ezil-telemetry-spool-config.json'];
    expect(parseTelemetryAckKeys({ keys })).toEqual([]);
  });

  it('drops non-string entries and keeps the valid ones from the same array', () => {
    const good = `${TELEMETRY_SPOOL_PREFIX}dt=2026-08-03/hh=14/a.ndjson`;
    expect(parseTelemetryAckKeys({ keys: [good, 123, null, {}, good] })).toEqual([good, good]);
  });

  it('never throws on a malformed body', () => {
    expect(parseTelemetryAckKeys(null)).toEqual([]);
    expect(parseTelemetryAckKeys({})).toEqual([]);
    expect(parseTelemetryAckKeys({ keys: 'not-an-array' })).toEqual([]);
  });

  it('caps the accepted list at TELEMETRY_DRAIN_MAX_OBJECTS', () => {
    const many = Array.from({ length: TELEMETRY_DRAIN_MAX_OBJECTS + 50 }, (_, i) => `${TELEMETRY_SPOOL_PREFIX}k${i}.ndjson`);
    expect(parseTelemetryAckKeys({ keys: many })).toHaveLength(TELEMETRY_DRAIN_MAX_OBJECTS);
  });
});

// ── The `code` wire contract (`docs/BROWSER-FIX-CONTRACT.md` §8) ────────────

describe('telemetry: `code` is normalised to what the app ingest schema accepts', () => {
  /** The app's own rule, `app/src/server/telemetry/schema.ts`. Copied here
   * because the worker package has no import path into `app/`; if that regex
   * ever changes, this is the assertion that goes stale loudly rather than a
   * pipeline that starts silently discarding events. */
  const APP_CODE_REGEX = /^[a-z0-9_]{1,64}$/;

  it('accepts the contract §8 codes verbatim and returns something the app will store', async () => {
    const { normalizeTelemetryCode } = await import('./telemetry');
    // These four are the literal examples in the contract. All four are
    // INVALID under the app's regex as written — the hyphen.
    for (const contractCode of ['screen-unsupported', 'screen-upstream', 'decor-still-present', 'xtest-dead']) {
      expect(APP_CODE_REGEX.test(contractCode)).toBe(false);
      const normalized = normalizeTelemetryCode(contractCode);
      expect(APP_CODE_REGEX.test(normalized)).toBe(true);
      expect(normalized).toBe(contractCode.replace(/-/g, '_'));
    }
  });

  it('agrees with the shell producer, so one event has one spelling everywhere', async () => {
    const { normalizeTelemetryCode } = await import('./telemetry');
    // `shell/ezil/telemetry.js`'s `normalizeCode`, transcribed. The two must
    // produce the same string for the same input or a shell-reported
    // `screen-unsupported` and a container-reported one become two rows.
    const shellNormalizeCode = (code: unknown) => {
      const s = String(code ?? 'unknown').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
      return (s || 'unknown').slice(0, 64);
    };
    for (const probe of [
      'screen-unsupported', 'DECOR-Still-Present', 'xtest.dead', 'a/b', '', '   ',
      'ja-acentuado', '__leading', 'trailing__', 'x'.repeat(200),
    ]) {
      expect(normalizeTelemetryCode(probe)).toBe(shellNormalizeCode(probe));
    }
  });

  it('never yields an empty or over-long code', async () => {
    const { normalizeTelemetryCode } = await import('./telemetry');
    for (const probe of [undefined, null, '', '---', '!!!', {}, 0]) {
      expect(APP_CODE_REGEX.test(normalizeTelemetryCode(probe))).toBe(true);
    }
    expect(normalizeTelemetryCode('x'.repeat(500))).toHaveLength(64);
  });

  it('normalises the code on a CONTAINER NDJSON line, not merely truncates it', async () => {
    const { parseContainerTelemetryLines } = await import('./telemetry');
    const line = JSON.stringify({
      eventClass: 'contract_violation',
      source: 'container',
      site: 'container:neko#decor',
      code: 'decor-still-present',
      outcome: 'error',
    });
    const [event] = parseContainerTelemetryLines(line, { correlationId: 'corr-1' });
    expect(event.site).toBe('container:neko#decor');
    expect(event.code).toBe('decor_still_present');
    expect(APP_CODE_REGEX.test(event.code)).toBe(true);
  });

  it('carries the contract §8 container sites through unchanged (site has no charset rule)', async () => {
    const { parseContainerTelemetryLines } = await import('./telemetry');
    const raw = [
      JSON.stringify({ eventClass: 'boot_phase', site: 'container:neko#app_exit', code: 'app_exit_clean', outcome: 'ok', durationMs: 12 }),
      JSON.stringify({ eventClass: 'contract_violation', site: 'container:neko#decor', code: 'decor-still-present', outcome: 'error' }),
    ].join('\n');
    const events = parseContainerTelemetryLines(raw, { correlationId: 'corr-2' });
    expect(events.map((e) => e.site)).toEqual(['container:neko#app_exit', 'container:neko#decor']);
    expect(events.map((e) => e.eventClass)).toEqual(['boot_phase', 'contract_violation']);
    // Both are inside the 96-char site ceiling, so nothing is truncated.
    for (const e of events) expect(e.site.length).toBeLessThanOrEqual(96);
  });

  it('does not disturb the codes the container already emits (`ok`/`error`/`skipped`)', async () => {
    const { parseContainerTelemetryLines } = await import('./telemetry');
    const raw = ['ok', 'error', 'skipped']
      .map((s) => JSON.stringify({ eventClass: 'boot_phase', site: 'neko_serve_bind', code: s, outcome: s }))
      .join('\n');
    const events = parseContainerTelemetryLines(raw, { correlationId: 'c' });
    expect(events.map((e) => e.code)).toEqual(['ok', 'error', 'skipped']);
  });
});
