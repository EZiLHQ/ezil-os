/** Desktop diagnostics; importing this module performs no I/O.
 * Selectors: Code uses the active editor's .view-lines (rendered text, not a
 * private Monaco API); Neko uses textarea.overlay and video, as documented in
 * worker/assets/neko-branding/www/ezil-mobile.js:32 and e2e/hosted-continuity.mjs:383.
 * The sidecar contract (worker/sidecar/contract.mjs) exposes page snapshots,
 * not browser-chrome/omnibox text. Clipboard checks that need that observation
 * explicitly skip. Font screenshots require human glyph inspection.
 */
import { isIP } from 'node:net';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const QUALITY_STEP_IDS = ['placement', 'latency', 'typing', 'clipboard', 'fonts'];
export const EDITOR_LINES = '.editor-group-container.active .monaco-editor .view-lines:visible';
export const TYPING_TEXT = 'Az09 é ß ñ 日本語 हिन्दी / . , : - _ '.repeat(8).slice(0, 200);
export const FONT_TEXT = '日本語 한국어 हिन्दी العربية ไทย 🙂';

export function parseIpinfo(text) {
  let data;
  try { data = JSON.parse(String(text)); } catch { data = null; }
  const field = key => typeof data?.[key] === 'string' && data[key].trim() ? data[key].trim() : null;
  const ip = field('ip');
  return { ip: ip && isIP(ip) ? ip : null, org: field('org'), city: field('city'),
    region: field('region'), country: field('country') };
}

/** Nearest-rank percentile, with millisecond inputs and outputs. */
export function percentile(samples, percent) {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new RangeError('Invalid percentile');
  const sorted = samples.filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    .slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(percent / 100 * sorted.length) - 1)] : null;
}

export function latencySummary(samplesMs) {
  return { samplesMs, p50Ms: percentile(samplesMs, 50), p95Ms: percentile(samplesMs, 95),
    percentileMethod: 'nearest-rank' };
}

/** Count Unicode code points, not UTF-16 halves or a regex interpretation. */
export function countRepeats(text, key) {
  if (typeof key !== 'string' || [...key].length !== 1) throw new TypeError('Expected one key');
  return [...String(text)].filter(character => character === key).length;
}

export function classifyPlacement(frameUrl, dmi = '', imds = '') {
  let frameHost = '';
  try { frameHost = new URL(frameUrl).hostname.toLowerCase(); } catch { /* Unavailable frame. */ }
  const frameClass = frameHost.includes('-aws.') ? 'aws'
    : /nekodesktop|guac-/.test(frameHost) ? 'cloudflare' : 'unknown';
  const [dmiVendor, dmiProduct] = String(dmi).split('|').map(value => value.trim());
  const dmiClass = /amazon ec2/i.test(dmi) ? 'aws' : dmi.trim() ? 'other' : 'unknown';
  const conflict = frameClass === 'cloudflare' && dmiClass === 'aws';
  const region = /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(imds.trim()) ? imds.trim() : null;
  return { frameHost, frameClass, dmiVendor: dmiVendor || null, dmiProduct: dmiProduct || null,
    dmiClass, hostClass: conflict ? 'conflicting' : dmiClass === 'aws' ? 'aws' : frameClass,
    conflict, region, regionSource: region ? 'guest IMDS' : null };
}

export const PLACEMENT_COMMAND = [
  `quality_ip=$(curl -s --max-time 5 https://ipinfo.io/json); quality_ip_rc=$?`,
  `printf 'IPINFO_RC=%s\\nIPINFO=%s\\n' "$quality_ip_rc" "$(printf '%s' "$quality_ip" | tr -d '\\r\\n')"`,
  `quality_dmi=$(cat /sys/devices/virtual/dmi/id/sys_vendor /sys/devices/virtual/dmi/id/product_name 2>/dev/null); quality_dmi_rc=$?`,
  `printf 'DMI_RC=%s\\nDMI=%s\\n' "$quality_dmi_rc" "$(printf '%s' "$quality_dmi" | tr '\\n' '|')"`,
  `quality_imds=$(curl -s -m 2 http://169.254.169.254/latest/meta-data/placement/region); quality_imds_rc=$?`,
  `printf 'IMDS_RC=%s\\nIMDS=%s\\n' "$quality_imds_rc" "$(printf '%s' "$quality_imds" | tr -d '\\r\\n')"`,
  `printf 'HOSTNAME='; hostname; printf 'NPROC='; nproc; free -m`,
].join('; ');

