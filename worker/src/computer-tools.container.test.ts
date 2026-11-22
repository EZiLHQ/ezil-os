/**
 * toolsd against the REAL image — the section 3.5 auth wall, the uid-7001
 * privilege drop, and a valid signed round trip, all inside the container built
 * from `worker/Dockerfile`.
 *
 * ── Skip condition ───────────────────────────────────────────────────────────
 * This suite needs the integrated image with toolsd COPY'd to `/opt/ezil-toolsd`
 * (a `worker/Dockerfile` step the lane lead adds after this worker reports).
 * Docker absent, the image absent, or an image that predates `/opt/ezil-toolsd`
 * are all LOUD skips naming the command that fixes them — never passes. A
 * container that boots and then misbehaves is a FAILURE: at that point the
 * artifact under test was present and the answer is genuinely bad news.
 *
 * Unlike the browser sidecar suite, this one does not need the desktop: it boots
 * the image to a bare `sleep`, then launches toolsd itself with a known seed, so
 * it exercises THIS worker's daemon in the real image (real `setpriv`, real
 * `ezil-run`, real node) without depending on how `start-neko.sh` wires it.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';

const IMAGE = process.env.EZIL_VALIDATE_IMAGE ?? 'ezil-integrated:local';
const CONTAINER = `ezil-toolsd-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const SEED = 'container-test-seed-0123456789abcdef';
const WORKSPACE = '/tmp/ezil-toolsd-ws';
const HOST = 'toolsd.ezil.invalid';

const CONTAINERS_TO_CLEAN = new Set<string>();
let cleanupInstalled = false;
function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const removeAll = () => { for (const name of CONTAINERS_TO_CLEAN) sh('docker', ['rm', '-f', name], 60_000); };
  process.on('exit', removeAll);
  process.on('SIGTERM', () => { removeAll(); process.exit(143); });
  process.on('SIGINT', () => { removeAll(); process.exit(130); });
}
installCleanup();

function sh(cmd: string, args: string[], timeout = 60_000) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
}
function dexec(args: string[], timeout = 60_000) {
  return sh('docker', ['exec', CONTAINER, ...args], timeout);
}

/** The section 3.4 signer (independent of the shipped auth.mjs). */
function deriveKey(seed: string): Buffer {
  return createHmac('sha256', Buffer.from(seed, 'utf8')).update('EZIL-TOOLSD-KEY/1').digest();
}
function sign(key: Buffer, op: string, body: string, ts = Date.now()): string {
  const bodyHash = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
  const mac = createHmac('sha256', key).update(`EZIL-TOOLSD/1\n${ts}\nPOST\n/v1/${op}\n${bodyHash}`).digest('hex');
  return `v1.${ts}.${mac}`;
}

/** curl inside the container; returns `{ status, body }`. */
function curl(args: string[]): { status: number; body: string } {
  const res = dexec(['curl', '-s', '--max-time', '20', '-o', '-', '-w', '\\n%{http_code}', ...args]);
  const out = (res.stdout || '').trim();
  const nl = out.lastIndexOf('\n');
  const status = Number(out.slice(nl + 1).trim());
  return { status: Number.isFinite(status) ? status : 0, body: nl >= 0 ? out.slice(0, nl) : '' };
}

