// One reviewed public-source recipe. Not a general repository deployment API.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArtifact } from './verify-artifact.mjs';

const exec = promisify(execFile);
const commit = '39cc34a84bfb78023154c9f4e99c61f3cbe8fc19';
const lockDigest = 'cb5edcfe70e8a72fe1f310729a743b191688325b2341b2955776a6d4d6e7907b';
const here = dirname(fileURLToPath(import.meta.url));
const supervisor = dirname(here);
const source = await realpath(process.argv[2] ?? '');
const destination = resolve(process.argv[3] ?? '');
const repo = await realpath(join(supervisor, '..'));
function outside(path) {
    const value = relative(repo, path);
    return value === '..' || value.startsWith('../') || isAbsolute(value);
}
if (!process.argv[2] || !process.argv[3] || !outside(source) || !outside(destination)) {
    throw new Error('usage: node supervisor/reticle/build.mjs <external-source-checkout> <new-external-output-directory>');
}
await mkdir(destination, { mode: 0o700 }); // never overwrite an earlier artifact
if (!outside(await realpath(destination))) throw new Error('output_must_be_outside_repository');
const job = `ezil-reticle-build-${randomUUID()}`;
const volume = `${job}-work`, builderTag = `${job}:builder`, runtimeTag = `${job}:runtime`;
const containers = [];
let retainVolume = false, volumeCreated = false, phase = 'source';
let deadline = Date.now() + 15 * 60_000;
let cleaning = false;
const cancellation = new AbortController();
const cancel = () => cancellation.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
async function command(binary, args, log) {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error('build_deadline');
    try {
        const result = await exec(binary, args, { timeout, maxBuffer: 4 * 1024 * 1024,
            ...(cleaning ? {} : { signal: cancellation.signal }) });
        if (log) await writeFile(join(destination, `${log}.log`), result.stdout + result.stderr, { mode: 0o600 });
        return result.stdout.trim();
    } catch { throw new Error(`build_${phase}_failed`); }
}
const docker = (args, log) => command('docker', args, log);
async function step(name, network, args) {
    phase = name;
    console.log(JSON.stringify({ phase }));
    const container = `${job}-${name}`;
    containers.push(container);
    return docker(['run', '--name', container, '--label', `org.ezil.build-job=${job}`,
        '--platform', 'linux/amd64', '--network', network, '--user', '1000:1000', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
        '--memory', '4g', '--cpus', '2', '--tmpfs', '/tmp:rw,nosuid,size=256m',
        '--env', 'XDG_CONFIG_HOME=/tmp/config', '--env', 'XDG_CACHE_HOME=/tmp/cache',
        '--mount', `type=volume,source=${volume},target=/work`,
        '--workdir', '/work/source', builderTag, ...args], name);
}

