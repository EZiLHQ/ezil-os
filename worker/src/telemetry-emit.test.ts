/**
 * REAL execution test for `emit_telemetry()` / `phase_end()` in
 * `scripts/start-neko.sh` — not a source-text grep.
 *
 * The boot-phase logging block (`BOOT_T0_MS` through `emit_telemetry`'s
 * closing brace) is entirely self-contained: it depends only on `$LOG`
 * (a plain path) and shell builtins, never on Xvfb/neko/code-server/Chrome
 * being available. So it is extracted verbatim and sourced into a throwaway
 * script, pointed at temp files, and actually run — proving the NDJSON file
 * `drainContainerBootTelemetry` (`./index.ts`) later reads is real bytes on
 * disk, not just a source-text pattern this file's static-assertion tests
 * would equally pass for a typo'd, never-executed line.
 *
 * Host requirements: bash only. No Docker, no X server, no neko binary —
 * same class of test as `neko-teardown-orphans.test.ts`'s own doc comment.
 *
 * MEASURED, and that comment is wrong: the block opens with
 * `BOOT_T0_MS="$(date +%s%3N)"`, and `%3N` (milliseconds) is a GNU `date`
 * extension — BSD/macOS `date` has no `%N` at all, so `BOOT_T0_MS` is not a
 * clean integer there and every downstream `phase_end` duration computed
 * from it is unreliable. PR #14 eighth run: 7 of this file's 8 tests failed
 * on macOS for that reason. The 8th, `BOTH-DIRECTIONS: removing the
 * emit_telemetry call…`, only asserts that the NDJSON file was NOT created —
 * true whether the mutated script exits cleanly or aborts on bad arithmetic
 * — so it is genuinely OS-agnostic and stays running (ORCHESTRATION-LOG.md,
 * row M3).
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Why the real-NDJSON-content tests below may not run here. `null` means
 *  they CAN. Same idiom as `./browser-sidecar.container.test.ts`'s
 *  `SKIP_REASON`. The BOTH-DIRECTIONS test at the end does not use this. */
const LINUX_ONLY_REASON = process.platform === 'linux'
    ? null
    : `the boot-phase-logging block opens with `
    + `\`date +%s%3N\` — %N (milliseconds) is a GNU date extension, absent on ${process.platform}; `
    + `not meaningful there`;

if (LINUX_ONLY_REASON) {
    console.warn(
        `\n${'='.repeat(78)}\n`
        + `SKIPPING 7 of 8 tests in the telemetry-emit suite: ${LINUX_ONLY_REASON}.\n`
        + `${'='.repeat(78)}\n`,
    );
}

const itIf = LINUX_ONLY_REASON ? it.skip : it;

const START_NEKO_PATH = join(import.meta.dir, '..', 'scripts', 'start-neko.sh');
const START_MARKER = 'BOOT_T0_MS="$(date +%s%3N)"';
const END_MARKER = 'phase_start container_start';

/** Slice out the self-contained boot-phase-logging block, verbatim. */
function extractTelemetryBlock(): string {
  const src = readFileSync(START_NEKO_PATH, 'utf8');
  const start = src.indexOf(START_MARKER);
  const end = src.indexOf(END_MARKER, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('could not locate the boot-phase-logging block in start-neko.sh — markers moved?');
  }
  return src.slice(start, end);
}

