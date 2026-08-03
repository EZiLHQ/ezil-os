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

describe('validateFocusApp (POST /sandbox/:id/focus — a closed enum, never a free string)', () => {
  it('accepts the exact enum values', async () => {
    const { validateFocusApp } = await import('./sandbox-control');
    expect(validateFocusApp('vscode')).toEqual({ ok: true, app: 'vscode' });
    expect(validateFocusApp('chromium')).toEqual({ ok: true, app: 'chromium' });
  });

  it('trims surrounding whitespace before matching', async () => {
    const { validateFocusApp } = await import('./sandbox-control');
    expect(validateFocusApp('  vscode  ')).toEqual({ ok: true, app: 'vscode' });
  });

  it('rejects an unknown app name rather than passing it through', async () => {
    const { validateFocusApp } = await import('./sandbox-control');
    const result = validateFocusApp('firefox');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('invalid_focus_app');
  });

  it('rejects a shell-metacharacter injection attempt', async () => {
    const { validateFocusApp } = await import('./sandbox-control');
    const result = validateFocusApp('vscode; rm -rf /');
    expect(result.ok).toBe(false);
  });

  it('rejects non-string input (missing field, number, object, array)', async () => {
    const { validateFocusApp } = await import('./sandbox-control');
    for (const bad of [undefined, null, 42, {}, ['vscode']]) {
      const result = validateFocusApp(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('focus_app_missing_or_not_a_string');
    }
  });

  it('is case-sensitive (no silent normalization of casing)', async () => {
    const { validateFocusApp } = await import('./sandbox-control');
    expect(validateFocusApp('VSCode').ok).toBe(false);
  });
});

describe('buildFocusAppCommand', () => {
  it('builds the exact neko-switch-app.sh invocation for each enum value', async () => {
    const { buildFocusAppCommand } = await import('./sandbox-control');
    expect(buildFocusAppCommand('vscode')).toBe('/usr/local/bin/neko-switch-app.sh vscode');
    expect(buildFocusAppCommand('chromium')).toBe('/usr/local/bin/neko-switch-app.sh chromium');
  });
});

describe('focusDisabled (kill switch for POST /sandbox/:id/focus)', () => {
  it('is enabled (not disabled) by default — unset/undefined', async () => {
    const { focusDisabled } = await import('./sandbox-control');
    expect(focusDisabled(undefined)).toBe(false);
    expect(focusDisabled('')).toBe(false);
  });

  it('recognizes every documented disable spelling, case-insensitively', async () => {
    const { focusDisabled } = await import('./sandbox-control');
    for (const spelling of ['off', 'OFF', 'false', '0', 'disabled', 'no', '  off  ']) {
      expect(focusDisabled(spelling)).toBe(true);
    }
  });

  it('treats any other value as enabled (not disabled)', async () => {
    const { focusDisabled } = await import('./sandbox-control');
    expect(focusDisabled('on')).toBe(false);
    expect(focusDisabled('true')).toBe(false);
    expect(focusDisabled('1')).toBe(false);
  });
});

describe('restartDisabled (kill switch for POST /sandbox/:id/restart)', () => {
  it('is enabled (not disabled) by default — unset/undefined', async () => {
    const { restartDisabled } = await import('./sandbox-control');
    expect(restartDisabled(undefined)).toBe(false);
    expect(restartDisabled('')).toBe(false);
  });

  it('recognizes every documented disable spelling, case-insensitively', async () => {
    const { restartDisabled } = await import('./sandbox-control');
    for (const spelling of ['off', 'OFF', 'false', '0', 'disabled', 'no', '  off  ']) {
      expect(restartDisabled(spelling)).toBe(true);
    }
  });

  it('treats any other value as enabled (not disabled)', async () => {
    const { restartDisabled } = await import('./sandbox-control');
    expect(restartDisabled('on')).toBe(false);
    expect(restartDisabled('true')).toBe(false);
  });
});

describe('findDesktopLauncherProcess (locating the tracked start-desktop.sh launcher)', () => {
  it('finds a running launcher by its exact command path', async () => {
    const { findDesktopLauncherProcess } = await import('./sandbox-control');
    const processes = [
      { id: 'p1', command: 'DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh', status: 'running' },
    ];
    expect(findDesktopLauncherProcess(processes)?.id).toBe('p1');
  });

  it('also matches a "starting" launcher (not yet confirmed running)', async () => {
    const { findDesktopLauncherProcess } = await import('./sandbox-control');
    const processes = [
      { id: 'p1', command: 'DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh', status: 'starting' },
    ];
    expect(findDesktopLauncherProcess(processes)?.id).toBe('p1');
  });

  it('ignores a launcher that already exited (completed/killed/failed/error)', async () => {
    const { findDesktopLauncherProcess } = await import('./sandbox-control');
    for (const status of ['completed', 'killed', 'failed', 'error']) {
      const processes = [{ id: 'p1', command: 'bash /usr/local/bin/start-desktop.sh', status }];
      expect(findDesktopLauncherProcess(processes)).toBeUndefined();
    }
  });

  it('ignores unrelated processes (e.g. the dev-server launcher) even when running', async () => {
    const { findDesktopLauncherProcess } = await import('./sandbox-control');
    const processes = [{ id: 'p1', command: 'bash /usr/local/bin/start-devserver.sh', status: 'running' }];
    expect(findDesktopLauncherProcess(processes)).toBeUndefined();
  });

  it('returns undefined for an empty process list', async () => {
    const { findDesktopLauncherProcess } = await import('./sandbox-control');
    expect(findDesktopLauncherProcess([])).toBeUndefined();
  });
});

describe('buildRestartReport (honest restart reporting — same discipline as buildTerminateReport)', () => {
  it('reports "restarted" when a launcher was running, confirmed stopped, and the fresh boot came up', async () => {
    const { buildRestartReport } = await import('./sandbox-control');
    const report = buildRestartReport({ mode: 'neko', wasRunning: true, stopConfirmed: true, bootOk: true });
    expect(report).toEqual({
      ok: true,
      mode: 'neko',
      outcome: 'restarted',
      wasRunning: true,
      stopConfirmed: true,
      bootOk: true,
    });
  });

  it('reports "started" (idempotent start) when nothing was running and the fresh boot came up', async () => {
    const { buildRestartReport } = await import('./sandbox-control');
    const report = buildRestartReport({ mode: 'neko', wasRunning: false, stopConfirmed: true, bootOk: true });
    expect(report.ok).toBe(true);
    expect(report.outcome).toBe('started');
  });

  it('FAILS LOUD with "stop_timed_out" — and never claims bootOk — when a running launcher did not confirm stopped', async () => {
    const { buildRestartReport } = await import('./sandbox-control');
    const report = buildRestartReport({ mode: 'neko', wasRunning: true, stopConfirmed: false, bootOk: true });
    expect(report.ok).toBe(false);
    expect(report.outcome).toBe('stop_timed_out');
    expect(report.bootOk).toBe(false); // never half-restart: bootOk is forced false, the boot must be skipped
    expect(report.error).toBeTruthy();
  });

  it('reports "boot_failed" when the stop was confirmed (or nothing needed stopping) but the boot did not become ready', async () => {
    const { buildRestartReport } = await import('./sandbox-control');
    const report = buildRestartReport({
      mode: 'neko',
      wasRunning: true,
      stopConfirmed: true,
      bootOk: false,
      bootError: 'desktop_failed_to_start: timeout',
    });
    expect(report.ok).toBe(false);
    expect(report.outcome).toBe('boot_failed');
    expect(report.error).toBe('desktop_failed_to_start: timeout');
  });

  it('falls back to a generic error string when boot_failed carries no detail', async () => {
    const { buildRestartReport } = await import('./sandbox-control');
    const report = buildRestartReport({ mode: 'neko', wasRunning: false, stopConfirmed: true, bootOk: false });
    expect(report.error).toBe('boot_failed');
  });
});
