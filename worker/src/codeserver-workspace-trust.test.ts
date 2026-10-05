import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scripts = join(import.meta.dir, '..', 'scripts');
const helper = join(scripts, 'editor-state.sh');
const saved = '// keep my comment\n{ "workbench.colorTheme": "Default Dark Modern", }\n';

// File operations execute the shipped helper. Lock contention is a separate
// Linux test; this shim makes the same restoration tests portable to macOS.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'editor-state-'));
  const workspace = join(root, 'workspace');
  const userData = join(root, 'user');
  mkdirSync(join(workspace, '.ezil'), { recursive: true });
  const run = (command: string) => spawnSync('bash', ['-c',
    'set -euo pipefail\nflock() { return 0; }\n. "$1"\n' + command,
    'bash', helper, userData, workspace], { encoding: 'utf8' });
  return { root, workspace, userData, run,
    backup: (file = 'settings.json') => join(workspace, '.ezil', file),
    live: (file = 'settings.json') => join(userData, 'User', file) };
}

describe('editor settings survive runtime replacement', () => {
  it('restores JSONC settings and keybindings before defaults, then captures immediate edits', () => {
    const f = fixture();
    try {
      writeFileSync(f.backup(), saved);
      writeFileSync(f.backup('keybindings.json'), '// custom\n[{"key":"ctrl+alt+k","command":"workbench.action.files.save"}]');
      expect(f.run('ezil_editor_prepare "$2" "$3"').status).toBe(0);
      expect(readFileSync(f.live(), 'utf8')).toBe(saved);
      expect(readFileSync(f.live('keybindings.json'), 'utf8')).toBe(readFileSync(f.backup('keybindings.json'), 'utf8'));
      writeFileSync(f.live(), saved.replace('Modern', 'Plus'));
      expect(f.run('ezil_editor_capture "$2" "$3"').status).toBe(0);
      expect(readFileSync(f.backup(), 'utf8')).toBe(saved.replace('Modern', 'Plus'));
    } finally { rmSync(f.root, { recursive: true }); }
  });

  it('seeds defaults only without a saved file and preserves warm runtime edits', () => {
    const f = fixture();
    try {
      expect(f.run('ezil_editor_prepare "$2" "$3"').status).toBe(0);
      expect(JSON.parse(readFileSync(f.live(), 'utf8'))['security.workspace.trust.enabled']).toBe(false);
      writeFileSync(f.live(), saved);
      expect(f.run('ezil_editor_prepare "$2" "$3"').status).toBe(0);
      expect(readFileSync(f.live(), 'utf8')).toBe(saved);
    } finally { rmSync(f.root, { recursive: true }); }
  });

  it('preserves an intentionally empty saved settings file', () => {
    const f = fixture();
    try {
      writeFileSync(f.backup(), '');
      expect(f.run('ezil_editor_prepare "$2" "$3"').status).toBe(0);
      expect(readFileSync(f.live(), 'utf8')).toBe('');
    } finally { rmSync(f.root, { recursive: true }); }
  });

  it('a failed restore cannot authorize capture or replace the backup with defaults', () => {
    const f = fixture();
    try {
      writeFileSync(f.backup(), saved);
      const result = f.run('ezil_editor_atomic_copy() { return 1; }; ezil_editor_prepare "$2" "$3"');
      expect(result.status).toBe(1);
      expect(existsSync(join(f.userData, '.ezil-state-ready'))).toBe(false);
      mkdirSync(join(f.userData, 'User'), { recursive: true });
      writeFileSync(f.live(), '{}');
      expect(f.run('ezil_editor_capture "$2" "$3"').status).toBe(1);
      expect(readFileSync(f.backup(), 'utf8')).toBe(saved);
    } finally { rmSync(f.root, { recursive: true }); }
  });

  it('failed atomic copy leaves durable bytes intact and reports capture failure', () => {
    const f = fixture();
    try {
      writeFileSync(f.backup(), saved);
      expect(f.run('ezil_editor_prepare "$2" "$3"').status).toBe(0);
      writeFileSync(f.live(), '{}');
      expect(f.run('cp() { return 1; }; ezil_editor_capture "$2" "$3"').status).toBe(1);
      expect(readFileSync(f.backup(), 'utf8')).toBe(saved);
    } finally { rmSync(f.root, { recursive: true }); }
  });

  it('captures installed extension IDs before checkpoint and retains failed restore IDs', () => {
    const f = fixture();
    try {
      writeFileSync(f.backup('extensions.txt'), 'saved.extension\n');
      expect(f.run('ezil_editor_prepare "$2" "$3"').status).toBe(0);
      mkdirSync(join(f.root, 'extensions', 'new.extension-1.2.3'), { recursive: true });
      expect(f.run('export CODE_SERVER_EXTENSIONS_DIR="$(dirname "$2")/extensions"; ezil_editor_capture "$2" "$3"').status).toBe(0);
      expect(readFileSync(f.backup('extensions.txt'), 'utf8')).toBe('new.extension\nsaved.extension\n');
      expect(f.run('timeout() { return 1; }; ezil_editor_restore_extensions "$2" "$3" "$(dirname "$2")/extensions" false').status).toBe(0);
      expect(readFileSync(f.backup('extensions.txt'), 'utf8')).toContain('saved.extension');
    } finally { rmSync(f.root, { recursive: true }); }
  });

  it('keeps the configured legacy editor-state directory compatible', () => {
    const f = fixture();
    try {
      mkdirSync(join(f.workspace, 'legacy'));
      writeFileSync(join(f.workspace, 'legacy', 'settings.json'), saved);
      expect(f.run('export EZIL_EDITOR_STATE_DIR="$3/legacy"; ezil_editor_prepare "$2" "$3"; ezil_editor_capture "$2" "$3"').status).toBe(0);
      expect(readFileSync(f.live(), 'utf8')).toBe(saved);
      expect(existsSync(f.backup())).toBe(false);
    } finally { rmSync(f.root, { recursive: true }); }
  });

  it('does not copy settings into a different computer workspace', () => {
    const f = fixture();
    try {
      expect(f.run('ezil_editor_prepare "$2" "$3"').status).toBe(0);
      expect(f.run('ezil_editor_capture "$2" "$3/another"').status).toBe(1);
    } finally { rmSync(f.root, { recursive: true }); }
  });

  it('both launch paths use the helper before code-server reads settings', () => {
    for (const [file, launch] of [['start-neko.sh', 'supervise_app codeserver'], ['start-codeserver.sh', 'nohup code-server']]) {
      const source = readFileSync(join(scripts, file), 'utf8');
      expect(source).toContain('/editor-state.sh"');
      const restore = source.indexOf('if ! ezil_editor_prepare');
      expect(restore).toBeGreaterThan(0);
      expect(source.indexOf(launch)).toBeGreaterThan(restore);
      expect(source).not.toContain('<<\'CODESERVER_SETTINGS_JSON');
    }
  });
});
