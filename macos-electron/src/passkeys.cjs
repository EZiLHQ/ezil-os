'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { browserURL } = require('./policy.cjs');
const execute = promisify(execFile);
const BUNDLE_ID = 'com.ezil.os.native';
const unavailable = reason => ({ embeddedTouchID: false, syncedPasskeys: false, existingPasskeys: 'secure-browser', reason });

// Only configure the supported Electron 44 API. A fabricated access group in
// an ad-hoc build cannot confer Keychain access. Never accept this from IPC/env.
async function configurePasskeys({ app, systemPreferences, platform = process.platform, run = execute, hasProfile = bundle => fs.existsSync(path.join(bundle, 'Contents/embedded.provisionprofile')) }) {
  if (platform !== 'darwin' || typeof app.configureWebAuthn !== 'function') return unavailable('runtime_unsupported');
  if (!app.isPackaged) return unavailable('signing_required');
  try {
    const bundle = path.resolve(app.getPath('exe'), '../../..');
    if (!hasProfile(bundle)) return unavailable('signing_required');
    const options = { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 };
    const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :EZiLWebAuthnKeychainAccessGroup', path.join(bundle, 'Contents/Info.plist')], options);
    const group = stdout.trim(), match = /^([A-Z0-9]{10})\.com\.ezil\.os\.native\.webauthn$/.exec(group);
    if (!match) return unavailable('signing_required');
    await run('/usr/bin/codesign', ['--verify', '--strict', '-R', `=anchor apple generic and identifier "${BUNDLE_ID}" and certificate leaf[subject.OU] = "${match[1]}" and entitlement["keychain-access-groups"] = "${group}"`, bundle], options);
    if (!systemPreferences.canPromptTouchID()) return unavailable('platform_unavailable');
    try { app.configureWebAuthn({ touchID: { keychainAccessGroup: group, promptReason: 'verify your identity on $1' } }); }
    catch { return unavailable('setup_failed'); }
    return { embeddedTouchID: true, syncedPasskeys: false, existingPasskeys: 'secure-browser' };
  } catch { return unavailable('signing_required'); }
}

function label(value, fallback) {
  return typeof value === 'string' && value ? value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 100) || fallback : fallback;
}

