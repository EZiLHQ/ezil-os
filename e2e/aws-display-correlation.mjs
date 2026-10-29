/**
 * Run in mcr.microsoft.com/playwright:v1.62.1-jammy with Playwright 1.62.1
 * installed. OS_E2E_BASE_URL selects staging (no production default).
 * Credentials use the repository's existing EZIL_E2E_EMAIL / EZIL_E2E_PASSWORD;
 * PLAYWRIGHT_REQUIRE_DIR is the existing optional module-resolution override.
 * node e2e/aws-display-correlation.mjs [output.json]
 *
 * No traces, screenshots, response bodies, frame URLs, or browser logs are saved.
 * A completed observation prints exactly one verdict; setup/coverage failure
 * exits 2 and saves partial evidence with a fixed failure phase.
 */
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { signIn } from './sign-in.mjs';
import { requestViewerProbe } from './viewer-progress.mjs';

const DURATION_MS = 90_000;
const FRAME_INTERVAL_MS = 2_000;
const PROBE_INTERVAL_MS = 5_000;
const FRESH_MS = 4_000;

/** Runs in the shell document; only the current Browser navigation can report. */
export function installCorrelationObserver() {
  let frameUrl = '', generation = 0, sequence = 0, latest = null;
  const current = () => {
    const frame = document.querySelector('.window[data-app="desktop"] iframe');
    const src = frame?.getAttribute('src') || '';
    if (src !== frameUrl) { frameUrl = src; generation++; latest = null; }
    return frame;
  };
  window.addEventListener('message', event => {
    const frame = current();
    if (!frame || !frameUrl || event.source !== frame.contentWindow) return;
    let url;
    try { url = new URL(frameUrl); } catch { return; }
    const attempt = url.searchParams.get('ezilAttempt');
    if (!attempt || event.origin !== url.origin || event.data?.attempt !== attempt) return;
    if (event.data?.source !== 'ezil-mobile' || event.data.type !== 'stream_vitals') return;
    const frames = event.data.vitals?.framesDecoded;
    if (!Number.isSafeInteger(frames) || frames < 0) return;
    latest = { framesDecoded: frames, receivedAt: Date.now(), sequence: ++sequence };
  });
  window.__awsDisplayCorrelation = () => {
    current();
    // frameUrl stays in memory, solely to match the shell's original request.
    return { frameUrl, generation, latest };
  };
}

/** Increasing fresh counters must bracket a blank reply within one sample tick. */
export function correlationVerdict(timeline) {
  const frames = timeline.filter(row => row.kind === 'frames' && row.fresh);
  if (!frames.some(row => row.framesDecoded > 0)) return 'no_frames';
  for (const probe of timeline.filter(row => row.kind === 'probe' && row.display === 'blank')) {
    const before = frames.findLast(row => row.received_at_ms <= probe.elapsed_ms && row.generation === probe.generation);
    const after = frames.find(row => row.received_at_ms >= probe.elapsed_ms && row.generation === probe.generation);
    if (before && after && probe.elapsed_ms - before.received_at_ms <= 2_500
      && after.received_at_ms - probe.elapsed_ms <= 2_500
      && after.sequence > before.sequence && after.framesDecoded > before.framesDecoded
      && after.received_at_ms > before.received_at_ms) return 'simultaneous_live_vs_blank';
  }
  return 'consistent';
}

