/**
 * Package-local tests for the container boot-log retrieval contract
 * (`./neko-logs`), backing `POST /sandbox/:name/logs` (`handleNekoLogs` in
 * `./index`).
 *
 * The most important thing here is NOT that the helpers clamp numbers — it is
 * that the redaction pass actually removes the classes of content that really
 * do end up in `/tmp/neko.log`. `scripts/start-neko.sh` redirects Xvfb,
 * openbox, neko, code-server and Chromium stdout+stderr into that file
 * (`>>"$LOG" 2>&1` at five call sites), so the file is NOT limited to the
 * closed-vocabulary `[ezil-boot]` lines that script's own header describes.
 * Each redaction test below feeds a line shaped like real third-party output
 * and asserts what survives — not that a particular regex is present.
 *
 * HMAC gating is proven for the whole envelope by `./index.test.ts` and, at
 * the route table itself, by `./route-auth.test.ts` (which drives the REAL
 * `fetch()` entrypoint). This file additionally proves by static source
 * inspection that the logs route wires into that same envelope and that the
 * path it reads is a module constant, never anything from the request body.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const indexSource = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
const startNekoSource = readFileSync(
  fileURLToPath(new URL('../scripts/start-neko.sh', import.meta.url)),
  'utf8',
);

describe('neko-logs: the path is fixed by the container script, not by a caller', () => {
  it('NEKO_LOG_FILE equals `start-neko.sh`\'s own LOG= assignment', async () => {
    const { NEKO_LOG_FILE } = await import('./neko-logs');
    const m = /^LOG=(\S+)$/m.exec(startNekoSource);
    expect(m).not.toBeNull();
    expect(NEKO_LOG_FILE).toBe(m![1]);
  });

  it('handleNekoLogs reads the module constant and never a body field', () => {
    const body = indexSource.slice(
      indexSource.indexOf('async function handleNekoLogs('),
      indexSource.indexOf('* Twen workspace orchestration endpoint'),
    );
    expect(body.length).toBeGreaterThan(500);
    // Both shell commands are built from the constant.
    expect(body).toContain('nekoLogStatCommand(NEKO_LOG_FILE)');
    expect(body).toContain('nekoLogContentCommand(NEKO_LOG_FILE,');
    // The parsed body is only ever destructured for `token` and `maxLines`.
    expect(body).toContain('{ token?: string; maxLines?: number }');
    expect(/body\.(?!token\b|maxLines\b)\w+/.test(body)).toBe(false);
  });

  it('the route is HMAC-gated with the same envelope as every other sandbox route', () => {
    const body = indexSource.slice(
      indexSource.indexOf('async function handleNekoLogs('),
      indexSource.indexOf('* Twen workspace orchestration endpoint'),
    );
    expect(body).toContain('verifyPreviewToken(body.token, resolvePreviewSecrets(env))');
    expect(body).toContain('return json({ ok: false, error: auth.error }, 401);');
  });

  it('the route table gates on EZIL_NEKO_LOGS before reaching the handler', () => {
    const table = indexSource.slice(indexSource.indexOf("const nekoLogsMatch = path.match("));
    const block = table.slice(0, table.indexOf('const twenMatch'));
    expect(block).toContain('nekoLogsRouteDisabled(env.EZIL_NEKO_LOGS)');
    // The kill-switch check precedes the handler call.
    expect(block.indexOf('nekoLogsRouteDisabled')).toBeLessThan(block.indexOf('handleNekoLogs('));
  });

  it('the handler never puts raw exec stdout into the response body', () => {
    const body = indexSource.slice(
      indexSource.indexOf('async function handleNekoLogs('),
      indexSource.indexOf('* Twen workspace orchestration endpoint'),
    );
    // `contentRes.stdout` appears exactly once, as the argument to the redactor.
    const uses = body.match(/contentRes\.stdout/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(body).toContain('redactNekoLogContent(contentRes.stdout)');
    expect(body).toContain('const content = redactedLog.lines.join');
  });
});

describe('neko-logs: EZIL_NEKO_LOGS kill switch (default ON per contract §2)', () => {
  it('is NOT disabled by default (undefined/empty)', async () => {
    const { nekoLogsRouteDisabled } = await import('./neko-logs');
    expect(nekoLogsRouteDisabled(undefined)).toBe(false);
    expect(nekoLogsRouteDisabled('')).toBe(false);
    expect(nekoLogsRouteDisabled('on')).toBe(false);
  });

  it('is disabled for the same vocabulary SANDBOX_CPU_DIAG uses', async () => {
    const { nekoLogsRouteDisabled } = await import('./neko-logs');
    const { cpuDiagRouteDisabled } = await import('./cpu-diag');
    for (const v of ['off', 'FALSE', '0', ' disabled ', 'No', 'false', 'no']) {
      expect(nekoLogsRouteDisabled(v)).toBe(true);
      // Same shape, not merely a similar one.
      expect(nekoLogsRouteDisabled(v)).toBe(cpuDiagRouteDisabled(v));
    }
  });
});

describe('neko-logs: bounded reads', () => {
  it('defaults, clamps to the ceiling, and never returns <= 0', async () => {
    const m = await import('./neko-logs');
    expect(m.resolveNekoLogMaxLines(undefined)).toBe(m.NEKO_LOG_DEFAULT_MAX_LINES);
    expect(m.resolveNekoLogMaxLines('nonsense')).toBe(m.NEKO_LOG_DEFAULT_MAX_LINES);
    expect(m.resolveNekoLogMaxLines(0)).toBe(m.NEKO_LOG_DEFAULT_MAX_LINES);
    expect(m.resolveNekoLogMaxLines(-5)).toBe(m.NEKO_LOG_DEFAULT_MAX_LINES);
    expect(m.resolveNekoLogMaxLines(10)).toBe(10);
    expect(m.resolveNekoLogMaxLines(1e9)).toBe(m.NEKO_LOG_MAX_LINES_CEILING);
    expect(m.resolveNekoLogMaxLines(Infinity)).toBe(m.NEKO_LOG_DEFAULT_MAX_LINES);
  });

  it('the content command caps bytes BEFORE lines, and both are integers', async () => {
    const { nekoLogContentCommand } = await import('./neko-logs');
    const cmd = nekoLogContentCommand('/tmp/neko.log', 1024.7, 20.9);
    expect(cmd).toBe("tail -c 1024 '/tmp/neko.log' 2>/dev/null | tail -n 20");
    // Degenerate inputs still produce a bounded command, never an unbounded read.
    expect(nekoLogContentCommand('/tmp/neko.log', 0, 0)).toBe(
      "tail -c 1 '/tmp/neko.log' 2>/dev/null | tail -n 1",
    );
  });

  it('the stat command reports metadata without reading content', async () => {
    const { nekoLogStatCommand } = await import('./neko-logs');
    const cmd = nekoLogStatCommand('/tmp/neko.log');
    expect(cmd).toContain("wc -c < '/tmp/neko.log'");
    expect(cmd).toContain("wc -l < '/tmp/neko.log'");
    expect(cmd).not.toContain('cat ');
    expect(cmd).not.toContain('tail ');
  });

  it('parses the stat output, and reads "missing" as absent rather than throwing', async () => {
    const { parseNekoLogStatLines } = await import('./neko-logs');
    expect(parseNekoLogStatLines(['missing'])).toEqual({ exists: false, bytes: 0, totalLines: 0 });
    expect(parseNekoLogStatLines([])).toEqual({ exists: false, bytes: 0, totalLines: 0 });
    expect(parseNekoLogStatLines(['exists', '4096', '120'])).toEqual({
      exists: true,
      bytes: 4096,
      totalLines: 120,
    });
    // A torn/garbled count degrades to 0, never NaN in a JSON body.
    expect(parseNekoLogStatLines(['exists', 'x', 'y'])).toEqual({
      exists: true,
      bytes: 0,
      totalLines: 0,
    });
  });
});

// ── The part that actually matters ──────────────────────────────────────────
//
// These assert BEHAVIOUR on inputs shaped like the real third-party output
// that lands in `/tmp/neko.log`, not the presence of a regex.

describe('neko-logs: redaction of what actually reaches /tmp/neko.log', () => {
  it("does not leak a page URL from Chromium's console error line", async () => {
    const { redactNekoLogContent } = await import('./neko-logs');
    const raw =
      '[1234:1:0819/061500.123:ERROR:CONSOLE(1)] "Uncaught TypeError: x is not a function", ' +
      'source: https://app.example.com/dashboard?session=abc123 (1)';
    const { lines } = redactNekoLogContent(raw);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('app.example.com');
    expect(lines[0]).not.toContain('abc123');
    expect(lines[0]).toContain('<url>');
    // The diagnosis itself survives.
    expect(lines[0]).toContain('Uncaught TypeError');
  });

  it('does not leak an absolute workspace path from a code-server line', async () => {
    const { redactNekoLogContent } = await import('./neko-logs');
    const { lines } = redactNekoLogContent(
      '[2026-08-19T06:15:00.000Z] error Failed to open /home/user1/workspace/proj-1/src/index.ts',
    );
    expect(lines[0]).not.toContain('user1');
    expect(lines[0]).not.toContain('proj-1');
    expect(lines[0]).toContain('<path>');
    expect(lines[0]).toContain('Failed to open');
  });

  it('does not leak a TURN credential or a bearer token', async () => {
    const { redactNekoLogContent } = await import('./neko-logs');
    const { lines } = redactNekoLogContent(
      [
        'ice server credential=8f3a9b7c6d5e4f3a2b1c0d9e8f7a6b5c rejected',
        'authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
        'GET /api/login failed token=t=1755583200000,v1=deadbeefcafef00d',
      ].join('\n'),
    );
    const joined = lines.join('\n');
    expect(joined).not.toContain('8f3a9b7c6d5e4f3a2b1c0d9e8f7a6b5c');
    expect(joined).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(joined).not.toContain('deadbeefcafef00d');
  });

  it('does not leak an ICE candidate IP address', async () => {
    const { redactNekoLogContent } = await import('./neko-logs');
    const { lines } = redactNekoLogContent('candidate 203.0.113.42 port 51820 gathered');
    expect(lines[0]).not.toContain('203.0.113.42');
    expect(lines[0]).toContain('[redacted-ip]');
  });

  it('keeps a real `[ezil-boot]` phase line readable end to end', async () => {
    const { redactNekoLogContent } = await import('./neko-logs');
    const { lines } = redactNekoLogContent(
      '[ezil-boot] +21534ms phase=neko_serve_bind event=end status=error phase_ms=120034 cumulative_ms=21534',
    );
    expect(lines[0]).toBe(
      '[ezil-boot] +21534ms phase=neko_serve_bind event=end status=error phase_ms=120034 cumulative_ms=21534',
    );
  });

  it('preserves line structure — one input line in, one output line out', async () => {
    const { redactNekoLogContent } = await import('./neko-logs');
    const { lines } = redactNekoLogContent('alpha failed\nbravo failed\ncharlie failed');
    expect(lines).toEqual(['alpha failed', 'bravo failed', 'charlie failed']);
  });

  it('drops blank/whitespace-only lines rather than returning empty strings', async () => {
    const { redactNekoLogContent } = await import('./neko-logs');
    const { lines } = redactNekoLogContent('one\n\n   \n\ttwo\n');
    expect(lines).toEqual(['one', 'two']);
  });

  it('caps each line at the wire detail ceiling and counts the truncations', async () => {
    const m = await import('./neko-logs');
    const long = 'x'.repeat(500);
    const { lines, truncatedLines } = m.redactNekoLogContent(`${long}\nshort line\n${long}`);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveLength(m.NEKO_LOG_MAX_LINE_LEN);
    expect(lines[0].endsWith('…')).toBe(true);
    expect(lines[1]).toBe('short line');
    expect(truncatedLines).toBe(2);
  });

  it('is empty-safe (never throws, never returns undefined lines)', async () => {
    const { redactNekoLogContent } = await import('./neko-logs');
    expect(redactNekoLogContent(undefined)).toEqual({ lines: [], truncatedLines: 0 });
    expect(redactNekoLogContent(null)).toEqual({ lines: [], truncatedLines: 0 });
    expect(redactNekoLogContent('')).toEqual({ lines: [], truncatedLines: 0 });
  });

  it('uses the SAME redactor the telemetry `detail` column is written from', async () => {
    // Not a comment's promise: the outputs are compared directly, so a future
    // bespoke redactor here would go red.
    const { redactNekoLogContent } = await import('./neko-logs');
    const { sanitizeErrorMessage } = await import('./observability');
    for (const probe of [
      'boot failed at /home/u/workspace/p',
      'GET https://example.com/x?y=1 -> 500',
      'peer 10.0.0.7 unreachable',
    ]) {
      expect(redactNekoLogContent(probe).lines[0]).toBe(sanitizeErrorMessage(probe));
    }
  });
});

describe('neko-logs: measured against a REAL container boot', () => {
  // Verbatim excerpt of `/tmp/neko.log` from a live container run
  // (`docker run cf-guac-neko-test:local`, then `start-neko.sh`, 2026-08-19).
  // Transcribed with `\u001b` for the escape bytes; everything else is
  // byte-for-byte what the container wrote. This is the input the safety
  // argument in `./neko-logs.ts` is about — not an input invented to make the
  // redactor look good.
  const REAL_BOOT_EXCERPT = [
    '[start-neko] starting Xvfb on :99 (1920x1080x24)',
    '[start-neko] starting openbox (config /etc/neko/openbox.xml)',
    '[start-neko] starting neko on 0.0.0.0:8181 (pinned build, static=/var/www)',
    'E: [pulseaudio] core-util.c: Failed to connect to system bus: Failed to connect to socket /run/dbus/system_bus_socket: No such file or directory',
    '\u001b[90m7:25AM\u001b[0m \u001b[32mINF\u001b[0m \u001b[1mpreflight complete with config file\u001b[0m \u001b[36mconfig=\u001b[0m/etc/neko/neko.yaml \u001b[36mlog-level=\u001b[0minfo',
    '\u001b[90m7:25AM\u001b[0m \u001b[31mPNC\u001b[0m \u001b[1munable to connect to input driver\u001b[0m \u001b[36merror=\u001b[0m\u001b[31m\u001b[1m"dial unix /tmp/xf86-input-neko.sock: connect: no such file or directory"\u001b[0m\u001b[0m \u001b[36mmodule=\u001b[0mdesktop',
    'panic: unable to connect to input driver [recovered]',
    'github.com/m1k1o/neko/server/internal/desktop.(*DesktopManagerCtx).Start(0xc00033e340)',
    '\t/src/internal/desktop/manager.go:89 +0x356',
    '[start-neko] WARNING: neko did not open 8181 within timeout (see /tmp/neko.log)',
  ].join('\n');

  it('returns every line, none blank, none over the ceiling', async () => {
    const m = await import('./neko-logs');
    const { lines, truncatedLines } = m.redactNekoLogContent(REAL_BOOT_EXCERPT);
    expect(lines).toHaveLength(10);
    expect(truncatedLines).toBe(0);
    for (const l of lines) {
      expect(l.length).toBeGreaterThan(0);
      expect(l.length).toBeLessThanOrEqual(m.NEKO_LOG_MAX_LINE_LEN);
    }
  });

  it('no absolute path, no address and no terminal escape survives', async () => {
    const { redactNekoLogContent } = await import('./neko-logs');
    const out = redactNekoLogContent(REAL_BOOT_EXCERPT).lines.join('\n');
    for (const leak of [
      '/etc/neko/openbox.xml',
      '/etc/neko/neko.yaml',
      '/var/www',
      '/run/dbus/system_bus_socket',
      '/tmp/xf86-input-neko.sock',
      '/src/internal/desktop/manager.go',
      '0.0.0.0',
      '\u001b',
    ]) {
      expect(`${JSON.stringify(leak)} survived: ${out.includes(leak)}`).toBe(
        `${JSON.stringify(leak)} survived: false`,
      );
    }
  });

  it('…and the DIAGNOSIS survives, which is the only reason the route exists', async () => {
    const { redactNekoLogContent } = await import('./neko-logs');
    const out = redactNekoLogContent(REAL_BOOT_EXCERPT).lines.join('\n');
    // Every one of these is what a human reading this boot needs. If a future
    // redaction rule eats one of them, this route stops being worth having.
    expect(out).toContain('starting Xvfb on :99 (1920x1080x24)');
    expect(out).toContain('unable to connect to input driver');
    expect(out).toContain('panic: unable to connect to input driver [recovered]');
    expect(out).toContain('DesktopManagerCtx');
    expect(out).toContain(':89 +0x356'); // the frame's line number and offset
    expect(out).toContain('neko did not open 8181 within timeout');
    expect(out).toContain('log-level=info');
    // The zerolog level tokens are legible now that the colour codes are gone.
    expect(out).toContain('7:25AM PNC');
    expect(out).toContain('7:25AM INF');
  });
});

describe('neko-logs: stripTerminalControl', () => {
  it('removes SGR colour without touching the text it wrapped', async () => {
    const { stripTerminalControl } = await import('./neko-logs');
    expect(stripTerminalControl('\u001b[31mERROR\u001b[0m boom')).toBe('ERROR boom');
    expect(stripTerminalControl('\u001b[90m7:25AM\u001b[0m')).toBe('7:25AM');
  });

  it('turns stray C0 bytes into spaces rather than corrupting the JSON body', async () => {
    const { stripTerminalControl } = await import('./neko-logs');
    const out = stripTerminalControl('a\u0000b\u0007c');
    expect(out).toBe('a b c ');
    expect(JSON.stringify(out)).not.toContain('\\u00');
  });

  it('leaves an ordinary line completely alone (tabs included become spaces, nothing else)', async () => {
    const { stripTerminalControl } = await import('./neko-logs');
    expect(stripTerminalControl('[ezil-boot] +12ms phase=x event=start')).toBe(
      '[ezil-boot] +12ms phase=x event=start',
    );
  });

  it('runs BEFORE the redactor, so a colourised `password=` is still caught', async () => {
    const { redactNekoLogContent } = await import('./neko-logs');
    const out = redactNekoLogContent('\u001b[36mpassword=\u001b[0mhunter2 rejected').lines[0];
    expect(out).not.toContain('hunter2');
    expect(out).toContain('[redacted]');
  });
});

describe('neko-logs: the writers this route actually exposes are enumerated', () => {
  it('every `>>"$LOG"` / tee writer in start-neko.sh is a known third party', () => {
    // If a NEW process starts redirecting into $LOG, this goes red and whoever
    // added it has to think about what that process prints. The redaction pass
    // is per-line and content-agnostic, but the safety ARGUMENT is per-writer.
    const writers = [...startNekoSource.matchAll(/^\s*(\S+).*?(?:>>"\$LOG"|tee -a "\$LOG")/gm)].map(
      (m) => m[1],
    );
    const known = new Set(['log()', 'echo', 'if', 'Xvfb', 'openbox', 'setsid', '--capture.video.display']);
    for (const w of writers) expect(known.has(w)).toBe(true);
  });
});
