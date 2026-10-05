import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyEditorShortcut } from './editor-shortcut.mjs';

function editor({ shortcut = true, writable = true, input = true } = {}) {
  let disk = 'workspace-marker', buffer = disk;
  const actions = [];
  return {
    read: async () => buffer,
    append: async proof => { actions.push('edit'); if (input) buffer += `\n${proof}`; },
    pressShortcut: async () => { actions.push('shortcut'); if (shortcut && writable) disk = buffer; },
    revert: async () => { actions.push('revert'); buffer = disk; },
    expected: 'workspace-marker', proof: 'shortcut-proof', actions,
    durable: () => disk,
  };
}

test('restored shortcut saves an edit that survives a disk reload', async () => {
  const fixture = editor();
  const restored = await verifyEditorShortcut(fixture);
  assert.equal(restored, 'workspace-marker\nshortcut-proof');
  assert.equal(restored, fixture.durable());
  assert.deepEqual(fixture.actions, ['edit', 'shortcut', 'revert']);
});

test('a saved binding file cannot pass when the shortcut is not active', async () => {
  const fixture = editor({ shortcut: false });
  await assert.rejects(verifyEditorShortcut(fixture), /Restored keybinding did not save/);
  assert.equal(fixture.durable(), 'workspace-marker');
});

test('a shortcut that edits memory but fails to write disk cannot pass', async () => {
  const fixture = editor({ writable: false });
  await assert.rejects(verifyEditorShortcut(fixture), /Restored keybinding did not save/);
  assert.equal(fixture.durable(), 'workspace-marker');
});

test('lost editor input fails before a shortcut can claim success', async () => {
  const fixture = editor({ input: false });
  await assert.rejects(verifyEditorShortcut(fixture), /edit did not reach Code/);
  assert.deepEqual(fixture.actions, ['edit']);
});

test('previously saved proof cannot stand in for a new shortcut edit', async () => {
  const fixture = editor();
  fixture.proof = 'workspace-marker';
  await assert.rejects(verifyEditorShortcut(fixture), /proof must be a fresh edit/);
  assert.deepEqual(fixture.actions, []);
});