export const CONNECT_COMMAND = `for quality_i in 1 2 3 4 5; do curl -s --max-time 5 -o /dev/null -w '%{time_connect}\\n' https://ai.ezil.work; printf 'CONNECT_RC=%s\\n' "$?"; done`;

export function parseConnectTimes(text) {
  return [...String(text).matchAll(/^(\d+(?:\.\d+)?)\r?\nCONNECT_RC=(\d+)\r?$/gm)]
    .map(match => ({ connectMs: Number((Number(match[1]) * 1000).toFixed(3)), exitCode: Number(match[2]) }));
}

const field = (text, name) => text.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() ?? null;
const requireThat = (condition, reason) => { if (!condition) throw new Error(reason); };

/** Preserve sibling observations when one component fails or is unavailable. */
export async function qualityChecks(evidence, checks) {
  for (const [name, work] of Object.entries(checks)) {
    const result = evidence[name] = { status: 'PASS', evidence: {} };
    try {
      const reason = await work(result.evidence);
      if (reason) { result.status = 'SKIP'; result.reason = reason; }
    } catch (error) { result.status = 'FAIL'; result.evidence.error = String(error.message ?? error); }
  }
  const failed = Object.keys(checks).filter(name => evidence[name].status === 'FAIL');
  if (failed.length) throw new Error(`Desktop checks failed: ${failed.join(', ')}`);
  const skipped = Object.keys(checks).filter(name => evidence[name].status === 'SKIP');
  return skipped.length ? `incomplete:${skipped.join(',')}` : null;
}

// Execute in the user's browser (top page or Code frame), never from Node.
async function fetchTimings(realm, url, method) {
  const observations = await realm.evaluate(async ({ url, method }) => {
    const observations = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      try {
        const response = await fetch(url, { method, cache: 'no-store', credentials: 'same-origin',
          redirect: 'error', signal: AbortSignal.timeout(5000) });
        await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || '';
        observations.push({ ms: performance.now() - started, httpStatus: response.status,
          ok: response.ok && (method !== 'HEAD' || !/text\/html/i.test(contentType)) });
      } catch (error) { observations.push({ ms: performance.now() - started, ok: false, error: error.name }); }
    }
    return observations;
  }, { url, method });
  return { ...latencySummary(observations.filter(item => item.ok).map(item => item.ms)), observations };
}

async function readEditor(frame) {
  // All fixtures are a single logical line. Concatenation preserves soft wraps;
  // NBSP and zero-width layout characters are Monaco's rendering artifacts.
  return frame.locator(EDITOR_LINES).first().evaluate(element =>
    [...element.querySelectorAll('.view-line')].map(line => line.textContent).join('')
      .replace(/\u00a0/g, ' ').replace(/\u200b/g, ''));
}

async function waitForText(read, expected, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  let observed = '';
  do {
    observed = await read();
    if (observed === expected) return observed;
    await sleep(50);
  } while (performance.now() < deadline);
  return observed;
}

export function echoSummary(inputs, expected, timeUntilLastCharacterMs) {
  return { ...latencySummary(inputs.filter(item => item.echoMs !== null).map(item => item.echoMs)),
    lastCharacterEchoMs: inputs.at(-1)?.prefix === expected ? inputs.at(-1).echoMs : null,
    timeUntilLastCharacterMs, inputEvents: inputs.length,
    measurement: 'keydown (beforeinput for Unicode insertion) to rendered DOM echo; user browser clock' };
}

async function installEchoObserver(frame, expected) {
  await frame.locator(EDITOR_LINES).first().evaluate((element, expected) => {
    window.__desktopQualityEcho?.stop();
    const state = { startedMs: performance.now(), inputs: [], prefix: '', lastKey: null, timeUntilLastCharacterMs: null };
    const read = () => [...element.querySelectorAll('.view-line')].map(line => line.textContent).join('')
      .replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
    const scan = () => {
      const value = read(), now = performance.now();
      if (value === expected && state.timeUntilLastCharacterMs === null) state.timeUntilLastCharacterMs = now - state.startedMs;
      for (const input of state.inputs) if (input.echoMs === null && value.startsWith(input.prefix)) {
        input.echoMs = now - input.startedMs;
      }
    };
    const keydown = event => {
      state.lastKey = event.key.length === 1 ? { key: event.key, ms: performance.now() } : null;
    };
    const beforeinput = event => {
      if (!event.data || !event.inputType.startsWith('insert')) return;
      state.prefix += event.data;
      state.inputs.push({ prefix: state.prefix, startedMs: state.lastKey?.key === event.data
        ? state.lastKey.ms : performance.now(), echoMs: null });
      state.lastKey = null;
    };
    const observer = new MutationObserver(scan);
    observer.observe(element, { subtree: true, childList: true, characterData: true });
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('beforeinput', beforeinput, true);
    window.__desktopQualityEcho = { state, stop() {
      scan(); observer.disconnect(); document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('beforeinput', beforeinput, true);
    } };
  }, expected);
}

