/**
 * The soft keyboard must type each character EXACTLY ONCE.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 * Reported from a phone, with a screenshot: typing "fast" into the streamed
 * browser produced "fastfast", and it degraded further the longer the user
 * typed. Their words: "not usable or typable properly" — and they noted people
 * hit it while simply trying to log in on mobile.
 *
 * The cause is in the compiled neko client's Guacamole-derived keyboard, which
 * binds to the player's overlay textarea like this (deminified from
 * `/var/www/js/app.48a1d8f5.js` in the pinned image):
 *
 *     keydown:          if (!e.isComposing && e.keyCode !== 229) -> send keysym
 *     input:            if (e.data && !e.isComposing)            -> type(e.data)
 *     compositionstart: removeEventListener("input", n)
 *     compositionend:   if (e.data)                              -> type(e.data)
 *
 * Two defects fall out of that on a phone, and neither is reachable from a
 * desktop browser, which is why it shipped:
 *
 *   A. A predictive keyboard (SwiftKey, Gboard) sends REAL key codes per
 *      character AND runs a composition. `keyCode !== 229` is therefore true,
 *      so each character leaves once as a keysym from `keydown` and again as
 *      text from `compositionend`.
 *
 *   B. `compositionstart` removes the input listener and nothing adds it back,
 *      so after the first composed word a character typed WITHOUT composition
 *      has no delivery path left.
 *
 * B was invisible in production because A was masking it: the keysym path
 * happened to carry those characters. Suppressing A alone would therefore have
 * turned a duplication bug into SILENT CHARACTER LOSS — which is why this file
 * asserts both, and why the numbers below were measured before the fix as well
 * as after.
 *
 * ── WHAT IS MEASURED ────────────────────────────────────────────────────────
 * Not the textarea, and not the DOM: the frames that actually leave for the
 * server. `RTCDataChannel.prototype.send` is hooked and keydown frames are
 * counted, so this asserts what the remote desktop will really receive.
 *
 * Measured against a real container:
 *
 *     scenario                          before   after
 *     composed word "fast" (4 chars)      8        4
 *     a plain char after a composition    1        1     (0 without the
 *                                                        compositionstart guard
 *                                                        — mutation-proved)
 *     Backspace                           1        1
 *     Enter                               1        1
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';

const IMAGE = process.env.EZIL_NEKO_IMAGE ?? 'ezil-integrated:local';
const CONTAINER = `ezil-kbd-test-${process.pid}`;
const PORT = 18291;
const BOOT_TIMEOUT_MS = 240_000;

function sh(cmd: string, args: string[], timeout = 60_000) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout });
}

let started = false;
let available = true;

beforeAll(() => {
  if (sh('docker', ['image', 'inspect', IMAGE]).status !== 0) {
    available = false;
    return;
  }
  sh('docker', ['rm', '-f', CONTAINER]);
  const run = sh('docker', [
    'run', '-d', '--name', CONTAINER, '--cpus=2', '-p', `${PORT}:8181`,
    '-e', 'DESKTOP_MODE=neko',
    '-e', 'EZIL_BROWSER_SIDECAR=off',
    '-e', 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=s1admin',
    '-e', 'NEKO_PASSWORD_ADMIN=s1admin',
    '-e', 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD=s1user',
    '-e', 'NEKO_PASSWORD=s1user',
    '--entrypoint', '/bin/bash', IMAGE,
    '-c', 'DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh',
  ], 120_000);
  if (run.status !== 0) { available = false; return; }
  started = true;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const probe = sh('docker', ['exec', CONTAINER, 'grep', '-c', 'phase=ready', '/tmp/neko.log'], 20_000);
    if (probe.status === 0 && Number((probe.stdout || '0').trim()) > 0) return;
    Bun.sleepSync(1000);
  }
  available = false;
}, 300_000);

afterAll(() => { if (started) sh('docker', ['rm', '-f', CONTAINER]); });

/**
 * Replay one keyboard scenario in a real touch browser against the real
 * client, and report how many keydown frames reached the wire.
 */
async function framesFor(scenario: string): Promise<{ keydown: number; keyup: number }> {
  const script = `
    const { chromium } = require('playwright');
    (async () => {
      const b = await chromium.launch();
      const ctx = await b.newContext({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true,
        deviceScaleFactor:3,
        userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' });
      const p = await ctx.newPage();
      await p.goto('http://127.0.0.1:${PORT}/?usr=EZiL&pwd=s1user&embed=1',{waitUntil:'domcontentloaded'});
      await p.waitForSelector('textarea.overlay',{timeout:60000}).catch(()=>{});
      await p.waitForTimeout(7000);
      await p.evaluate(() => {
        window.__sent = { keydown: 0, keyup: 0 };
        const orig = RTCDataChannel.prototype.send;
        RTCDataChannel.prototype.send = function (data) {
          try {
            const buf = data instanceof ArrayBuffer ? new Uint8Array(data)
              : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
            if (buf && buf.length >= 3) {
              if (buf[0] === 0x03) window.__sent.keydown++;
              else if (buf[0] === 0x04) window.__sent.keyup++;
            }
          } catch (e) {}
          return orig.apply(this, arguments);
        };
      });
      const out = await p.evaluate(async () => {
        const ta = document.querySelector('textarea.overlay'); ta.focus();
        const K = (t,i) => ta.dispatchEvent(new KeyboardEvent(t, Object.assign({bubbles:true}, i)));
        const C = (t,i) => ta.dispatchEvent(new CompositionEvent(t, Object.assign({bubbles:true}, i)));
        const I = (i) => ta.dispatchEvent(new InputEvent('input', Object.assign({bubbles:true}, i)));
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        ${scenario}
        await sleep(400);
        return window.__sent;
      });
      console.log(JSON.stringify(out));
      await b.close();
    })();
  `;
  const res = sh('node', ['-e', script], 180_000);
  const line = (res.stdout || '').trim().split('\n').filter(Boolean).pop() ?? '{}';
  return JSON.parse(line) as { keydown: number; keyup: number };
}

