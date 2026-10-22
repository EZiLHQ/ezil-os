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
export const EDITOR = '.editor-group-container.active .monaco-editor:visible';
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
    } catch (error) {
      result.status = 'FAIL'; result.evidence.error = String(error.message ?? error);
      if (error.qualityReason) result.reason = error.qualityReason;
    }
  }
  const failed = Object.keys(checks).filter(name => evidence[name].status === 'FAIL');
  if (failed.length) throw new Error(`Desktop checks failed: ${failed.join(', ')}`);
  const skipped = Object.keys(checks).filter(name => evidence[name].status === 'SKIP');
  return skipped.length ? `incomplete:${skipped.join(',')}` : null;
}

// Execute in the user's browser (top page or Code frame), never from Node.
export async function fetchTimings(realm, url, method) {
  const observations = await realm.evaluate(async ({ url, method }) => {
    const observations = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      try {
        const response = await fetch(url, { method, cache: 'no-store', credentials: 'same-origin',
          redirect: 'error', signal: AbortSignal.timeout(5000) });
        const body = await response.text();
        const contentType = response.headers.get('content-type') || '';
        const htmlFallback = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType)
          || /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(body);
        observations.push({ ms: performance.now() - started, httpStatus: response.status,
          htmlFallback, ok: response.ok && !htmlFallback });
      } catch (error) { observations.push({ ms: performance.now() - started, ok: false, error: error.name }); }
    }
    return observations;
  }, { url, method });
  return { ...latencySummary(observations.filter(item => item.ok).map(item => item.ms)), observations };
}

export async function focusEditor(frame) {
  const editor = frame.locator(EDITOR).first();
  await editor.waitFor({ state: 'visible' });
  const focused = () => editor.evaluate(element => {
    const doc = element.ownerDocument, active = doc.activeElement;
    return doc.hasFocus() && element.contains(active)
      && (active.matches('textarea.inputarea, [contenteditable="true"]') || !!active.editContext);
  });
  // Native EditContext need not expose a textarea/contenteditable. Preserve
  // the command's existing editor focus and selection when either input works.
  if (await focused()) return;
  // Click the bounded text viewport, not the potentially huge .view-lines
  // rendering layer. Stay below the empty-editor hint and clear of scrollbars.
  const content = editor.locator('.monaco-scrollable-element.editor-scrollable').first();
  const position = await content.evaluate(element => ({
    x: Math.min(8, element.clientWidth / 2), y: Math.min(80, element.clientHeight / 2),
  }));
  await content.click({ position });
  requireThat(await focused(), 'Code editor did not receive keyboard focus');
}

/** Serialized by page.addInitScript: no imports/closures, no network or logging.
 * Keep only counters, test-token equality, allowlisted state and error names.
 * Never retain socket URLs, clipboard contents, member ids, or error messages.
 */
