import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { previewScript } from './script.generated';

test('browser generator check rejects stale sources without rewriting the embedded payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ezil-preview-script-'));
    try {
        for (const file of ['contract.ts', 'messages.ts', 'state.ts', 'webview.ts', 'build-script.ts']) copyFileSync(new URL(file, import.meta.url), join(dir, file));
        const run = (...args: string[]) => Bun.spawnSync([process.execPath, 'run', join(dir, 'build-script.ts'), ...args]);
        expect(run().exitCode).toBe(0);
        expect(run('--check').exitCode).toBe(0);
        expect(Bun.spawnSync([process.execPath, 'run', join(dir, 'build-script.ts'), '--check'], { cwd: dir }).exitCode).toBe(0);
        const original = readFileSync(join(dir, 'script.generated.ts'), 'utf8');
        writeFileSync(join(dir, 'webview.ts'), '\nconsole.log("preview generation regression");\n', { flag: 'a' });
        const stale = run('--check');
        expect(stale.exitCode).toBe(1);
        expect(stale.stderr.toString()).toContain('stale');
        expect(readFileSync(join(dir, 'script.generated.ts'), 'utf8')).toBe(original);
        expect(run().exitCode).toBe(0);
        expect(run('--check').exitCode).toBe(0);
        expect(readFileSync(join(dir, 'script.generated.ts'), 'utf8')).toContain('preview generation regression');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('VSIX contains the complete embedded browser payload, serializer and command contribution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ezil-preview-vsix-'));
    try {
        const result = await Bun.build({ entrypoints: [new URL('../extension.ts', import.meta.url).pathname], target: 'node', format: 'cjs', external: ['vscode'] });
        expect(result.success).toBe(true);
        const text = await result.outputs[0]!.text();
        const embedded = text.match(/\bvar previewScript = ([\s\S]*?);\n\n\/\/ [^\n]*preview\/html\.ts/);
        expect(embedded).not.toBeNull();
        expect(runInNewContext(embedded![1]!)).toBe(previewScript);
        const bundle = join(dir, 'extension.js'), archive = join(dir, 'extension.vsix');
        writeFileSync(bundle, text);
        const packed = Bun.spawnSync(['python3', new URL('../../../../worker/ezil-models/package-vsix.py', import.meta.url).pathname,
            new URL('../../', import.meta.url).pathname, bundle, archive]);
        expect(packed.stderr.toString()).toBe('');
        expect(packed.exitCode).toBe(0);
        const checked = Bun.spawnSync(['python3', '-c', `
import json, pathlib, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.read('extension/dist/extension.js') == pathlib.Path(sys.argv[2]).read_bytes()
    package = json.loads(archive.read('extension/package.json'))
    assert package['main'] == './dist/extension.js'
    assert any(command['command'] == 'ezil.preview.open' for command in package['contributes']['commands'])
    print(json.dumps(archive.namelist()))
`, archive, bundle]);
        expect(checked.stderr.toString()).toBe('');
        expect(checked.exitCode).toBe(0);
        expect(JSON.parse(checked.stdout.toString())).toEqual([
            '[Content_Types].xml', 'extension.vsixmanifest', 'extension/ATTRIBUTIONS.md', 'extension/LICENSE.txt',
            'extension/dist/extension.js', 'extension/examples/models.example.json', 'extension/package.json',
            'extension/readme.md', 'extension/schema/models.schema.json',
        ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('VSIX packager refuses a bundle missing the preview runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ezil-preview-vsix-'));
    try {
        const bundle = join(dir, 'extension.js');
        writeFileSync(bundle, 'module.exports = {};');
        const result = Bun.spawnSync(['python3', new URL('../../../../worker/ezil-models/package-vsix.py', import.meta.url).pathname,
            new URL('../../', import.meta.url).pathname, bundle, join(dir, 'extension.vsix')]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain('preview runtime');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