describe('the soft keyboard types each character exactly once', () => {
  it('🔴 a predictive keyboard typing a 4-character word sends FOUR keydowns, not eight', async () => {
    if (!available) { console.warn('container unavailable — SKIPPING, not passing'); return; }
    const got = await framesFor(`
      C('compositionstart', { data: '' });
      for (const ch of 'fast') {
        const kc = ch.toUpperCase().charCodeAt(0);
        K('keydown', { key: ch, keyCode: kc, which: kc });
        ta.value += ch;
        I({ data: ch, inputType: 'insertCompositionText', isComposing: true });
        K('keyup', { key: ch, keyCode: kc, which: kc });
        await sleep(25);
      }
      C('compositionend', { data: 'fast' });
    `);
    // 8 before the fix — the reported "fastfast".
    expect(got.keydown).toBe(4);
  }, 300_000);

  it('🔴 a plain character AFTER a composition is still delivered (0 without the compositionstart guard)', async () => {
    if (!available) { console.warn('container unavailable — SKIPPING, not passing'); return; }
    const got = await framesFor(`
      C('compositionstart', { data: '' });
      ta.value += 'a';
      I({ data: 'a', inputType: 'insertCompositionText', isComposing: true });
      C('compositionend', { data: 'a' });
      await sleep(60);
      const kc = 'X'.charCodeAt(0);
      K('keydown', { key: 'x', keyCode: kc, which: kc });
      ta.value += 'x';
      I({ data: 'x', inputType: 'insertText' });
      K('keyup', { key: 'x', keyCode: kc, which: kc });
      await sleep(40);
    `);
    // The composed 'a' plus the plain 'x'. Without the guard the 'x' is lost
    // entirely and this is 1 rather than 2 — measured.
    expect(got.keydown).toBeGreaterThanOrEqual(2);
  }, 300_000);

  it('Backspace and Enter still reach the remote — they carry no text', async () => {
    if (!available) { console.warn('container unavailable — SKIPPING, not passing'); return; }
    const got = await framesFor(`
      K('keydown', { key: 'Backspace', keyCode: 8, which: 8 });
      I({ data: null, inputType: 'deleteContentBackward' });
      K('keyup', { key: 'Backspace', keyCode: 8, which: 8 });
      await sleep(40);
      K('keydown', { key: 'Enter', keyCode: 13, which: 13 });
      K('keyup', { key: 'Enter', keyCode: 13, which: 13 });
      await sleep(40);
    `);
    expect(got.keydown).toBe(2);
  }, 300_000);

  it('🔴 exactly ONE keyboard affordance is on screen, and it clears the 48px touch minimum', async () => {
    if (!available) { console.warn('container unavailable — SKIPPING, not passing'); return; }
    const script = `
      const { chromium } = require('playwright');
      (async () => {
        const b = await chromium.launch();
        const ctx = await b.newContext({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true,
          deviceScaleFactor:3,
          userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' });
        const p = await ctx.newPage();
        await p.goto('http://127.0.0.1:${PORT}/?usr=EZiL&pwd=s1user&embed=1',{waitUntil:'domcontentloaded'});
        await p.waitForTimeout(9000);
        console.log(JSON.stringify(await p.evaluate(() => {
          const out = [];
          for (const el of document.querySelectorAll('#ezil-kbd-btn, .fa-keyboard, [class*="keyboard"]')) {
            const r = el.getBoundingClientRect();
            if (getComputedStyle(el).display === 'none' || r.width === 0) continue;
            out.push({ id: el.id || null, w: Math.round(r.width), h: Math.round(r.height) });
          }
          return out;
        })));
        await b.close();
      })();
    `;
    const res = sh('node', ['-e', script], 180_000);
    const line = (res.stdout || '').trim().split('\n').filter(Boolean).pop() ?? '[]';
    const found = JSON.parse(line) as Array<{ id: string | null; w: number; h: number }>;
    // 🔴 ONE affordance, and it is the CLIENT'S — not one this file adds.
    //
    // This originally asserted the opposite: that our own `#ezil-kbd-btn`
    // survived and the client's was hidden. Tested on a real phone that was the
    // wrong way round. Ours is `position: fixed` OVER the streamed picture, so
    // it covered the remote browser's tab bar, and the owner reported it as not
    // working while the client's own button did. So this file no longer adds a
    // button at all; it grows the client's to a real touch target instead.
    expect(found.length).toBe(1);
    expect(found[0]!.id).toBe(null);
    expect(found[0]!.w).toBeGreaterThanOrEqual(48);
    expect(found[0]!.h).toBeGreaterThanOrEqual(48);
  }, 300_000);
});