try {
    console.log(JSON.stringify({ job, phase }));
    const actual = await command('git', ['-C', source, 'rev-parse', `${commit}^{commit}`]);
    if (actual !== commit) throw new Error('source_pin_mismatch');
    const archive = join(destination, 'source.tar');
    await command('git', ['-C', source, 'archive', '--format=tar', '-o', archive, commit]);
    const context = join(destination, 'builder-context');
    await mkdir(context);
    await copyFile(join(here, 'Builder.Dockerfile'), join(context, 'Dockerfile'));
    phase = 'toolchain';
    await docker(['build', '--platform', 'linux/amd64', '--label', `org.ezil.build-job=${job}`,
        '-t', builderTag, context], 'toolchain');
    await rm(context, { recursive: true });
    await docker(['volume', 'create', '--label', `org.ezil.build-job=${job}`, volume]);
    volumeCreated = true;
    const loader = `${job}-source`;
    containers.push(loader);
    await docker(['create', '--name', loader, '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
        '--security-opt', 'no-new-privileges', '--mount', `type=volume,source=${volume},target=/work`,
        builderTag, 'sh', '-c', 'mkdir -p /work/source /work/.pnpm-store && tar -xf /source.tar -C /work/source && chown -R 1000:1000 /work']);
    await docker(['cp', archive, `${loader}:/source.tar`]);
    await docker(['start', '-a', loader]);
    if ((await docker(['inspect', '--format', '{{.State.ExitCode}}', loader])) !== '0') throw new Error('source_extract_failed');
    await rm(archive);
    const originalLock = await step('source-check', 'none', ['node', '-e',
        'const f=require("fs"),c=require("crypto");if(JSON.parse(f.readFileSync("package.json")).packageManager!=="pnpm@10.33.2")process.exit(1);process.stdout.write(c.createHash("sha256").update(f.readFileSync("pnpm-lock.yaml")).digest("hex"))']);
    if (originalLock !== lockDigest) throw new Error('source_lock_mismatch');
    // Public pilot only. Network exists only during package retrieval, with
    // hooks/lifecycle scripts disabled and no mounted host credentials. Private
    // intake still requires a separately validated registry egress proxy.
    await step('dependencies', 'bridge', ['pnpm', '--filter', '@reticlehq/server...', '--filter', '@reticlehq/example-react...',
        'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--store-dir', '/work/.pnpm-store']);
    await step('compile', 'none', ['pnpm', '--filter', '@reticlehq/server...', '--filter', '@reticlehq/example-react...',
        '--workspace-concurrency=1', 'run', 'build']);
    await step('package', 'none', ['pnpm', '--filter', '@reticlehq/server', '--config.inject-workspace-packages=true',
        'deploy', '--prod', '--offline', '--ignore-scripts', '--store-dir', '/work/.pnpm-store', '/work/artifact']);
    const verifiedLock = await step('import-check', 'none', ['node', '--input-type=module', '-e',
        'import f from "node:fs";import c from "node:crypto";await import("/work/artifact/dist/index.js");process.stdout.write(c.createHash("sha256").update(f.readFileSync("pnpm-lock.yaml")).digest("hex"))']);
    if (verifiedLock !== lockDigest) throw new Error('build_changed_source_lock');
    phase = 'artifact';
    await docker(['cp', `${job}-package:/work/artifact`, join(destination, 'artifact')]);
    const artifact = await verifyArtifact(join(destination, 'artifact'));
    phase = 'runtime';
    await command('npm', ['--prefix', supervisor, 'run', 'build'], 'adapter');
    await docker(['build', '--platform', 'linux/amd64', '--label', `org.ezil.build-job=${job}`,
        '--build-context', `reticle-artifact=${join(destination, 'artifact')}`,
        '-f', join(here, 'Dockerfile'), '-t', runtimeTag, supervisor], 'runtime');
    const runtimeId = await docker(['image', 'inspect', '--format', '{{.Id}}', runtimeTag]);
    const builderId = await docker(['image', 'inspect', '--format', '{{.Id}}', builderTag]);
    const result = { source: 'https://github.com/reticlehq/reticle', commit, sourceLockSha256: lockDigest,
        recipeVersion: 1, pnpm: '10.33.2', ...artifact, builderImage: builderId, runtimeImage: runtimeId,
        workVolume: volume, sourceArchiveRetained: false, signedProvenance: false, published: false,
        recipeSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex') };
    await writeFile(join(destination, 'build.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    retainVolume = true; // holds the fixture workspace for the acceptance run
    console.log(JSON.stringify(result));
} catch (error) {
    console.error(JSON.stringify({ code: cancellation.signal.aborted ? 'build_cancelled'
        : /^build_|^source_/.test(error.message) ? error.message : 'build_failed', phase }));
    process.exitCode = cancellation.signal.aborted ? 130 : 1;
} finally {
    // A killed Docker CLI does not prove the container stopped. Remove and
    // observe only this job's containers, even if the build deadline expired.
    deadline = Date.now() + 60_000;
    cleaning = true;
    for (const container of containers.reverse()) {
        try { await docker(['rm', '-f', container]); }
        catch { console.error('build_container_cleanup_failed'); process.exitCode = 1; }
    }
    if (volumeCreated && !retainVolume) {
        try { await docker(['volume', 'rm', volume]); }
        catch { console.error('build_volume_cleanup_failed'); process.exitCode = 1; }
    }
}
