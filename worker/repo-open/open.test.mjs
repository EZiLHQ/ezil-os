import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRepository, validateIntent } from './open.mjs';
const intent = { userId: '11111111-1111-4111-8111-111111111111', repo: 'https://github.ezil.work/team/fixture.git' };
async function fixture(fn) { const root = await mkdtemp(join(tmpdir(), 'repo-open-')); try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); } }
test('canonical URL rejects traversal, credentials, shell syntax, duplicate git suffix and namespace ambiguity', () => {
    for (const repo of ['https://github.ezil.work/team/../r.git','https://github.ezil.work/team/a..b.git', 'https://github.ezil.work/team/a.git.git', 'https://github.ezil.work/Team/r.git', 'https://github.ezil.work/a.b/r.git', 'https://user:password@github.ezil.work/team/r.git', 'https://github.ezil.work/team/r.git?x=1','https://github.ezil.work/team/r.git#x','https://github.ezil.work/team/$(id).git', 'https://github.ezil.work/team/%2fr.git', 'git@github.ezil.work:team/r.git']) assert.throws(() => validateIntent({ ...intent, repo }));
    assert.throws(() => validateIntent({ ...intent, folder: '/tmp' }));
});
test('safe argv and stable user/full URL mapping preserve dirty files on reopen', () => fixture(async root => {
    const folders = [];
    const run = async (file, args, options) => {
        assert.equal(file, '/pinned/ezil'); assert.equal(options.shell, false);
        assert.deepEqual(args.slice(0, 3), ['clone', intent.repo, '--directory']);
        const folder = args[3]; folders.push(folder);
        await mkdir(folder, { recursive: true });
        return { stdout: JSON.stringify({ canonicalUrl: intent.repo, folder, accountId: 'works-account', status: folders.length === 1 ? 'cloned' : 'reused' }) };
    };
    const options = { root, cli: '/pinned/ezil', run, verifyPin: false };
    const first = await openRepository(intent, options);
    await writeFile(join(first.folder, 'dirty.txt'), 'keep me');
    const second = await openRepository(intent, options);
    assert.equal(second.folder, first.folder); assert.equal(await readFile(join(first.folder, 'dirty.txt'), 'utf8'), 'keep me');
    assert.equal(folders.length, 2); // every reopen rechecks CLI authorization
}));
test('symlink ancestors and CLI folder substitutions fail closed', () => fixture(async root => {
    await symlink('/tmp', join(root, '.ezil-repositories'));
    await assert.rejects(openRepository(intent, { root, verifyPin: false, run: () => assert.fail('must not execute') }));
    await rm(join(root, '.ezil-repositories'));
    await assert.rejects(openRepository(intent, { root, verifyPin: false, run: async () => ({ stdout: JSON.stringify({ canonicalUrl: intent.repo, folder: '/tmp', accountId: 'a', status: 'reused' }) }) }), /repo_invalid_result/);
}));
test('auth and grant refusal expose bounded errors without credential output', () => fixture(async root => {
    for (const [code, expected] of [['auth-required', 'repo_auth_required'], ['repository-not-authorized', 'repo_not_authorized']]) {
        await assert.rejects(openRepository(intent, { root, verifyPin: false, run: async () => { throw Object.assign(new Error('SECRET'), { stdout: JSON.stringify({ error: { code, message: 'SECRET' } }) }); } }), new RegExp(expected));
    }
}));
