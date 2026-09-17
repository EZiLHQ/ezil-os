'use strict';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const capabilities = Object.freeze({ contractVersion: 1, executionTarget: 'macos-host', isolation: 'trusted-native', editor: 'external-vscode', browser: 'native-chromium', cloudSync: false });
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) throw Error('Invalid workspace ID'); return value; }
function name(value) { if (typeof value !== 'string' || value.length > 80 || !/[\p{L}\p{N}]/u.test(value) || /[\x00-\x1f]/.test(value)) throw Error('Invalid workspace name'); return value.trim(); }
function exact(value, keys) { if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => !keys.includes(k))) throw Error('Invalid request'); return value; }
function browserURL(value) {
  if (typeof value !== 'string' || value.length > 4096) throw Error('Invalid URL');
  const url = new URL(value);
  if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw Error('Only HTTPS or loopback HTTP is allowed');
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw Error('HTTP requires loopback');
  return url.href;
}
function browserRequestURL(value) {
  const url = new URL(value);
  if (url.protocol === 'http:' || url.protocol === 'https:') return browserURL(value);
  if (url.username || url.password || !['ws:', 'wss:'].includes(url.protocol)) throw Error('Invalid browser request URL');
  if (url.protocol === 'ws:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw Error('WS requires loopback');
  return url.href;
}
function partition(id) { return `persist:ezil-${uuid(id)}`; }
function senderAllowed(event, webContents, allowedURL) {
  return !!event.senderFrame && event.sender === webContents && event.senderFrame === webContents.mainFrame && event.senderFrame.url === allowedURL;
}
function surfaceSchema(input) {
  exact(input, ['op', 'workspaceId', 'surface']);
  if (!['surface.open', 'surface.focus'].includes(input.op) || !['code', 'browser'].includes(input.surface)) throw Error('Invalid surface');
  uuid(input.workspaceId);
  return input;
}
function schema(input) {
  exact(input, ['op', 'id', 'name', 'url', 'action', 'tab']);
  const fields = {
    status: [], guest: [], create: ['name'], import: ['name'], open: ['id'], remove: ['id'],
    browser: ['id', 'url'], editor: ['id'], stopEditor: ['id'], installer: [], settings: [],
    provider: ['action'], browserAction: ['action', 'url', 'tab']
  };
  if (!Object.hasOwn(fields, input.op)) throw Error('Unknown operation');
  exact(input, ['op', ...fields[input.op]]);
  if (fields[input.op].includes('id')) uuid(input.id);
  if (fields[input.op].includes('name')) name(input.name);
  if (input.url !== undefined) browserURL(input.url);
  if (input.op === 'provider' && !['azure', 'bedrock', 'remove'].includes(input.action)) throw Error('Invalid provider');
  if (input.op === 'browserAction') {
    if (!['new', 'select', 'close', 'navigate', 'back', 'forward', 'reload', 'devtools', 'state'].includes(input.action)) throw Error('Invalid browser action');
    if (['select', 'close'].includes(input.action) && (!Number.isInteger(input.tab) || input.tab < 0 || input.tab > 19)) throw Error('Invalid tab');
    if (input.action === 'navigate') browserURL(input.url);
  }
  return input;
}
function lockSession(session) {
  session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.on('select-client-certificate', event => event.preventDefault());
}
function lockRemote(wc) {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-attach-webview', event => event.preventDefault());
  for (const eventName of ['will-navigate', 'will-redirect', 'will-frame-navigate']) wc.on(eventName, (event, url) => {
    try { browserURL(typeof url === 'string' ? url : event.url); } catch { event.preventDefault(); }
  });
}
module.exports = { capabilities, uuid, name, exact, browserURL, browserRequestURL, partition, senderAllowed, surfaceSchema, schema, lockSession, lockRemote };
