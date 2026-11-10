// Opt-in local integration against the exact private packet; no live account or Git host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tarball = process.env.EZIL_TEST_PRIVATE_CLI_TARBALL;
const pin = JSON.parse(await readFile(new URL('./cli-pin.json', import.meta.url)));
const canonical = 'https://github.ezil.work/acme/site.git';
const token = `egg_${'a'.repeat(64)}`;
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const sha256 = value => createHash('sha256').update(value).digest('hex');

function runWithPrivateFd(command, packet, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { env, stdio: ['ignore', 'pipe', 'ignore', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stdio[3].on('error', () => {});
    child.stdio[3].end(JSON.stringify(packet));
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout }));
  });
}

test('pinned private CLI: authenticated clone then dirty checkout reuse under the Worker supervisor',
  { skip: !tarball, timeout: 45_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezil-os-cli-open-'));
    try {
      const archive = await readFile(tarball);
      assert.equal(sha256(archive), pin.tarballSha256);
      const bundle = join(root, 'ezil.js');
      const extracted = execFileSync('tar', ['-xOf', tarball, 'package/dist/ezil.js']);
      assert.equal(sha256(extracted), pin.sha256);
      await writeFile(bundle, extracted, { mode: 0o700 });
      assert.equal(execFileSync(process.execPath, [bundle, '--version'], { encoding: 'utf8' }).trim(), `ezil ${pin.version}`);

      const source = join(root, 'source'), bin = join(root, 'bin'), workspace = join(root, 'workspace');
      await mkdir(source); await mkdir(bin); await mkdir(workspace);
      execFileSync(realGit, ['init', '-q', '-b', 'main', source]);
      await writeFile(join(source, 'file.txt'), 'committed\n');
      execFileSync(realGit, ['-C', source, 'add', 'file.txt']);
      execFileSync(realGit, ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);

      const cloneCount = join(root, 'clone-count'), credentialMarker = join(root, 'credential-ok');
      const shim = `#!/usr/bin/env node
const cp=require('node:child_process'),fs=require('node:fs');
const args=process.argv.slice(2),git=${JSON.stringify(realGit)},url=${JSON.stringify(canonical)};
if(args.join(' ').includes(${JSON.stringify(token)}) || Object.values(process.env).includes(${JSON.stringify(token)})) process.exit(51);
const at=args.indexOf('clone');
if(at<0) process.exit(cp.spawnSync(git,args,{stdio:'inherit'}).status??1);
const fill=cp.spawnSync(git,[...args.slice(0,at),'credential','fill'],{input:'protocol=https\\nhost=github.ezil.work\\npath=acme/site.git\\n\\n',encoding:'utf8'});
if(fill.status!==0 || !fill.stdout.includes('password='+${JSON.stringify(token)})) process.exit(52);
fs.writeFileSync(${JSON.stringify(credentialMarker)},'ok');
fs.appendFileSync(${JSON.stringify(cloneCount)},'1');
const target=args.at(-1);
let result=cp.spawnSync(git,['clone','--no-hardlinks','--',${JSON.stringify(source)},target],{stdio:'ignore'});
if(result.status===0) result=cp.spawnSync(git,['-C',target,'remote','set-url','origin',url],{stdio:'ignore'});
process.exit(result.status??1);
`;
      await writeFile(join(bin, 'git'), shim, { mode: 0o700 });
      const repositoryId = '44444444-4444-4444-8444-444444444444';
      const packet = { version: 1,
        binding: { projectId: '33333333-3333-4333-8333-333333333333', repositoryId,
          canonicalURL: canonical, ref: 'refs/heads/main', bindingVersion: 'b'.repeat(64) },
        identity: { issuer: 'https://id.ezil.work/', subject: 'auth0|builder' },
        git: { username: 'ezil', token, expiresAt: new Date(Date.now() + 180_000).toISOString(), scope: 'write' } };
      const supervisor = new URL('./supervise.py', import.meta.url).pathname;
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root };
      const pinPath = join(root, 'pin.json'), installedPinPath = join(root, 'installed-pin.json');
      await writeFile(pinPath, JSON.stringify(pin)); await writeFile(installedPinPath, JSON.stringify(pin));
      const prepare = `import importlib.util,json,sys; s=importlib.util.spec_from_file_location('supervise',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.repo_command(*sys.argv[2:])))`;
      const prepared = await runWithPrivateFd(['python3', '-c', prepare, supervisor, workspace, repositoryId, canonical,
        '0', pinPath, bundle, installedPinPath], packet, env);
      assert.equal(prepared.code, 0, prepared.stdout);
      const cliCommand = JSON.parse(prepared.stdout);
      const destination = join(workspace, 'projects', repositoryId, 'repository');
      assert.deepEqual(cliCommand, [bundle, 'clone', canonical, '--directory', destination, '--json', '--grant-fd=3']);
      const operation = ['python3', supervisor, '30000', '3000', ...cliCommand];
      const first = await runWithPrivateFd(operation, packet, env);
      assert.equal(first.code, 0, first.stdout);
      assert.deepEqual(JSON.parse(first.stdout), { canonicalUrl: canonical, folder: destination,
        identity: packet.identity, status: 'cloned' });
      const terminalPwd = execFileSync('pwd', { cwd: destination, encoding: 'utf8' }).trim();
      const gitTop = execFileSync(realGit, ['rev-parse', '--show-toplevel'], { cwd: destination, encoding: 'utf8' }).trim();
      assert.equal(terminalPwd, destination, 'Code terminal starts in the checkout');
      assert.equal(gitTop, terminalPwd, 'plain git commands see the opened folder as the repository root');
      assert.equal(await readFile(credentialMarker, 'utf8'), 'ok');
      assert.equal(await readFile(join(destination, 'file.txt'), 'utf8'), 'committed\n');
      await writeFile(join(destination, 'file.txt'), 'dirty\n');
      const second = await runWithPrivateFd(operation, packet, env);
      assert.equal(second.code, 0, second.stdout);
      assert.equal(JSON.parse(second.stdout).status, 'reused');
      assert.equal(execFileSync(realGit, ['rev-parse', '--show-toplevel'], { cwd: destination, encoding: 'utf8' }).trim(), destination);
      assert.match(execFileSync(realGit, ['status', '--short'], { cwd: destination, encoding: 'utf8' }), /^ M file\.txt\n$/);
      assert.equal(await readFile(join(destination, 'file.txt'), 'utf8'), 'dirty\n');
      assert.equal(await readFile(cloneCount, 'utf8'), '1');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
