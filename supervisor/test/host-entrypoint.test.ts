import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('host and delivery entrypoints execute through the installed release-directory symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'ezil-host-entry-'));
    const source = fileURLToPath(new URL('../src/host.ts', import.meta.url));
    const alias = join(root, 'release');
    try {
        symlinkSync(dirname(source), alias, process.platform === 'win32' ? 'junction' : 'dir');
        const cases = [
            { name: 'host', args: [], stdout: '{"event":"host_arguments_invalid"}\n', stderr: '' },
            { name: 'prepare', args: [], stdout: '', stderr: '{"event":"host_preparation_failed","code":"preparation_arguments_invalid"}\n' },
            { name: 'configuration-receiver', args: ['invalid'], stdout: '', stderr: '{"code":"configuration_delivery_failed"}\n' },
            { name: 'delivery-operation', args: ['invalid'], stdout: '', stderr: '{"code":"delivery_operation_failed"}\n' },
            { name: 'delivery-executor', args: [], stdout: '', stderr: '{"code":"delivery_execution_failed"}\n' },
            { name: 'data-mount-receiver', args: ['invalid'], stdout: '', stderr: '{"code":"data_mount_delivery_failed"}\n' },
        ];
        for (const value of cases) for (const directory of [dirname(source), alias]) {
            const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx',
                join(directory, `${value.name}.ts`), ...value.args], { encoding: 'utf8', timeout: 10_000,
                env: { PATH: process.env.PATH } });
            assert.ifError(result.error);
            assert.equal(result.status, 1, value.name);
            assert.equal(result.stdout, value.stdout, value.name);
            assert.equal(result.stderr, value.stderr, value.name);
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('importing host CLI modules does not perform operations or require configuration', () => {
    for (const name of ['host', 'prepare', 'configuration-receiver', 'delivery-operation', 'delivery-executor', 'data-mount', 'data-mount-receiver']) {
        const url = new URL(`../src/${name}.ts`, import.meta.url).href;
        const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx',
            '--input-type=module', '--eval', `await import(${JSON.stringify(url)})`], {
            encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH },
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, name);
        assert.equal(result.stdout, '', name);
        assert.equal(result.stderr, '', name);
    }
});
