/**
 * Deterministic unit tests for the sanitized structured observability module.
 *
 * These assert the two properties the lifecycle-logging mission depends on:
 *   1. Every emitted event carries the required correlated schema fields.
 *   2. No sensitive material (raw user ids, HMAC tokens/signatures, TURN/relay
 *      credentials, cookies, auth headers, keys, IP addresses) can leak into a
 *      log line, and upstream error strings are bounded.
 *
 * Pure — no network/container. Run with `bun test`.
 */

import { describe, expect, it } from 'bun:test';
import {
  LOG_SCHEMA_VERSION,
  MAX_DETAIL_LEN,
  LifecycleTimeline,
  classifyError,
  createCollectingSink,
  newCorrelationId,
  safeUserHash,
  sanitizeErrorMessage,
  sanitizeProjectId,
  type LogEvent,
} from './observability';

describe('safeUserHash', () => {
  it('never returns the raw user id', () => {
    const raw = 'user_1234567890@example.com';
    const h = safeUserHash(raw);
    expect(h).not.toContain('user_1234567890');
    expect(h).not.toContain('example.com');
    expect(h.startsWith('u_')).toBe(true);
  });

  it('is deterministic for the same id', () => {
    expect(safeUserHash('abc')).toBe(safeUserHash('abc'));
  });

  it('differs for different ids', () => {
    expect(safeUserHash('abc')).not.toBe(safeUserHash('abd'));
  });

  it('maps empty/undefined to a stable anon token', () => {
    expect(safeUserHash(undefined)).toBe('u_anon');
    expect(safeUserHash('')).toBe('u_anon');
    expect(safeUserHash('   ')).toBe('u_anon');
  });
});