export function installNekoClipboardProbe() {
  'use strict'; // addInitScript serializes this function outside module strict mode.
  if (window.top === window || !/^[^.]+-nekodesktop\./i.test(location.hostname)) return;
  if (window.__desktopQualityClipboard) return;
  const hooks = { websocket: 'unavailable', websocketOnmessage: 'unavailable', clipboardWrite: 'unavailable',
    clipboardHandler: 'unavailable', clipboardSend: 'unavailable' };
  let socketsObserved = 0, testToken = null, counters, initProfile = null;
  // Per-token resets otherwise make a connected but idle socket look blind.
  const lifetime = { messagesReceived: 0, listenerDeliveries: 0, onmessageDeliveries: 0, controlRequests: 0 };
  const restores = [], sockets = new Set(), handlers = new WeakMap();
  const errorName = error => ['Error', 'NotAllowedError', 'SecurityError', 'AbortError', 'TypeError',
    'NotFoundError', 'InvalidStateError', 'NotSupportedError', 'DataError', 'UnknownError']
    .includes(error?.name) ? error.name : 'OtherError';
  const isClipboard = message => ['control/clipboard', 'clipboard/updated'].includes(message?.event);
  // The pinned legacy protocol uses text. Unknown v3 payload formats are still
  // counted as events, but cannot establish test-token equality.
  const matches = message => testToken !== null && message?.text === testToken;
  const replace = (owner, key, wrapped) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    owner[key] = wrapped;
    if (owner[key] !== wrapped) throw new TypeError('Hook unavailable');
    restores.push(() => {
      if (owner[key] !== wrapped) return;
      if (descriptor) Object.defineProperty(owner, key, descriptor);
      else delete owner[key];
    });
  };
  const reset = token => {
    testToken = typeof token === 'string' ? token : null;
    counters = { messagesReceived: 0, nonTextMessages: 0, parseFailures: 0,
      controlClipboardEvents: 0, clipboardUpdatedEvents: 0, testTokenEvents: 0,
      handlerCalls: 0, testTokenHandlerCalls: 0, handlerErrors: 0, lastHandlerErrorName: null,
      clipboardSends: 0, testTokenSends: 0, controlRequests: 0,
      writeCalls: 0, writeResolved: 0, writeRejected: 0,
      testTokenWriteCalls: 0, testTokenWriteResolved: 0, testTokenWriteRejected: 0,
      lastRejectionName: null, testTokenRejectionName: null };
  };
  reset(null);
  const profile = () => {
    try {
      const client = window.$client, user = client?.$accessor?.user;
      // The pinned legacy client exposes user.member; newer clients may expose
      // profile directly. Do not scan all members or mistake the host for self.
      const candidates = [
        ['user.profile', user?.profile], ['user.member.profile', user?.member?.profile],
        ['user.member', user?.member], ['user.self.profile', user?.self?.profile],
        ['user.self', user?.self], ['user.members[self].profile', user?.id ? user.members?.[user.id]?.profile : null],
        ['user.members[self]', user?.id ? user.members?.[user.id] : null], ['client.profile', client?.profile],
      ];
      for (const [source, value] of candidates) if (typeof value?.can_access_clipboard === 'boolean') {
        return { can_access_clipboard: value.can_access_clipboard, source, reason: null };
      }
      return initProfile || { can_access_clipboard: null, source: null, reason: 'logged_in_profile_flag_not_exposed' };
    } catch {
      return { can_access_clipboard: null, source: null, reason: 'logged_in_profile_unreadable' };
    }
  };
  const environment = () => {
    let focused = null, focusErrorName = null;
    const policy = { available: false, clipboardRead: null, clipboardWrite: null, errorName: null };
    try { focused = document.hasFocus(); } catch (error) { focusErrorName = errorName(error); }
    try {
      const effective = document.featurePolicy;
      policy.available = typeof effective?.allowsFeature === 'function';
      if (policy.available) {
        policy.clipboardRead = effective.allowsFeature('clipboard-read');
        policy.clipboardWrite = effective.allowsFeature('clipboard-write');
      }
    } catch (error) { policy.errorName = errorName(error); }
    const control = { clientPresent: false, accessorRemotePresent: false, storeRemotePresent: false,
      client: {}, accessorRemote: {}, storeRemote: {}, errorName: null };
    const flags = (value, keys) => Object.fromEntries(keys.map(key =>
      [key, typeof value?.[key] === 'boolean' ? value[key] : null]));
    try {
      const client = window.$client, remote = client?.$accessor?.remote;
      const store = client?.$store?.state?.remote || client?.$vue?.$store?.state?.remote;
      control.clientPresent = !!client; control.accessorRemotePresent = !!remote; control.storeRemotePresent = !!store;
      control.client = flags(client, ['connected', 'hosting', 'controlling']);
      control.client.channelOpen = client?._channel ? client._channel.readyState === 'open' : null;
      const keys = ['hosting', 'controlling', 'hosted', 'locked', 'implicitHosting'];
      control.accessorRemote = flags(remote, keys); control.storeRemote = flags(store, keys);
    } catch (error) { control.errorName = errorName(error); }
    return { focused, focusErrorName, policy, control };
  };
  const attachHandlers = () => {
    const client = window.$client;
    if (!client) return;
    for (const event of ['control/clipboard', 'clipboard/updated']) {
      try {
        const original = client[event];
        if (typeof original !== 'function') continue;
        if (handlers.get(original)) continue;
        const wrapped = function (...args) {
          const observation = counters;
          observation.handlerCalls++;
          if (matches(args[0])) observation.testTokenHandlerCalls++;
          const failed = error => {
            observation.handlerErrors++; observation.lastHandlerErrorName = errorName(error); throw error;
          };
          try {
            const returned = Reflect.apply(original, this, args);
            return returned?.then ? returned.then(value => value, failed) : returned;
          } catch (error) { return failed(error); }
        };
        replace(client, event, wrapped); handlers.set(wrapped, true);
        hooks.clipboardHandler = 'installed';
      } catch { hooks.clipboardHandler = 'installation_failed'; }
    }
  };
  const observeSocket = socket => {
    if (!socket || sockets.has(socket)) return;
    const seen = new WeakSet();
    const receive = event => {
      // A native socket delivers the same MessageEvent to both hooks. The
      // property path also covers adapters that call only socket.onmessage.
      if (seen.has(event)) return;
      seen.add(event);
      counters.messagesReceived++; lifetime.messagesReceived++;
      if (typeof event.data !== 'string') { counters.nonTextMessages++; return; }
      let message;
      try { message = JSON.parse(event.data); } catch { counters.parseFailures++; return; }
      if (message?.event === 'system/init') {
        initProfile = typeof message.profile?.can_access_clipboard === 'boolean'
          ? { can_access_clipboard: message.profile.can_access_clipboard, source: 'system/init.profile', reason: null } : null;
      }
      if (isClipboard(message)) {
        if (message.event === 'control/clipboard') counters.controlClipboardEvents++;
        else counters.clipboardUpdatedEvents++;
        if (matches(message)) counters.testTokenEvents++;
      }
      attachHandlers();
    };
    const listener = event => { lifetime.listenerDeliveries++; receive(event); };
    socket.addEventListener('message', listener);
    sockets.add(socket); socketsObserved++; hooks.websocket = 'installed';
    restores.push(() => socket.removeEventListener('message', listener));
    try {
      // The pinned client assigns _ws.onmessage in neko/base.ts:74 (and again
      // at disconnect, :96). Preserve that assignment path, including existing
      // sockets and later replacements; do not replace it with a static copy.
      const own = Object.getOwnPropertyDescriptor(socket, 'onmessage');
      let owner = socket, descriptor;
      while (owner && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(owner, 'onmessage');
        owner = Object.getPrototypeOf(owner);
      }
      let assigned = socket.onmessage, wrapped;
      const set = value => {
        assigned = value;
        wrapped = typeof value === 'function' ? function (event) {
          lifetime.onmessageDeliveries++; receive(event);
          return Reflect.apply(value, this, arguments);
        } : value;
        // Native WebSocket dispatch uses its internal event-handler slot.
        if (descriptor?.set) descriptor.set.call(socket, wrapped);
      };
      const get = () => wrapped;
      Object.defineProperty(socket, 'onmessage', { configurable: true,
        enumerable: own?.enumerable ?? true, get, set });
      restores.push(() => {
        if (Object.getOwnPropertyDescriptor(socket, 'onmessage')?.get !== get) return;
        if (own) Object.defineProperty(socket, 'onmessage', 'value' in own ? { ...own, value: assigned } : own);
        else delete socket.onmessage;
        if (descriptor?.set) descriptor.set.call(socket, assigned);
        else if (!own && assigned !== undefined) socket.onmessage = assigned;
      });
      set(assigned);
      hooks.websocketOnmessage = 'installed';
    } catch { hooks.websocketOnmessage = 'installation_failed'; }
    try {
      const original = socket.send;
      if (typeof original === 'function') {
        replace(socket, 'send', function (...args) {
          // A returned send proves the client handed the message to WebSocket,
          // not that the server applied it. Do not count throws as sends.
          const returned = Reflect.apply(original, this, args);
          let message;
          try { message = JSON.parse(args[0]); } catch { return returned; }
          if (message?.event === 'control/clipboard') {
            counters.clipboardSends++;
            if (matches(message)) counters.testTokenSends++;
          }
          if (message?.event === 'control/request') { counters.controlRequests++; lifetime.controlRequests++; }
          return returned;
        });
        hooks.clipboardSend = 'installed';
      }
    } catch { hooks.clipboardSend = 'installation_failed'; }
  };
  const attach = () => {
    attachHandlers();
    // Also support an already connected legacy client if addInitScript was
    // missed, and a socket replaced by a reconnect during the diagnostic.
    try { observeSocket(window.$client?._ws); } catch { hooks.websocket = 'installation_failed'; }
  };
  window.__desktopQualityClipboard = { reset(token) { attach(); reset(token); }, snapshot() {
    attach();
    return { status: 'observed', hooks: { ...hooks }, socketsObserved, lifetime: { ...lifetime }, ...counters,
      controlClipboardReceived: hooks.websocket === 'installed' && socketsObserved > 0 ? counters.controlClipboardEvents > 0 : null,
      clipboardWriteRejected: hooks.clipboardWrite === 'installed' ? counters.writeRejected > 0 : null,
      profile: profile(), ...environment() };
  }, async smoke(token) {
    const result = { writeResolved: false, readResolved: false, localEquals: null,
      writeErrorName: null, readErrorName: null };
    try { await navigator.clipboard.writeText(token); result.writeResolved = true; }
    catch (error) { result.writeErrorName = errorName(error); }
    try { result.localEquals = await navigator.clipboard.readText() === token; result.readResolved = true; }
    catch (error) { result.readErrorName = errorName(error); }
    return result;
  }, restore() {
    const result = { restored: true, errors: 0, errorName: null };
    for (const restore of restores.reverse()) {
      try { restore(); } catch (error) { result.restored = false; result.errors++; result.errorName = errorName(error); }
    }
    reset(null); sockets.clear(); delete window.__desktopQualityClipboard;
    return result;
  } };
  try {
    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket === 'function') {
      replace(window, 'WebSocket', new Proxy(NativeWebSocket, {
        construct(target, args, newTarget) {
          const socket = Reflect.construct(target, args, newTarget);
          observeSocket(socket);
          return socket;
        },
      }));
      hooks.websocket = 'installed';
    }
  } catch { hooks.websocket = 'installation_failed'; }
  try {
    const clipboard = navigator.clipboard, original = clipboard?.writeText;
    if (typeof original === 'function') {
      replace(clipboard, 'writeText', function (...args) {
        const observation = counters, matches = testToken !== null && args[0] === testToken;
        observation.writeCalls++;
        if (matches) observation.testTokenWriteCalls++;
        const rejected = error => {
          observation.writeRejected++;
          if (matches) {
            observation.testTokenWriteRejected++;
            observation.testTokenRejectionName = errorName(error);
          }
          observation.lastRejectionName = errorName(error);
          throw error;
        };
        let pending;
        try { pending = Reflect.apply(original, this, args); } catch (error) { return rejected(error); }
        return Promise.resolve(pending).then(value => {
          observation.writeResolved++;
          if (matches) observation.testTokenWriteResolved++;
          return value;
        }, rejected);
      });
      hooks.clipboardWrite = 'installed';
    }
  } catch { hooks.clipboardWrite = 'installation_failed'; }
  attach();
}