function unavailableReason(): string | null {
  const version = sh('docker', ['version', '--format', '{{.Server.Version}}'], 20_000);
  if (version.error || version.status !== 0) {
    return `the Docker daemon is not reachable (${(version.stderr || version.error?.message || '').trim().split('\n')[0]})`;
  }
  const image = sh('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], 20_000);
  if (image.status !== 0) {
    return `the image \`${IMAGE}\` is not present locally (build it with \`cd worker && docker build -t ${IMAGE} .\`)`;
  }
  const probe = sh('docker', ['run', '--rm', '--entrypoint', 'test', IMAGE, '-f', '/opt/ezil-toolsd/server.mjs'], 60_000);
  if (probe.status !== 0) {
    return `\`${IMAGE}\` has no /opt/ezil-toolsd (it predates toolsd) — rebuild it after worker/Dockerfile COPYs worker/toolsd there`;
  }
  return null;
}

const SKIP_REASON = unavailableReason();
let started = false;
let bootError: string | null = null;
const KEY = deriveKey(SEED);

function boot(): void {
  const run = sh('docker', ['run', '-d', '--name', CONTAINER, '--entrypoint', 'sleep', IMAGE, '86400'], 60_000);
  if (run.status !== 0) throw new Error(`docker run failed: ${(run.stderr || '').trim()}`);
  started = true;
  CONTAINERS_TO_CLEAN.add(CONTAINER);

  // Prerequisites the image must satisfy for toolsd to drop privilege.
  const uid = dexec(['id', '-u', 'ezil-run']);
  if ((uid.stdout || '').trim() !== '7001') throw new Error(`ezil-run is not uid 7001 (got '${(uid.stdout || uid.stderr || '').trim()}')`);
  if (dexec(['test', '-x', '/usr/bin/setpriv']).status !== 0) throw new Error('/usr/bin/setpriv (util-linux) is not installed in the image');

  // A workspace with one self-built tool, writable so the scan sees it.
  const setup = dexec(['bash', '-lc',
    `set -e; mkdir -p ${WORKSPACE}/.ezil/tools/greet; `
    + `printf '%s' '{"schema":"ezil.tool/1","name":"greet","description":"greet","inputSchema":{"type":"object"},"run":{"argv":["./run.sh"]},"timeoutSeconds":10}' > ${WORKSPACE}/.ezil/tools/greet/tool.json; `
    + `printf '%s' '#!/bin/bash\\nread -r a\\necho "uid=$(id -u) gid=$(id -g) groups=$(id -G) args=$a"\\n' > ${WORKSPACE}/.ezil/tools/greet/run.sh; `
    + `chmod -R a+rx ${WORKSPACE}`]);
  if (setup.status !== 0) throw new Error(`workspace setup failed: ${(setup.stderr || '').trim()}`);

  // Launch toolsd detached with a known seed.
  const launch = sh('docker', ['exec', '-d',
    '-e', `EZIL_TOOLSD_SEED=${SEED}`, '-e', `EZIL_TOOLSD_WORKSPACE=${WORKSPACE}`,
    CONTAINER, 'bash', '-lc', 'node /opt/ezil-toolsd/server.mjs >/tmp/toolsd.log 2>&1'], 20_000);
  if (launch.status !== 0) throw new Error(`toolsd launch failed: ${(launch.stderr || '').trim()}`);

  // Wait for 9224 to answer (a 401 to an unauth probe means it is up).
  const deadline = Date.now() + 30_000;
  for (;;) {
    const probe = curl(['-X', 'POST', '-H', `Host: ${HOST}`, '-H', 'content-type: application/json', '--data-binary', '{}', 'http://127.0.0.1:9224/v1/list']);
    if (probe.status === 401) return;
    if (Date.now() > deadline) {
      const log = dexec(['cat', '/tmp/toolsd.log']);
      throw new Error(`toolsd never answered 401 on 9224 (last ${probe.status}); log:\n${log.stdout}\n${log.stderr}`);
    }
    sh('sleep', ['1'], 2_000);
  }
}

if (SKIP_REASON) {
  console.warn(
    `\n${'='.repeat(78)}\n`
    + `SKIPPING the toolsd container suite: ${SKIP_REASON}.\n`
    + `Nothing about the uid-7001 drop, the MAC auth wall, or a signed round trip\n`
    + `has been verified against the real image by this run. The unit suites check\n`
    + `wire SHAPE and the daemon in isolation, not the daemon in the image.\n`
    + `${'='.repeat(78)}\n`,
  );
} else {
  try { boot(); } catch (err) { bootError = err instanceof Error ? err.message : String(err); }
}

afterAll(() => { if (started) sh('docker', ['rm', '-f', CONTAINER], 60_000); });

const itIf = SKIP_REASON ? it.skip : it;

describe('toolsd in the real image', () => {
  itIf('booted, found ezil-run/setpriv, and reached the 401 wall on 9224', () => {
    expect(bootError ?? 'ok').toBe('ok');
  });

  itIf('there is no unauthenticated endpoint — a GET is 401', () => {
    const res = curl(['-X', 'GET', '-H', `Host: ${HOST}`, 'http://127.0.0.1:9224/v1/list']);
    expect(res.status).toBe(401);
    expect(res.body).toContain('tools_unauthorized');
  });

  itIf('a correct-Host, correct-Content-Type request with NO MAC is 401', () => {
    const res = curl(['-X', 'POST', '-H', `Host: ${HOST}`, '-H', 'content-type: application/json', '--data-binary', '{}', 'http://127.0.0.1:9224/v1/list']);
    expect(res.status).toBe(401);
  });

  itIf('a cross-origin text/plain POST with an Origin header is 401 (the in-computer Browser case)', () => {
    const res = curl(['-X', 'POST', '-H', `Host: ${HOST}`, '-H', 'content-type: text/plain;charset=UTF-8',
      '-H', 'origin: https://attacker.example', '--data-binary', '{}', 'http://127.0.0.1:9224/v1/exec']);
    expect(res.status).toBe(401);
  });

  itIf('a request with a WRONG Host is 401 even though it reached the port', () => {
    // No Host override: curl sends `Host: 127.0.0.1:9224`, which is not the constant.
    const res = curl(['-X', 'POST', '-H', 'content-type: application/json', '--data-binary', '{}', 'http://127.0.0.1:9224/v1/list']);
    expect(res.status).toBe(401);
  });

  itIf('a valid signed list returns the catalog, including the planted tool', () => {
    const body = '{}';
    const header = sign(KEY, 'list', body);
    const res = curl(['-X', 'POST', '-H', `Host: ${HOST}`, '-H', 'content-type: application/json',
      '-H', `x-ezil-toolsd: ${header}`, '--data-binary', body, 'http://127.0.0.1:9224/v1/list']);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { ok: boolean; catalogDigest: string; tools: Array<{ name: string }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.catalogDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parsed.tools.map((t) => t.name)).toContain('greet');
  });

  itIf('a valid signed call runs the tool as uid 7001 with its args on stdin', () => {
    const body = JSON.stringify({ name: 'greet', arguments: { x: 1 }, requestId: '22222222-2222-4222-8222-222222222222' });
    const header = sign(KEY, 'call', body);
    const res = curl(['-X', 'POST', '-H', `Host: ${HOST}`, '-H', 'content-type: application/json',
      '-H', `x-ezil-toolsd: ${header}`, '--data-binary', body, 'http://127.0.0.1:9224/v1/call']);
    expect(res.status).toBe(200);
    const job = JSON.parse(res.body) as { ok: boolean; state: string; stdout: string; catalogDigest: string };
    expect(job.ok).toBe(true);
    expect(job.state).toBe('exited');
    expect(job.stdout).toContain('uid=7001');
    // gid 7001 and NO supplementary groups (id -G is exactly 7001) — the real
    // --clear-groups drop in the image, not just a uid change.
    expect(job.stdout).toMatch(/\bgid=7001\b/);
    expect(job.stdout).toMatch(/\bgroups=7001\b/);
    expect(job.stdout).not.toMatch(/groups=[^ ]*\b0\b/);
    expect(job.stdout).toContain('args={"x":1}');
    expect(job.catalogDigest).toMatch(/^sha256:/);
  });

  itIf('a replayed valid MAC is refused the second time', () => {
    const body = '{}';
    const header = sign(KEY, 'refresh', body);
    const first = curl(['-X', 'POST', '-H', `Host: ${HOST}`, '-H', 'content-type: application/json', '-H', `x-ezil-toolsd: ${header}`, '--data-binary', body, 'http://127.0.0.1:9224/v1/refresh']);
    expect(first.status).toBe(200);
    const second = curl(['-X', 'POST', '-H', `Host: ${HOST}`, '-H', 'content-type: application/json', '-H', `x-ezil-toolsd: ${header}`, '--data-binary', body, 'http://127.0.0.1:9224/v1/refresh']);
    expect(second.status).toBe(401);
  });

  itIf('toolsd answers on the container routable address too (the containerFetch path), still 401', () => {
    const ip = (sh('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', CONTAINER]).stdout || '').trim();
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const res = dexec(['curl', '-s', '--max-time', '10', '-o', '/dev/null', '-w', '%{http_code}',
      '-X', 'POST', '-H', `Host: ${HOST}`, '-H', 'content-type: application/json', '--data-binary', '{}', `http://${ip}:9224/v1/list`]);
    expect((res.stdout || '').trim()).toBe('401');
  });
});
