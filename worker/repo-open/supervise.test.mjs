import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from './open.mjs';
const dead = pid => { assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); };

test('deadline terminates real stalled Git, waits for cleanup, preserves dirty/unrelated state and permits retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-supervisor-'));
    const sockets = new Set();
    const server = createServer((_req, _res) => {}); // Git connects but never gets a response.
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
        execFileSync('git', ['init', '-q', join(root, 'checkout')]);
        await writeFile(join(root, 'checkout', 'dirty.txt'), 'keep dirty');
        await mkdir(join(root, 'other.lock')); await writeFile(join(root, 'other.lock', 'owner'), 'other');
        const fixture = join(root, 'cli.mjs');
        await writeFile(fixture, `
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
const root=process.argv[2], mode=process.argv[3], lock=join(root,'own.lock'), temp=join(root,'own.tmp');
mkdirSync(lock); const identity=statSync(lock); mkdirSync(temp);
if(mode==='retry') { execFileSync('git',['-C',join(root,'checkout'),'rev-parse','--show-toplevel']); rmSync(temp,{recursive:true}); rmSync(lock,{recursive:true}); console.log(JSON.stringify({ok:true})); }
else {
 process.on('SIGTERM',()=>{}); // cooperative CLI: let child settle, then its finally runs.
 const git=spawn('git',['ls-remote','http://127.0.0.1:${server.address().port}/stall.git'],{stdio:'ignore'});
 writeFileSync(join(root,'pids'),JSON.stringify([process.pid,git.pid]));
 git.on('close',()=>{ const now=statSync(lock); if(now.ino===identity.ino && now.dev===identity.dev){rmSync(temp,{recursive:true});rmSync(lock,{recursive:true});} process.exit(1); });
}
`);
        await assert.rejects(execute(process.execPath, [fixture, root, 'stall'], { timeout: 800, grace: 300, maxBuffer: 65536, shell: false }), error => error.code === 124);
        for (const pid of JSON.parse(await readFile(join(root, 'pids'), 'utf8'))) dead(pid);
        await assert.rejects(stat(join(root, 'own.lock')), { code: 'ENOENT' });
        await assert.rejects(stat(join(root, 'own.tmp')), { code: 'ENOENT' });
        process.kill(unrelated.pid, 0);
        assert.equal(await readFile(join(root, 'checkout', 'dirty.txt'), 'utf8'), 'keep dirty');
        assert.equal(await readFile(join(root, 'other.lock', 'owner'), 'utf8'), 'other');
        assert.equal(JSON.parse((await execute(process.execPath, [fixture, root, 'retry'], { timeout: 800, maxBuffer: 65536, shell: false })).stdout).ok, true);
    } finally {
        unrelated.kill(); await once(unrelated, 'close');
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    }
});

test('forced termination reaps orphan descendants and never deletes unknown operation files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-supervisor-kill-'));
    try {
        const fixture = join(root, 'cli.mjs');
        await writeFile(fixture, `
import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
writeFileSync(process.argv[2],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);
`);
        const marker = join(root, 'foreign.lock'); await writeFile(marker, 'do not delete');
        await assert.rejects(execute(process.execPath, [fixture, join(root, 'pids')], { timeout: 800, grace: 150, maxBuffer: 65536, shell: false }), error => error.code === 126);
        for (const pid of JSON.parse(await readFile(join(root, 'pids'), 'utf8'))) dead(pid);
        assert.equal(await readFile(marker, 'utf8'), 'do not delete');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('an uncooperative parent killed by TERM requires recovery, even without escalation', async () => {
    await assert.rejects(execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 250, grace: 150, maxBuffer: 65536, shell: false }), error => error.code === 126);
});