export async function nekoClipboardDiagnostics(frame, token) {
  try {
    return await frame.evaluate(token => {
      const probe = window.__desktopQualityClipboard;
      if (!probe) return { status: 'unavailable', reason: 'neko_probe_not_installed' };
      if (typeof token === 'string') probe.reset(token);
      return probe.snapshot();
    }, token);
  } catch { return { status: 'unavailable', reason: 'neko_frame_unavailable_for_diagnostics' }; }
}

/** A matching server notification confirms remote copy indirectly. With no
 * notification there is no independent remote clipboard reader in this harness;
 * keep remoteCopied unknown, even when Ctrl+C was successfully dispatched.
 */
export function nekoClipboardEvidence(diagnostics, { localEquals = null, readErrorName = null } = {}) {
  const observed = diagnostics?.status === 'observed';
  const eventObserved = observed && diagnostics.hooks.websocket === 'installed' && diagnostics.socketsObserved > 0;
  const handlerObserved = observed && diagnostics.hooks.clipboardHandler === 'installed';
  const writeObserved = observed && diagnostics.hooks.clipboardWrite === 'installed';
  const remoteCopied = observed && diagnostics.testTokenEvents > 0 ? true : null;
  const eventReceived = eventObserved ? diagnostics.controlClipboardEvents + diagnostics.clipboardUpdatedEvents > 0 : null;
  const handlerRan = handlerObserved ? diagnostics.testTokenHandlerCalls > 0 : null;
  const writeResolved = writeObserved ? diagnostics.testTokenWriteResolved > 0 : null;
  const reason = !eventObserved ? 'clipboard_event_observer_unavailable'
    : !eventReceived ? 'no_clipboard_event'
    : !remoteCopied ? 'clipboard_event_token_unverified'
    : !handlerObserved ? 'clipboard_handler_observer_unavailable'
    : !handlerRan ? 'clipboard_handler_not_run'
    : !writeObserved ? 'clipboard_write_observer_unavailable'
    : writeResolved !== true && diagnostics.testTokenWriteRejected > 0 ? `write_rejected:${diagnostics.testTokenRejectionName}`
    : diagnostics.testTokenWriteCalls === 0 ? 'clipboard_write_not_called'
    : !writeResolved ? 'clipboard_write_unresolved'
    : readErrorName ? `local_read_rejected:${readErrorName}`
    : localEquals !== true ? 'local_clipboard_mismatch' : null;
  return { remoteCopied, eventReceived, handlerRan, writeResolved, localEquals,
    remoteCopyVerification: remoteCopied ? 'matching_incoming_clipboard_event' : 'remote_copy_unverified',
    readErrorName, exactEquality: localEquals === true, verdict: reason ? 'FAIL' : 'PASS', reason };
}

