// Private, real-container acceptance. No production credentials or services.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { chromium } from 'playwright';

const image = process.env.EZIL_RETICLE_IMAGE;
const builder = process.env.EZIL_RETICLE_BUILDER_IMAGE;
const workVolume = process.env.EZIL_RETICLE_WORK_VOLUME;
for (const [name, value] of Object.entries({ EZIL_RETICLE_IMAGE: image,
    EZIL_RETICLE_BUILDER_IMAGE: builder, EZIL_RETICLE_WORK_VOLUME: workVolume })) {
    if (!value) throw new Error(`missing_configuration: ${name}`);
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(workVolume)) throw new Error('invalid_work_volume');
const id = `ezil-reticle-test-${randomUUID()}`;
const output = resolve(process.env.EZIL_RETICLE_EVIDENCE_DIR ?? join(tmpdir(), id));
const temporary = await mkdtemp(join(tmpdir(), `${id}-`));
const containers = [], networks = [], volumes = [];
const label = ['--label', `org.ezil.acceptance=${id}`];
let browser;
let stage = 'configuration';

function docker(args, timeout = 30_000) {
    try {
        return execFileSync('docker', args, { encoding: 'utf8', timeout,
            maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
        const code = String(error.stderr).match(/\b(E[A-Z_]{3,})\b/)?.[1] ?? 'failed';
        throw new Error(`docker_${args[0]}_${code}`); // never print container logs or tokens
    }
}
function inspect(name) { return JSON.parse(docker(['inspect', name]))[0]; }
function launch(name, args) {
    containers.push(name); // also clean up a partially created container
    return docker(['run', '-d', '--name', name, ...label, '--platform', 'linux/amd64', ...args]);
}
const restricted = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '128', '--cpus', '1', '--memory', '768m', '--tmpfs', '/tmp:rw,nosuid,size=256m'];
const mount = (volume, target, subpath, readonly = false) => [
    '--mount', `type=volume,source=${volume},target=${target},volume-subpath=${subpath},volume-nocopy${readonly ? ',readonly' : ''}`,
];
const execute = (name, script, ...args) => docker(['exec', name, 'node', '-e', script, ...args]);
const readToken = (name) => execute(name,
    'process.stdout.write(require("fs").readFileSync("/data/reticle/pairing-token","utf8").trim())');
async function status(origin, token) {
    const response = await fetch(new URL('/status', origin), { redirect: 'error',
        headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return response.status;
}
async function ready(origin, token) {
    for (let attempt = 0; attempt < 60; attempt++) {
        try { if (await status(origin, token) === 200) return; } catch { /* bounded startup */ }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('daemon_not_ready');
}
function port(name, internal) {
    const binding = inspect(name).NetworkSettings.Ports[`${internal}/tcp`];
    assert.equal(binding.length, 1);
    assert.equal(binding[0].HostIp, '127.0.0.1');
    return Number(binding[0].HostPort);
}
async function operate(origin, token, target, screenshot) {
    const authenticatedFetch = (input, init = {}) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.origin !== origin) throw new Error('unexpected_mcp_origin');
        const headers = new Headers(init.headers);
        headers.set('authorization', `Bearer ${token}`);
        return fetch(url, { ...init, headers, redirect: 'error' });
    };
    const client = new Client({ name: 'ezil-private-acceptance', version: '1.0.0' }, { capabilities: {} });
    const page = await browser.newPage();
    const decode = (result) => {
        if (result.isError) throw new Error('reticle_tool_failed');
        return JSON.parse(result.content.find(item => item.type === 'text').text);
    };
    try {
        await client.connect(new SSEClientTransport(new URL('/mcp/sse', origin), { fetch: authenticatedFetch }));
        const surface = await client.listTools();
        for (const name of ['reticle_look', 'reticle_act', 'reticle_session']) {
            assert.ok(surface.tools.some(tool => tool.name === name), 'live MCP surface');
        }
        await page.goto(target, { waitUntil: 'networkidle' });
        await page.locator('[data-testid="counter"]').waitFor();
        let sessions;
        for (let attempt = 0; attempt < 30; attempt++) {
            sessions = decode(await client.callTool({ name: 'reticle_session', arguments: { action: 'list' } }));
            if (sessions.sessions?.length === 1) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert.equal(sessions.sessions?.length, 1, 'only the selected fixture connects');
        const found = decode(await client.callTool({ name: 'reticle_look',
            arguments: { action: 'find', by: 'testid', value: 'counter' } }));
        const ref = found.elements?.[0]?.ref;
        assert.ok(ref, 'real browser element reference');
        assert.equal(await page.locator('[data-testid="counter"]').innerText(), 'count: 0');
        decode(await client.callTool({ name: 'reticle_act', arguments: { ref, action: 'click' } }));
        await page.waitForFunction(() => document.querySelector('[data-testid="counter"]')?.textContent === 'count: 1');
        const after = decode(await client.callTool({ name: 'reticle_look',
            arguments: { action: 'find', by: 'testid', value: 'counter' } }));
        assert.ok(JSON.stringify(after.elements?.[0]).includes('count: 1'));
        await page.screenshot({ path: screenshot });
    } finally { await page.close(); await client.close(); }
}

// Hash acknowledged bytes, without returning private file contents. A journal
// may append shutdown records; it may not lose or change the recorded prefix.
const snapshotScript = `
const fs=require('fs'),crypto=require('crypto'),path=require('path');
const previous=JSON.parse(process.argv[1]||'null');
let files=previous?.map(x=>x.path);
if(!files){
 files=['/data/reticle/pairing-token'];
 if(fs.existsSync('/workspace/projects/.reticle/project.json')) files.push('/workspace/projects/.reticle/project.json');
 const root='/workspace/projects/.reticle/sessions';
 for(const dir of fs.readdirSync(root)) for(const name of ['actions.jsonl','events.jsonl']){
  const p=path.join(root,dir,name); if(fs.existsSync(p)&&fs.statSync(p).size) files.push(p);
 }
}
process.stdout.write(JSON.stringify(files.map((p,i)=>{
 const bytes=fs.readFileSync(p),size=previous?.[i].bytes??bytes.length;
 if(bytes.length<size) throw Error('lost_bytes');
 return {path:p,bytes:size,sha256:crypto.createHash('sha256').update(bytes.subarray(0,size)).digest('hex')};
})));`;

try {
    await mkdir(output, { recursive: true, mode: 0o700 });
    const runtimeImage = inspect(image);
    assert.equal(runtimeImage.Architecture, 'amd64');
    assert.equal(runtimeImage.Config.Labels['org.opencontainers.image.revision'],
        '39cc34a84bfb78023154c9f4e99c61f3cbe8fc19');
    const immutableImage = runtimeImage.Id;
    docker(['volume', 'inspect', workVolume]);
    const runtimeArgs = [];
    const origins = [], fixtureOrigins = [];
    stage = 'create-computers';
    for (const suffix of ['a', 'b']) {
        const network = `${id}-${suffix}`, volume = network, daemon = `${network}-daemon`;
        networks.push(network); volumes.push(volume);
        docker(['network', 'create', '--internal', ...label, network]);
        docker(['volume', 'create', ...label, volume]);
        // Only this new, empty task-owned volume is initialized as root.
        docker(['run', '--rm', '--user', '0:0', '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
            '--security-opt', 'no-new-privileges', '--mount', `type=volume,source=${volume},target=/computer`,
            '--entrypoint', 'node', immutableImage, '-e',
            'const f=require("fs");for(const p of ["/computer/Projects/fixture","/computer/apps/reticle"]){f.mkdirSync(p,{recursive:true,mode:0o700});f.chownSync(p,1000,1000)}',
            '--'], 30_000);
        // Docker Desktop/OrbStack may not publish an internal-network port.
        // This trusted proxy has fixed destinations and no volume/secret access.
        const gateway = `${network}-gateway`;
        const proxy = `const net=require('net');for(const [p,h] of [[4400,'${daemon}'],[5301,'${id}-fixture']])
net.createServer(s=>{const u=net.connect(p,h);s.on('error',()=>u.destroy());u.on('error',()=>s.destroy());
s.on('close',()=>u.destroy());u.on('close',()=>s.destroy());s.pipe(u).pipe(s)}).listen(p,'0.0.0.0');`;
        launch(gateway, [...restricted, '--network', 'bridge', '-p', '127.0.0.1::4400',
            '-p', '127.0.0.1::5301', '--entrypoint', 'node', immutableImage, '-e', proxy]);
        docker(['network', 'connect', network, gateway]);
        const origin = `http://127.0.0.1:${port(gateway, 4400)}`;
        const fixtureOrigin = `http://127.0.0.1:${port(gateway, 5301)}`;
        origins.push(origin); fixtureOrigins.push(fixtureOrigin);
        const args = [...restricted, '--network', network,
            ...mount(volume, '/workspace/projects', 'Projects/fixture'), ...mount(volume, '/data/reticle', 'apps/reticle'),
            '--env', 'EZIL_RETICLE_PROJECT_PATH=/workspace/projects',
            '--env', 'EZIL_RETICLE_PRIVATE_PATH=/data/reticle',
            '--env', `EZIL_RETICLE_ALLOWED_ORIGINS=${JSON.stringify([fixtureOrigin])}`, immutableImage];
        runtimeArgs.push(args);
        launch(daemon, args);
    }
    const a = `${id}-a-daemon`, b = `${id}-b-daemon`;
    stage = 'authentication-and-isolation';
    // Readiness needs a token; wait for bounded, fail-closed provisioning first.
    let tokenA, tokenB;
    for (let n = 0; n < 60; n++) {
        for (const name of [a, b]) {
            if (!inspect(name).State.Running) {
                // Docker sends the container's stderr to its own stderr; read
                // it into memory and expose only an allowlisted startup code.
                let logs = '';
                try {
                    const processResult = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 5000 });
                    logs = (processResult.stdout ?? '') + (processResult.stderr ?? '');
                } catch { /* report only exited */ }
                const code = logs.match(/^(?:invalid_reticle_origins|invalid_reticle_paths|reticle_mount_required|pairing_token_unavailable|invalid_project_mount|reticle_project_unavailable|unsupported_reticle_version|reticle_adapter_start_failed)$/m)?.[0];
                throw new Error(`daemon_${code ?? 'exited'}`);
            }
        }
        try { tokenA = readToken(a); tokenB = readToken(b); break; } catch { /* starting */ }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(tokenA && tokenB && tokenA !== tokenB, 'distinct installation credentials');
    await ready(origins[0], tokenA); await ready(origins[1], tokenB);
    assert.equal(await status(origins[0]), 401);
    assert.equal(await status(origins[1], tokenA), 401);
    assert.equal(await status(origins[0], tokenB), 401);
    for (const name of [a, b]) {
        const config = inspect(name);
        assert.equal(config.HostConfig.ReadonlyRootfs, true);
        assert.equal(config.HostConfig.Privileged, false);
        assert.deepEqual(config.HostConfig.CapDrop, ['ALL']);
        assert.equal(config.Config.User, '1000:1000');
        assert.equal(config.Image, immutableImage);
        assert.ok(config.HostConfig.SecurityOpt.includes('no-new-privileges'));
        assert.deepEqual(Object.keys(config.NetworkSettings.Networks), [config.HostConfig.NetworkMode]);
    }
    const ipB = Object.values(inspect(b).NetworkSettings.Networks)[0].IPAddress;
    const isolation = JSON.parse(execute(a, `const net=require('net');Promise.all(process.argv.slice(1).map(host=>
new Promise(resolve=>{const s=net.connect(host==='${ipB}'?4400:80,host);let done=false;
const end=v=>{if(done)return;done=true;s.destroy();resolve(v)};s.setTimeout(800,()=>end(true));
s.on('error',()=>end(true));s.on('connect',()=>end(false))}))).then(r=>process.stdout.write(JSON.stringify(r)))`,
        '169.254.169.254', '1.1.1.1', ipB));
    assert.deepEqual(isolation, [true, true, true], 'metadata, internet and other computer denied');
    const configPath = join(temporary, 'fixture.mjs');
    stage = 'start-fixture';
    await writeFile(configPath, `import {createRequire} from 'node:module';import{readFileSync}from'node:fs';
const require=createRequire('/work/source/apps/examples/react/package.json');
const {default:react}=await import(require.resolve('@vitejs/plugin-react'));
const {reticle}=await import('/work/source/adapters/build/vite/dist/index.js');
export default {root:'/work/source/apps/examples/react',cacheDir:'/tmp/vite-cache',
plugins:[reticle({port:${new URL(origins[0]).port},token:readFileSync('/reticle-data/pairing-token','utf8').trim(),
projectId:'ezil-private-acceptance',captureErrorBodies:false}),react()],
server:{host:'0.0.0.0',port:5301,strictPort:true,fs:{allow:['/work/source']}}};`, { mode: 0o644 });
    launch(`${id}-fixture`, [...restricted, '--network', `${id}-a`, '--user', '1000:1000',
        '--mount', `type=volume,source=${workVolume},target=/work,readonly`,
        ...mount(`${id}-a`, '/reticle-data', 'apps/reticle', true),
        '--mount', `type=bind,source=${configPath},target=/fixture.mjs,readonly`, builder,
        'node', '/work/source/apps/examples/react/node_modules/vite/bin/vite.js',
        '--config', '/fixture.mjs', '--configLoader', 'native']);
    let fixtureReady = false;
    for (let n = 0; n < 60; n++) {
        try {
            const response = await fetch(fixtureOrigins[0], { signal: AbortSignal.timeout(1000), redirect: 'error' });
            await response.body?.cancel();
            if (response.status === 200) { fixtureReady = true; break; }
        } catch { /* bounded Vite startup */ }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(fixtureReady, 'real fixture ready');
    stage = 'first-operation';
    browser = await chromium.launch();
    await operate(origins[0], tokenA, fixtureOrigins[0], join(output, 'before-restart.png'));
    stage = 'capture-state';
    const baseline = JSON.parse(execute(a, snapshotScript));
    assert.ok(baseline.some(x => x.path.endsWith('/actions.jsonl') && x.bytes > 0));
    execute(a, `const f=require('fs');f.mkdirSync('/workspace/projects/.git',{recursive:true});
f.writeFileSync('/workspace/projects/.git/HEAD','ref: refs/heads/main\\n');f.writeFileSync('/workspace/projects/old-name','saved');
f.renameSync('/workspace/projects/old-name','/workspace/projects/new-name');f.writeFileSync('/workspace/projects/deleted','gone');f.unlinkSync('/workspace/projects/deleted');`);
    for (const replacement of [false, true]) {
        stage = replacement ? 'replacement' : 'restart';
        const oldId = inspect(a).Id;
        docker(['stop', '--time', '15', a]);
        assert.equal(inspect(a).State.Running, false, 'observed stop');
        if (replacement) { docker(['rm', a]); launch(a, runtimeArgs[0]); }
        else docker(['start', a]);
        await ready(origins[0], tokenA);
        assert.equal(readToken(a), tokenA, 'credential retained');
        assert.equal(inspect(a).Image, immutableImage, 'no rebuild on reopen');
        if (replacement) assert.notEqual(inspect(a).Id, oldId);
        assert.deepEqual(JSON.parse(execute(a, snapshotScript, JSON.stringify(baseline))), baseline);
        assert.equal(execute(a, `const f=require('fs');process.stdout.write(String(
f.readFileSync('/workspace/projects/new-name','utf8')==='saved'&&f.existsSync('/workspace/projects/.git/HEAD')
&&!f.existsSync('/workspace/projects/old-name')&&!f.existsSync('/workspace/projects/deleted')))`), 'true');
        await operate(origins[0], tokenA, fixtureOrigins[0], join(output, replacement ? 'after-replacement.png' : 'after-restart.png'));
    }
    assert.equal(execute(b, `const f=require('fs');process.stdout.write(String(
(!f.existsSync('/workspace/projects/.reticle/sessions')||f.readdirSync('/workspace/projects/.reticle/sessions').length===0)
&&!f.existsSync('/workspace/projects/new-name')&&!f.existsSync('/workspace/projects/.git')))`), 'true');
    const missing = `${id}-missing-mounts`;
    stage = 'missing-mounts';
    launch(missing, [...restricted, '--network', 'none', '--env', 'EZIL_RETICLE_ALLOWED_ORIGINS=["http://127.0.0.1"]', immutableImage]);
    assert.notEqual(docker(['wait', missing], 15_000), '0', 'missing mounts must fail startup');
    const report = { sourceCommit: runtimeImage.Config.Labels['org.opencontainers.image.revision'],
        imageId: immutableImage, realOperations: 3, crossInstallationDenied: true,
        metadataAndInternetDenied: true, observedStop: true, restartPreservedState: true,
        replacementPreservedState: true, gitRenameDeletionPreserved: true, missingMountRejected: true,
        productionAcceptance: false };
    await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(report));
} catch (error) {
    // Assertions can include expected/actual credentials. Emit only the code.
    const code = error instanceof assert.AssertionError ? 'reticle_acceptance_assertion_failed'
        : /^docker_|^missing_|^daemon_|^reticle_|^unexpected_/.test(error.message) ? error.message : 'reticle_acceptance_failed';
    const location = error.stack?.match(/run\.mjs:(\d+:\d+)/)?.[1];
    console.error(JSON.stringify({ code, stage, location }));
    process.exitCode = 1;
} finally {
    await browser?.close();
    let cleanupFailed = false;
    for (const name of [...new Set(containers)].reverse()) {
        try { docker(['rm', '-f', name]); } catch { cleanupFailed = true; }
    }
    for (const name of networks.reverse()) { try { docker(['network', 'rm', name]); } catch { cleanupFailed = true; } }
    for (const name of volumes.reverse()) { try { docker(['volume', 'rm', name]); } catch { cleanupFailed = true; } }
    await rm(temporary, { recursive: true, force: true });
    if (cleanupFailed) { console.error('reticle_acceptance_cleanup_failed'); process.exitCode = 1; }
}
