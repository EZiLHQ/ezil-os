import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareManifest } from './prepare-migration-manifest.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../../../.github/production-migrations.json', import.meta.url)));
function capture() {
    let before = manifest.initialCatalog.digest;
    return { rehearsal: false, baseline: before, migrations: manifest.sources.filter(s => /hardening\/002[2-5]_/.test(s.path)).map((s, i) => {
        const after = String(i + 1).repeat(64);
        const row = { id: s.path.split('/').at(-1).replace('.sql', '').replaceAll('_', '-'), path: s.path, sha256: s.sha256, before, after };
        before = after;
        return row;
    }) };
}
test('produces only four executable entries and preserves the existing manifest fields', async () => {
    const result = await prepareManifest(root, capture());
    assert.equal(result.migrations.length, 4);
    assert.equal(result.sources.filter(s => s.kind === 'migration').length, 4);
    assert.deepEqual(result.initialCatalog, manifest.initialCatalog);
    assert.deepEqual(result.reviewedEventTriggers, manifest.reviewedEventTriggers);
});
for (const [name, mutate] of [
    ['rehearsal', c => c.rehearsal = true],
    ['stale baseline', c => c.baseline = '0'.repeat(64)],
    ['partial chain', c => c.migrations.pop()],
    ['edited SQL', c => c.migrations[0].sha256 = '0'.repeat(64)],
    ['broken chain', c => c.migrations[1].before = '0'.repeat(64)],
    ['unexpected path', c => c.migrations[0].path = '../other.sql'],
]) test(`refuses ${name}`, async () => { const c = capture(); mutate(c); await assert.rejects(prepareManifest(root, c)); });
