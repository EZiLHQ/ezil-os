/**
 * Unit tests for the pure control-surface helpers in `./sandbox-control`.
 *
 * These cover the DECISIONS; `./route-auth.test.ts` covers the WIRING by
 * driving the Worker's real `fetch()` route table end to end.
 */

import { describe, expect, it } from 'bun:test';

describe('extractSignedToken (where a control request may carry the shared HMAC token)', () => {
  it('reads `Authorization: Bearer <token>` — the only option for a body-less DELETE', async () => {
    const { extractSignedToken } = await import('./sandbox-control');
    expect(extractSignedToken({ authorization: 'Bearer t=123,v1=abcd' })).toBe('t=123,v1=abcd');
  });

  it('matches the Bearer scheme case-insensitively (RFC 7235) without touching the token', async () => {
    const { extractSignedToken } = await import('./sandbox-control');
    expect(extractSignedToken({ authorization: 'bearer t=1,v1=AbCd' })).toBe('t=1,v1=AbCd');
    expect(extractSignedToken({ authorization: 'BEARER   t=1,v1=AbCd  ' })).toBe('t=1,v1=AbCd');
  });

  it('ignores a non-Bearer Authorization header rather than passing garbage to the verifier', async () => {
    const { extractSignedToken } = await import('./sandbox-control');
    expect(extractSignedToken({ authorization: 'Basic dXNlcjpwdw==' })).toBeUndefined();
    expect(extractSignedToken({ authorization: 'Bearer' })).toBeUndefined();
    expect(extractSignedToken({ authorization: 'Bearer    ' })).toBeUndefined();
  });

  it('falls back to `?token=` — the existing /preview-bootstrap precedent', async () => {
    const { extractSignedToken } = await import('./sandbox-control');
    expect(extractSignedToken({ query: 't=9,v1=ff' })).toBe('t=9,v1=ff');
  });

  it('falls back to a JSON body `{token}` — the envelope every POST route already accepts', async () => {
    const { extractSignedToken } = await import('./sandbox-control');
    expect(extractSignedToken({ body: { token: 't=7,v1=ee' } })).toBe('t=7,v1=ee');
  });

  it('prefers the header over the query over the body', async () => {
    const { extractSignedToken } = await import('./sandbox-control');
    expect(
      extractSignedToken({ authorization: 'Bearer HEADER', query: 'QUERY', body: { token: 'BODY' } }),
    ).toBe('HEADER');
    expect(extractSignedToken({ query: 'QUERY', body: { token: 'BODY' } })).toBe('QUERY');
  });

  it('returns undefined when no source carries a token (so verification fails closed)', async () => {
    const { extractSignedToken } = await import('./sandbox-control');
    expect(extractSignedToken({})).toBeUndefined();
    expect(extractSignedToken({ authorization: null, query: null, body: undefined })).toBeUndefined();
    expect(extractSignedToken({ body: {} })).toBeUndefined();
    expect(extractSignedToken({ body: { token: '   ' } })).toBeUndefined();
    expect(extractSignedToken({ body: { token: 42 } })).toBeUndefined();
    expect(extractSignedToken({ body: ['t=1,v1=aa'] })).toBeUndefined();
    expect(extractSignedToken({ body: null })).toBeUndefined();
  });
});

describe('buildTerminateReport (a success response for an action that did not happen is worse than an error)', () => {
  it('reports terminated only when a running container was observed BEFORE and gone AFTER', async () => {
    const { buildTerminateReport } = await import('./sandbox-control');
    expect(buildTerminateReport({ wasRunning: true, runningAfter: false })).toEqual({
      ok: true,
      terminated: true,
      stopped: true,
      outcome: 'destroyed',
      wasRunning: true,
      runningAfter: false,
    });
  });

  it('NEVER reports terminated for a name that had nothing running — the live wrong-name case', async () => {
    const { buildTerminateReport } = await import('./sandbox-control');
    const report = buildTerminateReport({ wasRunning: false, runningAfter: false });
    expect(report.terminated).toBe(false);
    expect(report.outcome).toBe('not_running');
    // The postcondition still holds, so this is not an error…
    expect(report.ok).toBe(true);
    expect(report.stopped).toBe(true);
  });

  it('is an ERROR when the container is still running after destroy()', async () => {
    const { buildTerminateReport } = await import('./sandbox-control');
    const report = buildTerminateReport({ wasRunning: true, runningAfter: true });
    expect(report.ok).toBe(false);
    expect(report.terminated).toBe(false);
    expect(report.stopped).toBe(false);
    expect(report.outcome).toBe('still_running');
    expect(report.error).toBe('container_still_running_after_destroy');
  });

  it('surfaces a throwing destroy() as destroy_failed, never as success', async () => {
    const { buildTerminateReport } = await import('./sandbox-control');
    const report = buildTerminateReport({
      wasRunning: true,
      runningAfter: false,
      destroyError: 'control plane unreachable',
    });
    expect(report.ok).toBe(false);
    expect(report.terminated).toBe(false);
    expect(report.outcome).toBe('destroy_failed');
    expect(report.error).toBe('control plane unreachable');
  });

  it('treats a blank destroyError as no error (never invents a failure)', async () => {
    const { buildTerminateReport } = await import('./sandbox-control');
    expect(buildTerminateReport({ wasRunning: true, runningAfter: false, destroyError: '  ' }).ok).toBe(true);
  });
});