const clipboardFailure = reason => Object.assign(new Error(reason), { qualityReason: reason });

async function waitForClipboardSend(frame, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let diagnostics;
  do {
    diagnostics = await nekoClipboardDiagnostics(frame);
    if (diagnostics.testTokenSends > 0) break;
    if (performance.now() >= deadline) break;
    await sleep(50);
  } while (true);
  return diagnostics;
}

async function observeNekoCopy(page, frame, token, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let evidence, diagnostics;
  do {
    const localRead = await page.evaluate(async token => {
      try { return { localEquals: await navigator.clipboard.readText() === token, readErrorName: null }; }
      catch (error) {
        return { localEquals: null, readErrorName: ['Error', 'NotAllowedError', 'SecurityError', 'AbortError',
          'TypeError', 'NotFoundError', 'InvalidStateError', 'NotSupportedError', 'DataError', 'UnknownError']
          .includes(error?.name) ? error.name : 'OtherError' };
      }
    }, token);
    diagnostics = await nekoClipboardDiagnostics(frame);
    evidence = nekoClipboardEvidence(diagnostics, localRead);
    if (evidence.verdict === 'PASS' || performance.now() >= deadline) break;
    await sleep(50);
  } while (true);
  return { ...evidence, diagnosticsAfter: diagnostics };
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
  codeFrame, terminalRun, command, clickDock, openApp, closeApp, appWindow, shot,
  clipboardTimeoutMs = 5000 }) {
  const terminal = async (script, phase) => terminalRun(page, await codeFrame(page), script, runId, phase);
  const newEditor = async () => {
    await clickDock(page, 'code');
    const frame = await codeFrame(page);
    await command(frame, 'File: New Untitled Text File', 'workbench.action.files.newUntitledFile');
    await focusEditor(frame);
    // An empty Monaco line may render one NBSP as its caret-height placeholder.
    requireThat(['', ' '].includes(await readEditor(frame)), 'New untitled editor is not empty');
    return frame;
  };
  const browserTarget = async (evidence, beforeEntry = async () => {}) => {
    if (!browserReady) return null;
    await openApp(page, 'desktop', evidence);
    const element = await appWindow(page, 'desktop').locator('iframe.window-app-iframe').elementHandle();
    let frame;
    try { frame = await element?.contentFrame(); } finally { await element?.dispose(); }
    if (!frame) return null;
    const input = frame.locator('textarea.overlay:visible').first();
    if (!await input.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)) return null;
    await beforeEntry(frame);
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
          Object.assign(data, { origin: new URL(frame.url()).origin, assetPath: new URL(asset).pathname, method: 'GET',
            executionRealm: 'Code frame in user browser' }, await fetchTimings(frame, asset, 'GET'));
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
          data.automationNote = 'Playwright does not synthesize timed native key repeats. Code DOM input also bypasses Neko/XKB.';
          return 'native_repeat_not_synthesized';
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
          await focusEditor(frame);
          await page.keyboard.press('Control+V');
          data.exactEquality = await waitForText(() => readEditor(frame), token) === token;
          requireThat(data.exactEquality, 'Local clipboard did not reach Code');
        },
        codeRemoteToLocal: async data => {
          if (!codeReady) return 'code_unavailable';
          const frame = await newEditor(); await grant();
          const token = `code-to-local-${runId}`;
          await page.evaluate(token => navigator.clipboard.writeText(`sentinel-${token}`), token);
          await focusEditor(frame);
          await page.keyboard.type(token, { delay: 15 });
          requireThat(await waitForText(() => readEditor(frame), token) === token, 'Code copy source was not rendered');
          await page.keyboard.press('Control+A'); await page.keyboard.press('Control+C');
          data.exactEquality = await waitForText(() => page.evaluate(() => navigator.clipboard.readText()), token) === token;
          requireThat(data.exactEquality, 'Code clipboard did not reach the local browser');
        },
        browser: async data => {
          let target, diagnosticFrame;
          try {
            if (browserReady) await grant();
            target = await browserTarget(data, async frame => {
              diagnosticFrame = frame;
              await frame.evaluate(installNekoClipboardProbe);
              data.diagnostics = await nekoClipboardDiagnostics(frame);
              // Include newly opened frame origins before the first overlay
              // entry can invoke syncClipboard/readText.
              await grant();
            });
            if (!target) {
              data.localToRemote = data.remoteToLocal = { status: 'SKIP', reason: 'neko_focusable_target_unavailable' };
              return 'neko_focusable_target_unavailable';
            }
            data.diagnostics = await nekoClipboardDiagnostics(target.frame);
            data.smoke = await target.frame.evaluate(token => window.__desktopQualityClipboard?.smoke(token)
              ?? { reason: 'neko_probe_not_installed' }, `clipboard-smoke-${runId}`);
            // The sidecar's snapshot.url is the committed page URL, not the
            // editable omnibox. Never substitute local overlay.value or OCR.
            return await qualityChecks(data, {
              localToRemote: async result => {
                const token = `local-to-browser-${runId}`;
                result.diagnosticsBefore = await nekoClipboardDiagnostics(target.frame, token);
                result.upstreamSent = false;
                try {
                  await page.evaluate(token => navigator.clipboard.writeText(token), token);
                  // A stationary pointer does not produce another mouseenter
                  // on click. Focus first, then run the client's actual entry
                  // listener after writing the new clipboard value.
                  await target.input.focus();
                  await target.input.dispatchEvent('mouseenter');
                  const sent = await waitForClipboardSend(target.frame, clipboardTimeoutMs);
                  result.upstreamSent = sent.testTokenSends > 0;
                  if (!result.upstreamSent) throw clipboardFailure(sent.hooks?.clipboardSend === 'installed'
                    ? 'no_upstream_clipboard_send' : 'clipboard_send_observer_unavailable');
                  await target.input.press('Control+l'); await target.input.press('Control+v');
                  await shot('clipboard-browser', result, 'desktop', true);
                  result.contract = 'worker/sidecar/contract.mjs:SIDECAR_WIRE';
                  await target.input.press('Escape');
                  return 'sidecar_has_no_omnibox_text_readback';
                } catch (error) {
                  throw error.qualityReason ? error : clipboardFailure('clipboard_upstream_observation_failed');
                } finally { result.diagnosticsAfter = await nekoClipboardDiagnostics(target.frame); }
              },
              remoteToLocal: async result => {
                const token = `browser-to-local-${runId}`;
                result.diagnosticsBefore = await nekoClipboardDiagnostics(target.frame, token);
                Object.assign(result, nekoClipboardEvidence(result.diagnosticsBefore));
                result.copyDispatched = false;
                try {
                  await page.evaluate(token => navigator.clipboard.writeText(`sentinel-${token}`), token);
                  await target.input.click(); await target.input.press('Control+l');
                  await typeNeko(target.input, token);
                  await target.input.press('Control+a'); await target.input.press('Control+c');
                  result.copyDispatched = true;
                  Object.assign(result, await observeNekoCopy(page, target.frame, token, clipboardTimeoutMs));
                  if (result.reason) throw clipboardFailure(result.reason);
                } catch (error) {
                  if (!error.qualityReason) {
                    // Playwright errors may contain evaluated values. Retain
                    // only a fixed stage reason rather than its message.
                    result.verdict = 'FAIL'; result.reason = 'clipboard_copy_observation_failed';
                    throw clipboardFailure(result.reason);
                  }
                  throw error;
                } finally {
                  // Keep the verdict's cutoff snapshot. A later notification
                  // during cleanup must not contradict the recorded stages.
                  result.diagnosticsAfter ??= await nekoClipboardDiagnostics(target.frame);
                  await target.input.press('Escape').catch(() => {});
                }
              },
            });
          } finally {
            try {
              if (diagnosticFrame) {
                data.diagnostics = await nekoClipboardDiagnostics(diagnosticFrame);
                data.instrumentationCleanup = await diagnosticFrame.evaluate(() =>
                  window.__desktopQualityClipboard?.restore() ?? { restored: true, errors: 0, errorName: null })
                  .catch(() => ({ restored: false, errors: 1, errorName: 'FrameUnavailable' }));
              }
            } finally { await closeApp(page, 'desktop'); }
          }
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