describe('sanitizeErrorMessage', () => {
  it('redacts HMAC preview tokens and bare signatures', () => {
    const s = sanitizeErrorMessage('mount failed with t=1712345678901,v1=deadbeefcafebabe0011');
    expect(s).not.toContain('deadbeef');
    expect(s).toContain('[redacted-token]');
  });

  it('redacts authorization / cookie / bearer material', () => {
    expect(sanitizeErrorMessage('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
    expect(sanitizeErrorMessage('cookie=session=supersecretvalue')).not.toContain('supersecretvalue');
  });

  it('redacts key/secret/token assignments', () => {
    expect(sanitizeErrorMessage('access_key=AKIA1234 secret=topsecret')).not.toContain('topsecret');
    expect(sanitizeErrorMessage('api_key: abcd1234efgh')).not.toContain('abcd1234efgh');
  });

  it('redacts IPv4 and IPv6 candidate addresses', () => {
    expect(sanitizeErrorMessage('ice candidate 203.0.113.42 failed')).toContain('[redacted-ip]');
    expect(sanitizeErrorMessage('relay 2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toContain(
      '[redacted-ip]',
    );
  });

  it('bounds very long upstream strings', () => {
    const long = 'x'.repeat(1000);
    const out = sanitizeErrorMessage(long);
    expect(out.length).toBeLessThanOrEqual(MAX_DETAIL_LEN);
  });

  it('returns empty for empty input', () => {
    expect(sanitizeErrorMessage('')).toBe('');
    expect(sanitizeErrorMessage(undefined)).toBe('');
  });
});

describe('classifyError', () => {
  it('extracts a typed prefix code', () => {
    expect(classifyError('hmac_required: worker configured')).toBe('hmac_required');
    expect(classifyError('turn_unavailable: no creds')).toBe('turn_unavailable');
  });

  it('recognizes common shapes without a prefix', () => {
    expect(classifyError('device is already mounted')).toBe('mount_already_present');
    expect(classifyError('fuse: device not found')).toBe('workspace_fuse_unavailable');
    expect(classifyError('operation timed out')).toBe('timeout');
  });

  it('falls back to unexpected_error', () => {
    expect(classifyError('something weird happened')).toBe('unexpected_error');
  });
});

describe('sanitizeProjectId', () => {
  it('strips whitespace/control chars and bounds length', () => {
    expect(sanitizeProjectId(' proj 123 ')).toBe('proj123');
    expect(sanitizeProjectId('a'.repeat(200))!.length).toBe(64);
  });
  it('maps empty to undefined', () => {
    expect(sanitizeProjectId('')).toBeUndefined();
    expect(sanitizeProjectId(undefined)).toBeUndefined();
  });
});

describe('newCorrelationId', () => {
  it('produces unique non-empty ids', () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe('LifecycleTimeline', () => {
  function capture(): { sink: (e: LogEvent) => void; events: LogEvent[] } {
    const events: LogEvent[] = [];
    return { sink: (e) => events.push(e), events };
  }

  it('binds every event to one correlation id and required schema fields', () => {
    const { sink, events } = capture();
    const tl = new LifecycleTimeline({
      projectId: 'projA',
      userId: 'alice@example.com',
      sink,
    });
    tl.event('web_api', 'sandbox.preview.received', 'ok');
    tl.setSandboxId('guac-alice-projA');
    tl.event('sandbox_identity', 'sandbox.preview.identity', 'ok');

    expect(events.length).toBe(2);
    for (const e of events) {
      expect(e.correlationId).toBe(tl.correlationId);
      expect(e.schemaVersion).toBe(LOG_SCHEMA_VERSION);
      expect(typeof e.ts).toBe('string');
      expect(new Date(e.ts).toISOString()).toBe(e.ts); // valid UTC ISO
      expect(e.projectId).toBe('projA');
      expect(e.userHash).toBe(safeUserHash('alice@example.com'));
      expect(e.outcome).toBe('ok');
    }
    // sandboxId only present after it is known.
    expect(events[0].sandboxId).toBeUndefined();
    expect(events[1].sandboxId).toBe('guac-alice-projA');
  });

  it('never leaks the raw user id into any event', () => {
    const { sink, events } = capture();
    const tl = new LifecycleTimeline({ userId: 'topsecretuser', sink });
    tl.event('web_api', 'x', 'ok');
    expect(JSON.stringify(events)).not.toContain('topsecretuser');
  });

  it('records a typed error code + sanitized detail on error outcomes', () => {
    const { sink, events } = capture();
    const tl = new LifecycleTimeline({ sink });
    tl.event('project_authorization', 'sandbox.preview.authorize', 'error', {
      error: 'hmac_signature_mismatch',
    });
    expect(events[0].errorCode).toBe('hmac_signature_mismatch');
    expect(events[0].outcome).toBe('error');
  });

  it('measures durationMs for a timed stage', () => {
    const { sink, events } = capture();
    const tl = new LifecycleTimeline({ sink });
    const done = tl.stage('workspace_mount', 'sandbox.preview.workspace_mount');
    done('ok');
    expect(typeof events[0].durationMs).toBe('number');
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sanitizes error material passed through a timed stage', () => {
    const { sink, events } = capture();
    const tl = new LifecycleTimeline({ sink });
    const done = tl.stage('preview_lifecycle', 'sandbox.preview.turn');
    done('error', 'turn_unavailable: cred=SECRETRELAYCRED at 203.0.113.9');
    const blob = JSON.stringify(events[0]);
    expect(blob).not.toContain('SECRETRELAYCRED');
    expect(blob).not.toContain('203.0.113.9');
    expect(events[0].errorCode).toBe('turn_unavailable');
  });
});

describe('createCollectingSink (additive telemetry harvesting, zero new tl.event call sites)', () => {
  it('still writes exactly what the default sink would have — console.log(JSON.stringify(event))', () => {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(String(args[0]));
    };
    try {
      const collected: LogEvent[] = [];
      const tl = new LifecycleTimeline({ correlationId: 'cid-1', sink: createCollectingSink(collected) });
      tl.event('web_api', 'sandbox.preview.received', 'ok');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ event: 'sandbox.preview.received', outcome: 'ok' });
    } finally {
      console.log = originalLog;
    }
  });

  it('ALSO accumulates every built event into the given array, in emission order', () => {
    const collected: LogEvent[] = [];
    const tl = new LifecycleTimeline({ correlationId: 'cid-2', sink: createCollectingSink(collected) });
    tl.event('web_api', 'sandbox.preview.received', 'ok');
    tl.event('project_authorization', 'sandbox.preview.authorize', 'error', { error: 'bad_token' });
    expect(collected).toHaveLength(2);
    expect(collected[0].event).toBe('sandbox.preview.received');
    expect(collected[1].event).toBe('sandbox.preview.authorize');
    expect(collected[1].errorCode).toBe('bad_token');
  });

  it('a fresh array passed to a second timeline stays independent (no shared mutable state)', () => {
    const a: LogEvent[] = [];
    const b: LogEvent[] = [];
    new LifecycleTimeline({ correlationId: 'cid-a', sink: createCollectingSink(a) }).event(
      'web_api',
      'sandbox.preview.received',
      'ok',
    );
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });
});
