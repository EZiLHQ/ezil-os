import assert from 'node:assert/strict';

/** Prove the restored shortcut writes the test file, then read it from disk. */
export async function verifyEditorShortcut({ read, append, pressShortcut, revert, expected, proof }) {
  const before = await read();
  const reloadProbe = `unsaved-reload-probe:${proof}`;
  assert.ok(before.includes(expected), 'Workspace marker not restored');
  assert.ok(!before.includes(proof), 'Shortcut test proof must be a fresh edit');
  await append(proof);
  assert.ok((await read()).includes(proof), 'Shortcut test edit did not reach Code');
  await pressShortcut();
  // This second edit is deliberately unsaved. Its disappearance establishes
  // that Revert actually reloaded disk instead of silently leaving the buffer.
  await append(reloadProbe);
  assert.ok((await read()).includes(reloadProbe), 'Disk reload probe did not reach Code');
  // Revert reads the file from disk. Buffered editor text alone cannot prove a
  // keybinding saved it. The hosted fixture explicitly disables automatic save.
  await revert();
  const persisted = await read();
  assert.ok(!persisted.includes(reloadProbe), 'Disk reload did not discard the unsaved probe');
  assert.ok(persisted.includes(expected) && persisted.includes(proof), 'Restored keybinding did not save the workspace edit');
  return persisted;
}
