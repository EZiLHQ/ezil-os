// Opt-in test: the private bundle stays outside this repository. No live auth/network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { execute, openRepository } from './open.mjs';
const bundle = process.env.EZIL_TEST_PRIVATE_CLI_BUNDLE;
const pin = JSON.parse(await readFile(new URL('./cli-pin.json', import.meta.url)));
const repo = 'https://github.ezil.work/team/fixture.git';
const intent = { repo, userId: '11111111-1111-4111-8111-111111111111' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const missing = pid => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
async function fixture() {
    assert.equal(createHash('sha256').update(await readFile(bundle)).digest('hex'), pin.sha256, 'test exact pinned private bundle');
    assert.equal(execFileSync(process.execPath, [bundle, '--version'], { encoding: 'utf8' }).trim(), 'ezil ' + pin.version);
    const root = await mkdtemp(join(tmpdir(), 'os-packaged-cli-'));
    const workspace = join(root, 'workspace'), auth = join(root, 'auth'), scratch = join(root, 'scratch'), bin = join(root, 'bin');
    for (const path of [workspace, auth, scratch, bin]) await mkdir(path);
    const serverSockets = new Set();
    let stallGrant = false;
    const server = createServer((req, res) => {
        if (req.url.startsWith('/stall.git')) return; // a real Git HTTP transport blocks here
        const data = req.url === '/cli/whoami' ? {
            account: { id: 'synthetic-works-account', email: 'test@example.invalid', role: 'builder' },
            session: { id: '11111111-1111-4111-8111-111111111111', device: 'isolated', os: 'linux', expiresAt: '2100-01-01T00:00:00.000Z' },
            repositories: [{ project: 'fixture', projectId: 'fixture', repository: 'fixture', access: 'read', taskPublicId: null, cloneUrl: repo }],
        } : { username: 'ezil', password: 'egg_' + 'a'.repeat(64), password_expiry_utc: 4102444800, scope: 'read' };
        if (req.url === '/cli/git-grant' && stallGrant) return;
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data));
    });
    server.on('connection', socket => { serverSockets.add(socket); socket.on('close', () => serverSockets.delete(socket)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    await writeFile(join(auth, 'cli-session.json'), JSON.stringify({ [origin]: {
        apiOrigin: origin, sessionId: 'synthetic', accessToken: 'eca_synthetic', refreshToken: 'ecr_synthetic', accessExpiresAt: '2100-01-01T00:00:00.000Z',
    } }), { mode: 0o600 });
    const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const source = join(root, 'source'); execFileSync(git, ['init', '-q', source]);
    await writeFile(join(source, 'fixture.txt'), 'known fixture\n');
    execFileSync(git, ['-C', source, 'add', 'fixture.txt']);
    execFileSync(git, ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    await writeFile(join(source, 'fixture.txt'), 'unrelated dirty source\n');
    // Only transport is substituted. The pinned CLI performs auth, grant, lock and cleanup.
    const shim = `#!/usr/bin/env node
const cp=require('node:child_process'),fs=require('node:fs');
const args=process.argv.slice(2),git=${JSON.stringify(git)};
if(!args.includes('clone')) process.exit(cp.spawnSync(git,args,{stdio:'inherit'}).status??1);
const target=args.at(-1);
if(process.env.OS_TEST_MODE==='success') {
 let r=cp.spawnSync(git,['clone','--no-hardlinks','--',${JSON.stringify(source)},target],{stdio:'ignore'});
 if(r.status===0)r=cp.spawnSync(git,['-C',target,'remote','set-url','origin',${JSON.stringify(repo)}],{stdio:'ignore'});
 process.exit(r.status??1);
}
fs.mkdirSync(target);fs.writeFileSync(target+'/partial','preserve owned state');
const child=cp.spawn(git,['ls-remote',${JSON.stringify(origin + '/stall.git')}],{stdio:'ignore'});
process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});
child.on('close',()=>{if(process.env.OS_TEST_MODE!=='stubborn')process.exit(1)});
fs.writeFileSync(${JSON.stringify(join(root, 'pids'))},JSON.stringify([process.ppid,process.pid,child.pid]));
setInterval(()=>{},1000);
`;
    await writeFile(join(bin, 'git'), shim, { mode: 0o700 });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await writeFile(join(root, 'unrelated.txt'), 'preserve unrelated');
    const options = mode => ({ root: workspace, cli: bundle, verifyPin: false, timeoutMs: 1200,
        run: (cli, args, opts) => execute(process.execPath, [cli, ...args], { ...opts, env: { ...process.env,
            PATH: bin + ':' + process.env.PATH, EZIL_HOME: auth, EZIL_CLI_STORE: 'file', EZIL_API_ORIGIN: origin,
            TMPDIR: scratch, OS_TEST_MODE: mode,
        } }),
    });
    const folder = join(workspace, '.ezil-repositories', createHash('sha256').update(intent.userId).digest('hex'), createHash('sha256').update(repo).digest('hex'));
    const lock = join(dirname(folder), '.' + basename(folder) + '.ezil-clone-lock');
    return { root, folder, lock, scratch, options, setStallGrant: value => { stallGrant = value; },
        async pids() { for (let i=0;i<100;i++) { try { return JSON.parse(await readFile(join(root,'pids'),'utf8')); } catch { await sleep(10); } } throw Error('CLI child barrier not reached'); },
        async preserved() { process.kill(unrelated.pid,0); assert.equal(await readFile(join(root,'unrelated.txt'),'utf8'),'preserve unrelated'); assert.equal(await readFile(join(source,'fixture.txt'),'utf8'),'unrelated dirty source\n'); },
        async close() { unrelated.kill(); await once(unrelated,'close'); for(const s of serverSockets)s.destroy(); await new Promise(resolve=>server.close(resolve)); await rm(root,{recursive:true,force:true}); },
    };
}
for (const mode of ['normal', 'stubborn', 'os-forced']) test(`packaged CLI: ${mode} through OS supervisor`, { skip: !bundle, timeout: 15000 }, async () => {
    const f = await fixture();
    try {
        const started = performance.now();
        const operation = openRepository(intent, f.options(mode === 'normal' ? 'block' : 'stubborn')).catch(error => error);
        const pids = await f.pids();
        if (mode === 'os-forced') process.kill(pids[0], 'SIGSTOP'); // only the proven test CLI PID
        const result = await operation;
        const elapsed = performance.now() - started;
        assert.equal(result.message, mode === 'normal' ? 'repo_timeout' : 'repo_recovery_required');
        for (const pid of pids) missing(pid);
        await f.preserved();
        if (mode === 'normal') {
            assert.equal((await readdir(dirname(f.folder))).length, 0, 'owned lock/temp cleaned');
            assert.deepEqual(await readdir(f.scratch), []);
            const first = await openRepository(intent, f.options('success'));
            assert.equal(first.status, 'cloned');
            assert.equal(await readFile(join(first.folder,'fixture.txt'),'utf8'),'known fixture\n');
            await writeFile(join(first.folder,'fixture.txt'),'dirty fixture\n');
            f.setStallGrant(true);
            await assert.rejects(openRepository(intent,f.options('success')), /repo_timeout/);
            assert.equal(await readFile(join(first.folder,'fixture.txt'),'utf8'),'dirty fixture\n');
            f.setStallGrant(false);
            assert.equal((await openRepository(intent,f.options('success'))).status,'reused');
            assert.equal(await readFile(join(first.folder,'fixture.txt'),'utf8'),'dirty fixture\n');
        } else {
            assert.ok((await readdir(dirname(f.folder))).includes(basename(f.lock)));
            const before = await readdir(dirname(f.folder));
            const temp = before.find(name=>name.startsWith('.ezil-clone-'));
            assert.equal(await readFile(join(dirname(f.folder),temp,'checkout','partial'),'utf8'),'preserve owned state');
            await assert.rejects(openRepository(intent,f.options('success')), /repo_timeout/);
            assert.deepEqual(await readdir(dirname(f.folder)),before, 'cancelled retry must preserve unknown lock/temp');
        }
        // Production grace is exactly 3000ms. Deadline is shortened only for this test.
        assert.ok(elapsed < 1200 + 3000 + 500, `deadline + grace exceeded: ${elapsed}`);
        if(mode==='os-forced') assert.ok(elapsed >= 1200+2900, `forced branch did not exercise 3s grace: ${elapsed}`);
        console.log(`measured ${mode}: ${Math.round(elapsed)}ms total; configured deadline=1200ms grace=3000ms`);
    } finally { await f.close(); }
});