/** Run the extracted block plus a driver script under real bash; returns the NDJSON file's lines. */
function runAndReadTelemetry(driver: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'ezil-telemetry-emit-'));
  const logPath = join(dir, 'neko.log');
  const ndjsonPath = join(dir, 'ezil-telemetry.ndjson');
  const script = [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    `LOG=${JSON.stringify(logPath)}`,
    extractTelemetryBlock(),
    driver,
  ].join('\n');
  const scriptPath = join(dir, 'driver.sh');
  writeFileSync(scriptPath, script, 'utf8');

  try {
    const result = spawnSync('bash', [scriptPath], {
      env: { ...process.env, EZIL_TELEMETRY_NDJSON_PATH: ndjsonPath },
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (result.status !== 0) {
      throw new Error(`driver script exited ${result.status}: ${result.stderr}`);
    }
    if (!existsSync(ndjsonPath)) return [];
    return readFileSync(ndjsonPath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('emit_telemetry() / phase_end() in scripts/start-neko.sh — real bash execution', () => {
  itIf('writes one boot_phase NDJSON line per successful (non-"ready") phase', () => {
    const lines = runAndReadTelemetry('phase_start xvfb\nphase_end xvfb ok\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(row).toMatchObject({
      eventClass: 'boot_phase',
      source: 'container',
      site: 'xvfb',
      code: 'ok',
      outcome: 'ok',
    });
    expect(typeof row.durationMs).toBe('number');
  });

  itIf('writes outcome=error (never silently "ok") for a failed phase', () => {
    const lines = runAndReadTelemetry('phase_start codeserver_launch\nphase_end codeserver_launch error\n');
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(row.outcome).toBe('error');
    expect(row.code).toBe('error');
    expect(row.eventClass).toBe('boot_phase');
  });

  itIf('writes outcome=skipped for a skipped phase (e.g. workspace_hydration with no delivery)', () => {
    const lines = runAndReadTelemetry('phase_start workspace_hydration\nphase_end workspace_hydration skipped\n');
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(row.outcome).toBe('skipped');
  });

  itIf('classifies the "ready" phase as boot_summary — the denominator every other query divides by', () => {
    const lines = runAndReadTelemetry('phase_end ready ok\n');
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(row.eventClass).toBe('boot_summary');
    expect(row.site).toBe('ready');
    expect(row.outcome).toBe('ok');
  });

  itIf('emits the boot_summary on a FAILED ready too — success and failure both reach the file', () => {
    const lines = runAndReadTelemetry('phase_end ready error\n');
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(row.eventClass).toBe('boot_summary');
    expect(row.outcome).toBe('error');
  });

  itIf('appends one line per phase_end call, preserving order across a real multi-phase boot', () => {
    const lines = runAndReadTelemetry(
      ['phase_start xvfb', 'phase_end xvfb ok', 'phase_start openbox', 'phase_end openbox ok', 'phase_end ready ok'].join(
        '\n',
      ),
    );
    expect(lines).toHaveLength(3);
    const sites = lines.map((l) => (JSON.parse(l) as Record<string, unknown>).site);
    expect(sites).toEqual(['xvfb', 'openbox', 'ready']);
  });

  itIf('never fails the boot when the NDJSON path is unwritable (|| true)', () => {
    // Point at a directory that does not exist and is never created — the
    // append must fail silently, and the driver script itself must still
    // exit 0 (a broken telemetry sink must never fail a boot).
    const dir = mkdtempSync(join(tmpdir(), 'ezil-telemetry-emit-unwritable-'));
    const logPath = join(dir, 'neko.log');
    const script = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      `LOG=${JSON.stringify(logPath)}`,
      extractTelemetryBlock(),
      'phase_start xvfb',
      'phase_end xvfb ok',
      'echo DRIVER_REACHED_END',
    ].join('\n');
    const scriptPath = join(dir, 'driver.sh');
    writeFileSync(scriptPath, script, 'utf8');
    try {
      const result = spawnSync('bash', [scriptPath], {
        env: { ...process.env, EZIL_TELEMETRY_NDJSON_PATH: '/nonexistent-dir-for-test/ezil-telemetry.ndjson' },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('DRIVER_REACHED_END');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('BOTH-DIRECTIONS: removing the emit_telemetry call from phase_end leaves the file empty', () => {
    const block = extractTelemetryBlock().replace('emit_telemetry "$name" "$status" "$dur"\n', '');
    expect(block).not.toContain('emit_telemetry "$name" "$status" "$dur"');
    const dir = mkdtempSync(join(tmpdir(), 'ezil-telemetry-emit-mutated-'));
    const logPath = join(dir, 'neko.log');
    const ndjsonPath = join(dir, 'ezil-telemetry.ndjson');
    const script = ['#!/usr/bin/env bash', 'set -uo pipefail', `LOG=${JSON.stringify(logPath)}`, block, 'phase_start xvfb\nphase_end xvfb ok\n'].join(
      '\n',
    );
    const scriptPath = join(dir, 'driver.sh');
    writeFileSync(scriptPath, script, 'utf8');
    try {
      spawnSync('bash', [scriptPath], {
        env: { ...process.env, EZIL_TELEMETRY_NDJSON_PATH: ndjsonPath },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(existsSync(ndjsonPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