// Chromium owns origin/RP validation, authenticator access and private keys.
// This class only selects an account from Electron's host-only event. Nothing
// about credentials or user handles crosses the EZiL renderer bridge.
class PasskeyAccounts {
  constructor(session, window, owner, { dialog, timeout = 120000 } = {}) {
    Object.assign(this, { session, window, owner, dialog, timeout });
    this.closed = false; this.pending = null;
    this.handler = (_event, details, callback) => { void this.select(details, callback); };
    this.cancel = () => this.pending?.finish();
    session.on('select-webauthn-account', this.handler);
    for (const event of ['hide', 'minimize', 'closed']) window.on(event, this.cancel);
  }
  context(details) {
    try {
      if (this.closed || this.window.isDestroyed() || this.window.isVisible?.() === false || this.window.isMinimized?.()) return null;
      const frame = details.frame, wc = this.owner(frame);
      if (!wc || wc.isDestroyed() || frame.detached || frame.isDestroyed?.() || frame.visibilityState === 'hidden' || frame.top !== wc.mainFrame) return null;
      const url = new URL(browserURL(frame.url)), top = new URL(browserURL(wc.mainFrame.url));
      const rp = details.relyingPartyId;
      if (typeof rp !== 'string' || rp.length > 253 || !/^[a-z0-9.-]+$/.test(rp) || rp.endsWith('.') || rp.startsWith('.') || rp.includes('..')
          || !(url.hostname === rp || url.hostname.endsWith('.' + rp))) return null;
      return { wc, frame, origin: url.origin, topOrigin: top.origin, rp };
    } catch { return null; }
  }
  reconcile() { if (this.pending && !this.pending.valid()) this.pending.finish(); }
  async select(details, callback) {
    let completed = false;
    const reply = id => { if (completed) return; completed = true; try { callback(id); } catch { /* Native request may already be destroyed. */ } };
    const context = this.context(details);
    const accounts = details?.accounts;
    if (this.pending || !context || !Array.isArray(accounts) || !accounts.length || accounts.length > 64
        || accounts.some(a => !a || typeof a.credentialId !== 'string' || !/^[A-Za-z0-9_-]{1,8192}$/.test(a.credentialId))
        || new Set(accounts.map(a => a.credentialId)).size !== accounts.length) { reply(); return; }
    const candidates = accounts.map((a, i) => ({ id: a.credentialId, name: `${i + 1}. ${label(a.name, label(a.displayName, 'Passkey account'))}` }));
    const ancestors = new Set();
    try { for (let frame = context.frame; frame; frame = frame.parent) ancestors.add(frame); }
    catch { reply(); return; }
    const controller = new AbortController();
    let timer;
    const valid = () => {
      const next = this.context(details);
      return next?.wc === context.wc && next.frame === context.frame && next.origin === context.origin && next.topOrigin === context.topOrigin;
    };
    const finish = id => {
      if (completed) return;
      clearTimeout(timer);
      context.wc.removeListener('did-start-navigation', navigation);
      context.wc.removeListener('destroyed', cancel);
      context.wc.removeListener('render-process-gone', cancel);
      if (this.pending?.finish === finish) this.pending = null;
      controller.abort(); reply(id);
    };
    const cancel = () => finish();
    const navigation = (event, _url, _inPlace, mainFrame, processId, routingId) => {
      if (event?.isMainFrame || mainFrame) return cancel();
      if (event?.frame) { if (ancestors.has(event.frame)) cancel(); return; }
      if (Number.isInteger(processId) && Number.isInteger(routingId)) {
        try { if ([...ancestors].some(frame => frame.processId === processId && frame.routingId === routingId)) cancel(); }
        catch { cancel(); }
        return;
      }
      cancel(); // Missing frame identity cannot safely preserve a request.
    };
    this.pending = { valid, finish };
    context.wc.on('did-start-navigation', navigation); context.wc.once('destroyed', cancel);
    context.wc.once('render-process-gone', cancel);
    timer = setTimeout(cancel, this.timeout); timer.unref?.();
    try {
      const dialog = this.dialog || require('electron').dialog;
      let page = 0;
      while (!completed && valid()) {
        const start = page * 5, visible = candidates.slice(start, start + 5);
        const buttons = ['Cancel', ...visible.map(a => a.name)];
        const previous = page ? buttons.push('Previous accounts') - 1 : -1;
        const next = start + 5 < candidates.length ? buttons.push('More accounts') - 1 : -1;
        const result = await dialog.showMessageBox(this.window, { type: 'question', title: 'EZiL passkeys',
          message: `Choose a passkey for ${context.rp}`,
          detail: `Requested by ${context.origin}${context.origin === context.topOrigin ? '' : ` inside ${context.topOrigin}`}\nOnly continue if you trust this website. Touch ID or your security key verifies you; EZiL never receives its private key.`,
          buttons, defaultId: 0, cancelId: 0, noLink: true, signal: controller.signal });
        if (completed || !valid()) break;
        if (result.response === previous && previous !== -1) { page--; continue; }
        if (result.response === next && next !== -1) { page++; continue; }
        const selected = Number.isInteger(result.response) && result.response > 0 ? visible[result.response - 1] : null;
        finish(selected?.id); break;
      }
    } catch { /* Cancellation and native UI failure both reject the request. */ }
    finally { finish(); }
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.cancel();
    this.session.removeListener('select-webauthn-account', this.handler);
    for (const event of ['hide', 'minimize', 'closed']) this.window.removeListener(event, this.cancel);
  }
}
module.exports = { BUNDLE_ID, configurePasskeys, PasskeyAccounts };
