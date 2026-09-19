'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { preferences, readDesktop, writeDesktop } = require('../src/desktop-state.cjs');
const { runtimeSchema } = require('../src/policy.cjs');
const { Workspaces } = require('../src/workspaces.cjs');
test('opening Settings reports provider configuration without initializing Keychain', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-keychain-status-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const { Vault } = require('../src/broker.cjs');
  const vault = new Vault(root, { isEncryptionAvailable() { throw Error('Unexpected Keychain access'); } });
  assert.deepEqual(vault.status(), { configured: false });
});
test('desktop state persists per workspace without origin, project paths or arbitrary keys', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-desktop-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const store = new Workspaces(root), a = store.create('A'), b = store.create('B');
  const value = { wallpaper: 'aurora', accent: 'violet', previewPort: 3000, browser: { tabs: ['', 'https://example.com/', 'http://localhost:3000/'], activeIndex: 2 }, layout: [{ app: 'code', x: 1, y: 2, width: 900, height: 600, minimized: false }] };
  runtimeSchema({ op: 'desktop.write', workspaceId: a.id, preferences: value });
  writeDesktop(a, value);
  assert.deepEqual(readDesktop(new Workspaces(root).get(a.id)), value); assert.deepEqual(readDesktop(b), {});
  for (const invalid of [{ source: '/private' }, { layout: [{ ...value.layout[0], url: 'file:///etc/passwd' }] }, { layout: [value.layout[0], value.layout[0]] }, { accent: '<script>' }, { previewPort: 80 }]) assert.throws(() => preferences(invalid));
  assert.throws(() => runtimeSchema({ op: 'desktop.read', workspaceId: a.id, path: '/tmp' }));
});
test('saved tabs are bounded canonical safe destinations, not paths, scripts or arbitrary data', () => {
  for (const browser of [
    { tabs: [], activeIndex: 0 }, { tabs: Array(21).fill(''), activeIndex: 0 }, { tabs: [''], activeIndex: 1 },
    { tabs: [''], activeIndex: -1 }, { tabs: [''], activeIndex: 0.5 }, { tabs: [''], activeIndex: 0, extension: '/private' },
    ...['file:///private', 'javascript:alert(1)', 'https://user:pass@example.com/', 'http://example.com/', 'example.com', 'https://example.com', 'https://example.com/' + 'a'.repeat(4096)].map(url => ({ tabs: [url], activeIndex: 0 })),
  ]) assert.throws(() => preferences({ browser }));
  const value = { browser: { tabs: Array(20).fill('https://example.com/'), activeIndex: 19 } };
  assert.deepEqual(preferences(value), value);
});
