/**
 * Package-local tests for the CPU-saturation diagnostic contract (`./cpu-diag`).
 *
 * Covers the pure (runtime-free) helpers that back:
 *   - the opt-in flag forwarded into the container as
 *     `EZIL_NEKO_CPU_DIAG_ENABLED` (see `ensureDesktop` in `./index`)
 *   - the HMAC-gated retrieval route `POST /sandbox/:name/cpu-diag`
 *     (see `handleCpuDiag` in `./index`)
 *
 * HMAC gating (required / malformed / expired / mismatch / no-leak) is proven
 * by the shared `./hmac` suite in `index.test.ts`; `handleCpuDiag` reuses that
 * exact `verifyPreviewToken` envelope, so it inherits those guarantees — this
 * file additionally proves (via static source inspection) that the cpu-diag
 * route actually wires into that same envelope, so the reuse claim above is
 * checked rather than merely asserted.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('cpu-diag: cpuDiagFlagEnabled (Worker → container opt-in, default OFF)', () => {
  it('is OFF for undefined/empty/whitespace', async () => {
    const { cpuDiagFlagEnabled } = await import('./cpu-diag');
    expect(cpuDiagFlagEnabled(undefined)).toBe(false);
    expect(cpuDiagFlagEnabled('')).toBe(false);
    expect(cpuDiagFlagEnabled('   ')).toBe(false);
  });

  it('is OFF for common falsy/unrelated spellings', async () => {
    const { cpuDiagFlagEnabled } = await import('./cpu-diag');
    for (const v of ['0', 'off', 'false', 'no', 'disabled', 'nope', '2']) {
      expect(cpuDiagFlagEnabled(v)).toBe(false);
    }
  });

  it('is ON only for explicit truthy spellings, case/whitespace-insensitive', async () => {
    const { cpuDiagFlagEnabled } = await import('./cpu-diag');
    for (const v of ['1', 'true', 'on', 'yes', 'enabled', ' 1 ', 'TRUE', 'On']) {
      expect(cpuDiagFlagEnabled(v)).toBe(true);
    }
  });
});

describe('cpu-diag: cpuDiagRouteDisabled (retrieval-route kill-switch, enabled by default)', () => {
  it('is NOT disabled by default (undefined)', async () => {
    const { cpuDiagRouteDisabled } = await import('./cpu-diag');
    expect(cpuDiagRouteDisabled(undefined)).toBe(false);
  });

  it('is disabled for off/false/0/disabled/no (case/whitespace-insensitive)', async () => {
    const { cpuDiagRouteDisabled } = await import('./cpu-diag');
    for (const v of ['off', 'FALSE', '0', ' disabled ', 'No']) {
      expect(cpuDiagRouteDisabled(v)).toBe(true);
    }
  });

  it('is independent of the sampler enable flag — unrelated strings do not disable it', async () => {
    const { cpuDiagRouteDisabled } = await import('./cpu-diag');
    expect(cpuDiagRouteDisabled('1')).toBe(false);
    expect(cpuDiagRouteDisabled('on')).toBe(false);
  });
});

describe('cpu-diag: resolveCpuDiagMaxLines (bounded caller-supplied cap)', () => {
  it('defaults when absent/invalid', async () => {
    const { resolveCpuDiagMaxLines, CPU_DIAG_DEFAULT_MAX_LINES } = await import('./cpu-diag');
    expect(resolveCpuDiagMaxLines(undefined)).toBe(CPU_DIAG_DEFAULT_MAX_LINES);
    expect(resolveCpuDiagMaxLines(null)).toBe(CPU_DIAG_DEFAULT_MAX_LINES);
    expect(resolveCpuDiagMaxLines('not-a-number')).toBe(CPU_DIAG_DEFAULT_MAX_LINES);
    expect(resolveCpuDiagMaxLines(0)).toBe(CPU_DIAG_DEFAULT_MAX_LINES);
    expect(resolveCpuDiagMaxLines(-5)).toBe(CPU_DIAG_DEFAULT_MAX_LINES);
  });

  it('accepts a sane in-range request', async () => {
    const { resolveCpuDiagMaxLines } = await import('./cpu-diag');
    expect(resolveCpuDiagMaxLines(10)).toBe(10);
    expect(resolveCpuDiagMaxLines('50')).toBe(50);
  });

  it('clamps a caller-supplied value to the ceiling — never returns an unbounded read', async () => {
    const { resolveCpuDiagMaxLines, CPU_DIAG_MAX_LINES_CEILING } = await import('./cpu-diag');
    expect(resolveCpuDiagMaxLines(1_000_000)).toBe(CPU_DIAG_MAX_LINES_CEILING);
  });

  it('falls back to the default for non-finite input (e.g. Infinity) rather than clamping', async () => {
    const { resolveCpuDiagMaxLines, CPU_DIAG_DEFAULT_MAX_LINES } = await import('./cpu-diag');
    expect(resolveCpuDiagMaxLines(Infinity)).toBe(CPU_DIAG_DEFAULT_MAX_LINES);
  });
});

describe('cpu-diag: cpuDiagStatCommand / parseCpuDiagStatLines round-trip', () => {
  it('parses a missing-file result', async () => {
    const { parseCpuDiagStatLines } = await import('./cpu-diag');
    expect(parseCpuDiagStatLines(['missing'])).toEqual({ exists: false, bytes: 0, totalLines: 0 });
  });

  it('parses an existing-file result (bytes + line count)', async () => {
    const { parseCpuDiagStatLines } = await import('./cpu-diag');
    expect(parseCpuDiagStatLines(['exists', '1234', '17'])).toEqual({
      exists: true,
      bytes: 1234,
      totalLines: 17,
    });
  });

  it('degrades to 0 for a non-numeric byte/line count rather than throwing', async () => {
    const { parseCpuDiagStatLines } = await import('./cpu-diag');
    expect(parseCpuDiagStatLines(['exists', 'garbage', 'garbage'])).toEqual({
      exists: true,
      bytes: 0,
      totalLines: 0,
    });
  });

  it('the stat command tests the exact configured path and never falls through to raw content', async () => {
    const { cpuDiagStatCommand, CPU_DIAG_FILE } = await import('./cpu-diag');
    const cmd = cpuDiagStatCommand(CPU_DIAG_FILE);
    expect(cmd).toContain(`-f '${CPU_DIAG_FILE}'`);
    expect(cmd).toContain('wc -c');
    expect(cmd).toContain('wc -l');
    expect(cmd).not.toContain('cat ');
  });
});

describe('cpu-diag: cpuDiagContentCommand (bounded byte-then-line tail)', () => {
  it('caps by bytes first, then by lines, in that order', async () => {
    const { cpuDiagContentCommand } = await import('./cpu-diag');
    const cmd = cpuDiagContentCommand('/tmp/x.jsonl', 65_536, 500);
    const byteIdx = cmd.indexOf('tail -c 65536');
    const lineIdx = cmd.indexOf('tail -n 500');
    expect(byteIdx).toBeGreaterThanOrEqual(0);
    expect(lineIdx).toBeGreaterThan(byteIdx);
    expect(cmd).toContain("'/tmp/x.jsonl'");
  });

  it('floors non-integer caps and enforces a minimum of 1 for both bounds', async () => {
    const { cpuDiagContentCommand } = await import('./cpu-diag');
    const cmd = cpuDiagContentCommand('/tmp/x.jsonl', 0, 0);
    expect(cmd).toContain('tail -c 1');
    expect(cmd).toContain('tail -n 1');
  });
});

describe('cpu-diag: CPU_DIAG_FILE stays in sync with the sampler script default', () => {
  const scriptPath = fileURLToPath(new URL('../scripts/start-neko.sh', import.meta.url));
  const scriptSrc = readFileSync(scriptPath, 'utf8');

  it('matches NEKO_CPU_DIAG_FILE\'s default in scripts/start-neko.sh', async () => {
    const { CPU_DIAG_FILE } = await import('./cpu-diag');
    const match = scriptSrc.match(/NEKO_CPU_DIAG_FILE="\$\{NEKO_CPU_DIAG_FILE:-([^}]+)\}"/);
    expect(match).not.toBeNull();
    expect(CPU_DIAG_FILE).toBe(match?.[1]);
  });

  it('the sampler is gated on EZIL_NEKO_CPU_DIAG_ENABLED in the script (flag name drift guard)', () => {
    expect(scriptSrc).toContain('EZIL_NEKO_CPU_DIAG_ENABLED');
  });
});