// Neko consumes physical keysyms, including explicit Shift for punctuation.
async function typeNeko(input, value) {
  for (const character of value) {
    const key = { ':': 'Shift+Semicolon', '%': 'Shift+Digit5', ',': 'Comma', '/': 'Slash',
      '-': 'Minus', '_': 'Shift+Minus', '.': 'Period' }[character]
      || (/^[A-Z]$/.test(character) ? `Shift+Key${character}` : character);
    await input.press(key, { delay: 15 });
  }
}

export function desktopQuality({ page, context, runId, codeReady, browserReady,
  codeFrame, terminalRun, command, clickDock, openApp, closeApp, appWindow, shot }) {
  const terminal = async (script, phase) => terminalRun(page, await codeFrame(page), script, runId, phase);
  const newEditor = async () => {
    await clickDock(page, 'code');
    const frame = await codeFrame(page);
    await command(frame, 'File: New Untitled Text File', 'workbench.action.files.newUntitledFile');
    await frame.locator(EDITOR_LINES).first().click();
    // An empty Monaco line may render one NBSP as its caret-height placeholder.
    requireThat(['', ' '].includes(await readEditor(frame)), 'New untitled editor is not empty');
    return frame;
  };
  const clearEditor = async () => { await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace'); };
  const browserTarget = async evidence => {
    if (!browserReady) return null;
    await openApp(page, 'desktop', evidence);
    const element = await appWindow(page, 'desktop').locator('iframe.window-app-iframe').elementHandle();
    let frame;
    try { frame = await element?.contentFrame(); } finally { await element?.dispose(); }
    if (!frame) return null;
    const input = frame.locator('textarea.overlay:visible').first();
    if (!await input.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)) return null;
    await input.click();
    evidence.origin = new URL(frame.url()).origin;
    const deadline = performance.now() + 10_000;
    do {
      const control = await input.evaluate(() => {
        const client = window.$client, remote = client?.$accessor?.remote;
        return !!(client?.connected && client._channel?.readyState === 'open'
          && remote?.controlling && remote.hosting && !remote.locked);
      });
      if (control) return { frame, input };
      await sleep(100);
    } while (performance.now() < deadline);
    throw new Error('Neko keyboard target exists but viewer did not acquire control');
  };

  return {
    async placement(evidence) {
      if (!codeReady) return 'code_unavailable';
      const frame = await codeFrame(page);
      const output = await terminal(PLACEMENT_COMMAND, 'placement');
      evidence.terminal = output.text;
      evidence.hostPlacement = classifyPlacement(frame.url(), field(output.text, 'DMI') || '', field(output.text, 'IMDS') || '');
      evidence.hostPlacement.imds = { exitCode: Number(field(output.text, 'IMDS_RC') ?? -1),
        output: field(output.text, 'IMDS'), expectedGuestUnreachable: true };
      evidence.egressLocation = { source: 'https://ipinfo.io/json', ...parseIpinfo(field(output.text, 'IPINFO')) };
      evidence.hostname = field(output.text, 'HOSTNAME');
      evidence.vcpus = Number(field(output.text, 'NPROC')) || null;
      evidence.ramMiB = Number(output.text.match(/^Mem:\s+(\d+)/m)?.[1]) || null;
      requireThat(field(output.text, 'IPINFO_RC') === '0' && evidence.egressLocation.ip, 'Egress IP could not be read');
      requireThat(!evidence.hostPlacement.conflict, 'Frame hostname and DMI placement conflict');
      requireThat(evidence.hostname && evidence.vcpus && evidence.ramMiB, 'Host resources could not be read');
      return evidence.hostPlacement.hostClass === 'unknown' ? 'host_placement_unknown' : null;
    },

    async latency(evidence) {
      return qualityChecks(evidence, {
        osHealth: async data => {
          Object.assign(data, { origin: new URL(page.url()).origin, method: 'GET' }, await fetchTimings(page, '/api/health', 'GET'));
          requireThat(data.samplesMs.length === 10, 'Health did not return 10 successful timing samples');
        },
        codeOrigin: async data => {
          if (!codeReady) return 'code_unavailable';
          const frame = await codeFrame(page);
          const asset = await frame.evaluate(() => [...document.querySelectorAll('script[src], link[rel="stylesheet"][href]')]
            .map(element => element.src || element.href).find(value => new URL(value).origin === location.origin));
          if (!asset) return 'same_origin_static_asset_unavailable';
          Object.assign(data, { origin: new URL(frame.url()).origin, assetPath: new URL(asset).pathname, method: 'HEAD',
            executionRealm: 'Code frame in user browser' }, await fetchTimings(frame, asset, 'HEAD'));
          requireThat(data.samplesMs.length === 10, 'Code asset did not return 10 successful timing samples');
        },
        guestAiConnect: async data => {
          if (!codeReady) return 'code_unavailable';
          const output = await terminal(CONNECT_COMMAND, 'latency');
          data.origin = 'https://ai.ezil.work';
          data.observations = parseConnectTimes(output.text);
          Object.assign(data, latencySummary(data.observations.filter(item => item.exitCode === 0).map(item => item.connectMs)));
          requireThat(data.samplesMs.length === 5, 'Guest curl did not return 5 successful connect samples');
        },
      });
    },

    async typing(evidence) {
      if (!codeReady) return 'code_unavailable';
      const frame = await newEditor();
      return qualityChecks(evidence, {
        mixedText: async data => {
          data.expected = TYPING_TEXT; data.characters = [...TYPING_TEXT].length; data.delayMs = 15;
          await installEchoObserver(frame, TYPING_TEXT);
          try {
            await page.keyboard.type(TYPING_TEXT, { delay: 15 });
            data.observed = await waitForText(() => readEditor(frame), TYPING_TEXT);
            data.exactEquality = data.observed === TYPING_TEXT;
          } finally {
            const observed = await frame.evaluate(() => {
              const observer = window.__desktopQualityEcho;
              observer.stop(); delete window.__desktopQualityEcho;
              return { inputs: observer.state.inputs, timeUntilLastCharacterMs: observer.state.timeUntilLastCharacterMs };
            });
            data.echo = echoSummary(observed.inputs, TYPING_TEXT, observed.timeUntilLastCharacterMs);
          }
          requireThat(data.exactEquality, 'Mixed text did not round trip exactly');
          return data.echo.lastCharacterEchoMs === null ? 'editor_input_timestamps_unavailable' : null;
        },
        autoRepeat: async data => {
          await frame.locator(EDITOR_LINES).first().click();
          await clearEditor();
          data.key = 'q'; data.holdMs = 600;
          data.automationNote = 'A single Playwright keydown may not synthesize native OS repeat; no extra keydowns injected.';
          await page.keyboard.down(data.key);
          try { await sleep(data.holdMs); } finally { await page.keyboard.up(data.key); }
          await sleep(250);
          data.observed = await readEditor(frame);
          data.repeatCount = countRepeats(data.observed, data.key);
          requireThat(data.repeatCount > 1 && data.repeatCount < 60 && data.observed === data.key.repeat(data.repeatCount),
            'Expected between 2 and 59 repeated characters');
        },
      });
    },

    async clipboard(evidence) {
      const grants = evidence.permissions = [];
      const grant = async () => {
        const origins = new Set(page.frames().map(frame => {
          try { const url = new URL(frame.url()); return /^https?:$/.test(url.protocol) ? url.origin : null; }
          catch { return null; }
        }).filter(Boolean));
        for (const origin of origins) {
          try {
            await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
            grants.push({ origin, status: 'PASS' });
          } catch (error) {
            grants.push({ origin, status: 'FAIL', reason: String(error.message ?? error) });
            throw error;
          }
        }
      };
      return qualityChecks(evidence, {
        codeLocalToRemote: async data => {
          if (!codeReady) return 'code_unavailable';
          const frame = await newEditor(); await grant();
          const token = `local-to-code-${runId}`;
          await page.evaluate(token => navigator.clipboard.writeText(token), token);
          await frame.locator(EDITOR_LINES).first().click();
          await page.keyboard.press('Control+V');
          data.exactEquality = await waitForText(() => readEditor(frame), token) === token;
          requireThat(data.exactEquality, 'Local clipboard did not reach Code');
        },
        codeRemoteToLocal: async data => {
          if (!codeReady) return 'code_unavailable';
          const frame = await newEditor(); await grant();
          const token = `code-to-local-${runId}`;
          await page.evaluate(token => navigator.clipboard.writeText(`sentinel-${token}`), token);
          await frame.locator(EDITOR_LINES).first().click();
          await page.keyboard.type(token, { delay: 15 });
          requireThat(await waitForText(() => readEditor(frame), token) === token, 'Code copy source was not rendered');
          await page.keyboard.press('Control+A'); await page.keyboard.press('Control+C');
          data.exactEquality = await waitForText(() => page.evaluate(() => navigator.clipboard.readText()), token) === token;
          requireThat(data.exactEquality, 'Code clipboard did not reach the local browser');
        },
        browser: async data => {
          try {
            const target = await browserTarget(data);
            if (!target) {
              data.localToRemote = data.remoteToLocal = { status: 'SKIP', reason: 'neko_focusable_target_unavailable' };
              return 'neko_focusable_target_unavailable';
            }
            await grant();
            // The sidecar's snapshot.url is the committed page URL, not the
            // editable omnibox. Never substitute local overlay.value or OCR.
            return await qualityChecks(data, {
              localToRemote: async result => {
                const token = `local-to-browser-${runId}`;
                await page.evaluate(token => navigator.clipboard.writeText(token), token);
                await target.input.click(); await target.input.press('Control+l');
                await target.input.press('Control+v'); await sleep(500);
                await shot('clipboard-browser', result, 'desktop', true);
                result.contract = 'worker/sidecar/contract.mjs:SIDECAR_WIRE';
                await target.input.press('Escape');
                return 'sidecar_has_no_omnibox_text_readback';
              },
              remoteToLocal: async result => {
                const token = `browser-to-local-${runId}`;
                await page.evaluate(token => navigator.clipboard.writeText(`sentinel-${token}`), token);
                await target.input.click(); await target.input.press('Control+l');
                await typeNeko(target.input, token);
                await target.input.press('Control+a'); await target.input.press('Control+c');
                result.exactEquality = await waitForText(() => page.evaluate(() => navigator.clipboard.readText()), token) === token;
                await target.input.press('Escape');
                requireThat(result.exactEquality, 'Browser clipboard did not reach the local browser');
              },
            });
          } finally { await closeApp(page, 'desktop'); }
        },
      });
    },

    async fonts(evidence) {
      return qualityChecks(evidence, {
        fontconfig: async data => {
          if (!codeReady) return 'code_unavailable';
          const output = await terminal(`if command -v fc-list >/dev/null 2>&1; then printf 'JA='; fc-list :lang=ja family | head -1; printf '\\nHI='; fc-list :lang=hi family | head -1; else printf 'FONTCONFIG_UNAVAILABLE\\n'; fi`, 'fonts');
          data.terminal = output.text; data.japanese = field(output.text, 'JA'); data.hindi = field(output.text, 'HI');
          requireThat(data.japanese && data.hindi, 'Japanese or Hindi font family is missing');
        },
        browserScreenshot: async data => {
          try {
            const target = await browserTarget(data);
            if (!target) return 'neko_focusable_target_unavailable';
            data.text = FONT_TEXT;
            // Percent encoding keeps the Neko input ASCII while delivering the
            // exact UTF-8 fixture; meta charset makes data: decoding explicit.
            const html = `<meta charset="utf-8"><p style="font-size:40px">${FONT_TEXT}</p>`;
            const url = `data:text/html,${encodeURIComponent(html).replace(/%[A-F0-9]{2}/g, value => value.toLowerCase())}`;
            await target.input.press('Control+l'); await typeNeko(target.input, url); await target.input.press('Enter');
            await sleep(3000);
            data.video = await target.frame.locator('video').first().evaluate(video => ({
              readyState: video.readyState, width: video.videoWidth, height: video.videoHeight,
            }));
            requireThat(data.video.readyState >= 2 && data.video.width > 0, 'Neko video has no decoded frame');
            await shot('fonts-desktop', data, 'desktop', true);
            data.glyphVerification = 'manual screenshot review required; no OCR used';
            return 'glyph_rendering_requires_visual_review';
          } finally { await closeApp(page, 'desktop'); }
        },
      });
    },
  };
}