export async function main(output = resolve('aws-display-correlation.json')) {
  const evidence = {
    duration_ms: DURATION_MS, frame_interval_ms: FRAME_INTERVAL_MS, probe_interval_ms: PROBE_INTERVAL_MS,
    started_at: null, completed: false, verdict: null, timeline: [],
  };
  let browser, phase = 'configuration';
  try {
    const base = new URL(process.env.OS_E2E_BASE_URL || '');
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
      throw new Error('Expected an HTTPS base origin');
    }
    const email = process.env.EZIL_E2E_EMAIL, password = process.env.EZIL_E2E_PASSWORD;
    if (!email || !password) throw new Error('Missing existing e2e credentials');
    phase = 'playwright';
    let chromium;
    try { ({ chromium } = await import('playwright')); } catch {
      if (!process.env.PLAYWRIGHT_REQUIRE_DIR) throw new Error('Playwright unavailable');
      const require = createRequire(resolve(process.env.PLAYWRIGHT_REQUIRE_DIR, 'test.js'));
      ({ chromium } = require('playwright'));
    }
    browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(installCorrelationObserver);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    // Capture exactly what the shell supplied to confirmDisplay/confirmFrame.
    // Never mint another URL or fetch the Neko origin from the test driver.
    let target = null;
    page.on('request', request => {
      const url = new URL(request.url());
      if (request.method() !== 'GET' || url.origin !== base.origin || url.pathname !== '/api/shell/desktop') return;
      if (!['frame', 'display'].includes(url.searchParams.get('confirm'))) return;
      const computerId = url.searchParams.get('computerId'), frameUrl = url.searchParams.get('frameUrl');
      if (computerId && frameUrl) target = { computerId, frameUrl };
    });

    phase = 'sign_in';
    await signIn(page, { email, password, app: base.origin });
    phase = 'open_browser';
    await page.goto(`${base.origin}/os`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => !!window.ezil?.session?.payload?.()?.computer && !!window.ezil?.registry, null, { timeout: 60_000 });
    const computerId = await page.evaluate(() => window.ezil.session.payload().computer.id);
    await page.evaluate(async () => {
      const payload = window.ezil.session.payload();
      await window.ezil.registry.launch('desktop', { payload, computer: payload.computer, desktopState: payload.desktopState });
    });
    await page.waitForFunction(() => {
      const src = document.querySelector('.window[data-app="desktop"] iframe')?.getAttribute('src');
      return src && /^https?:/.test(src);
    }, null, { timeout: 180_000 });
    const captureDeadline = Date.now() + 30_000;
    while (!target && Date.now() < captureDeadline) await page.waitForTimeout(100);
    if (!target || target.computerId !== computerId) throw new Error('Shell confirmation unavailable');
    phase = 'aws_bootstrap';
    const initialFrame = new URL(target.frameUrl);
    if (initialFrame.pathname !== '/preview-bootstrap' || !initialFrame.hostname.startsWith('aws-8181-')) {
      throw new Error('Selected Browser is not an AWS bootstrap');
    }
    evidence.origin_host = initialFrame.hostname;

    phase = 'sample';
    const started = Date.now(), end = started + DURATION_MS;
    evidence.started_at = new Date(started).toISOString();
    const snapshot = () => page.evaluate(() => window.__awsDisplayCorrelation());
    const frameRow = async () => {
      await page.evaluate(requestViewerProbe);
      const sample = await snapshot(), now = Date.now();
      const age = sample.latest ? now - sample.latest.receivedAt : null;
      evidence.timeline.push({
        kind: 'frames', elapsed_ms: now - started, generation: sample.generation,
        framesDecoded: sample.latest?.framesDecoded ?? null,
        sequence: sample.latest?.sequence ?? null,
        received_at_ms: sample.latest ? sample.latest.receivedAt - started : null,
        fresh: age !== null && age >= 0 && age <= FRESH_MS,
      });
    };
    const probe = async () => {
      const sample = await snapshot(), selected = target, requested = Date.now();
      // The iframe adds ezilAttempt; the shell's confirm request uses res.url.
      const frame = new URL(sample.frameUrl);
      frame.searchParams.delete('ezilAttempt');
      const shellFrame = selected ? new URL(selected.frameUrl) : null;
      shellFrame?.searchParams.delete('ezilAttempt');
      if (!selected || selected.computerId !== computerId || frame.href !== shellFrame?.href) {
        evidence.timeline.push({ kind: 'probe', elapsed_ms: requested - started, display: 'unknown', error: 'frame_changed' });
        return;
      }
      const result = await page.evaluate(async ({ computerId, frameUrl, timeout }) => {
        const url = new URL('/api/shell/desktop', location.origin);
        url.search = new URLSearchParams({ computerId, confirm: 'display', frameUrl }).toString();
        let status = null;
        try {
          const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeout) });
          status = response.status;
          const body = await response.json();
          return {
            status,
            display: response.ok && body?.ok === true && ['live', 'blank', 'unknown'].includes(body.display) ? body.display : 'unknown',
            valid: response.ok && body?.ok === true && ['live', 'blank', 'unknown'].includes(body.display),
            probe_status: Number.isInteger(body?.status) && body.status >= 100 && body.status <= 599 ? body.status : null,
          };
        } catch { return { status, display: 'unknown', valid: false, error: 'request_failed' }; }
      }, { ...selected, timeout: Math.max(1, Math.min(15_000, end - Date.now())) });
      const current = await snapshot();
      evidence.timeline.push({
        kind: 'probe', requested_at_ms: requested - started, elapsed_ms: Date.now() - started,
        // A reply spanning an iframe navigation cannot correlate with either generation.
        generation: current.generation === sample.generation ? sample.generation : null,
        ...result,
      });
    };

    // Independent clocks: a slow confirm response cannot stall either cadence.
    // Each request has a 15s ceiling, clamped to the end of the 90s observation.
    const pending = [];
    const sampleLoop = async () => {
      for (let tick = 0; tick <= DURATION_MS; tick += FRAME_INTERVAL_MS) {
        await page.waitForTimeout(Math.max(0, started + tick - Date.now()));
        await frameRow();
      }
    };
    const probeLoop = async () => {
      for (let tick = 0; tick < DURATION_MS; tick += PROBE_INTERVAL_MS) {
        await page.waitForTimeout(Math.max(0, started + tick - Date.now()));
        if (Date.now() >= end) break;
        pending.push(probe().catch(() => {
          evidence.timeline.push({ kind: 'probe', elapsed_ms: Date.now() - started, display: 'unknown', valid: false, error: 'observation_failed' });
        }));
      }
      await Promise.all(pending);
    };
    await Promise.all([sampleLoop(), probeLoop()]);
    evidence.timeline.sort((a, b) => a.elapsed_ms - b.elapsed_ms);
    phase = 'probe_coverage';
    if (!evidence.timeline.some(row => row.kind === 'probe' && row.valid)) throw new Error('No valid confirmation');
    evidence.verdict = correlationVerdict(evidence.timeline);
    evidence.completed = true;
    console.log(evidence.verdict);
    return 0;
  } catch {
    evidence.failed_phase = phase;
    console.error(`aws-display-correlation failed (${phase}); see JSON timeline`);
    return 2;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv[2] ? resolve(process.argv[2]) : undefined); }
  catch { console.error('aws-display-correlation could not write evidence'); process.exitCode = 2; }
}