describe('describeDesktopStatus (the /status confirmation signal)', () => {
  it('reports a NEKO desktop as running when 8181 is exposed and the caller omitted desktopMode', async () => {
    const { describeDesktopStatus } = await import('./sandbox-control');
    // This is the exact live defect: a neko desktop streaming video answered
    // {"guacamoleRunning":false,"mode":"guacamole"} because the mode was
    // defaulted instead of detected.
    const status = describeDesktopStatus([{ port: 8181 }, { port: 3002 }], undefined, 'guacamole');
    expect(status.mode).toBe('neko');
    expect(status.modeSource).toBe('detected');
    expect(status.guacamoleRunning).toBe(true);
    expect(status.desktopRunning).toBe(true);
    expect(status.runningModes).toEqual(['neko']);
  });

  it('still reports a guacamole desktop correctly (Phase 1 non-regression)', async () => {
    const { describeDesktopStatus } = await import('./sandbox-control');
    const status = describeDesktopStatus([{ port: 8080 }], undefined, 'guacamole');
    expect(status.mode).toBe('guacamole');
    expect(status.modeSource).toBe('detected');
    expect(status.guacamoleRunning).toBe(true);
    expect(status.runningModes).toEqual(['guacamole']);
  });

  it('answers an EXPLICIT ?desktopMode= literally — asking about guacamole on a neko box says false', async () => {
    const { describeDesktopStatus } = await import('./sandbox-control');
    const status = describeDesktopStatus([{ port: 8181 }], 'guacamole', 'guacamole');
    expect(status.mode).toBe('guacamole');
    expect(status.modeSource).toBe('requested');
    expect(status.guacamoleRunning).toBe(false);
    // …but a desktop IS up, and the additive fields say which.
    expect(status.desktopRunning).toBe(true);
    expect(status.runningModes).toEqual(['neko']);
  });

  it('falls back to the resolved default only when nothing is running', async () => {
    const { describeDesktopStatus } = await import('./sandbox-control');
    const status = describeDesktopStatus([], undefined, 'neko');
    expect(status.mode).toBe('neko');
    expect(status.modeSource).toBe('default');
    expect(status.guacamoleRunning).toBe(false);
    expect(status.desktopRunning).toBe(false);
    expect(status.runningModes).toEqual([]);
  });

  it('prefers the configured default when BOTH desktops are somehow exposed (stable reporting)', async () => {
    const { describeDesktopStatus } = await import('./sandbox-control');
    const status = describeDesktopStatus([{ port: 8080 }, { port: 8181 }], undefined, 'neko');
    expect(status.mode).toBe('neko');
    expect(status.runningModes).toEqual(['guacamole', 'neko']);
    expect(status.guacamoleRunning).toBe(true);
  });

  it('ignores non-desktop ports (the app-preview port never confirms a desktop)', async () => {
    const { describeDesktopStatus } = await import('./sandbox-control');
    const status = describeDesktopStatus([{ port: 3002 }], undefined, 'neko');
    expect(status.desktopRunning).toBe(false);
    expect(status.guacamoleRunning).toBe(false);
    expect(status.modeSource).toBe('default');
  });

  it('derives the ports from portFor() rather than hardcoding them', async () => {
    const { describeDesktopStatus } = await import('./sandbox-control');
    const { portFor } = await import('./desktop-mode');
    for (const mode of ['guacamole', 'neko'] as const) {
      const status = describeDesktopStatus([{ port: portFor(mode).port }], undefined, mode);
      expect(status.runningModes).toContain(mode);
      expect(status.guacamoleRunning).toBe(true);
    }
  });
});
