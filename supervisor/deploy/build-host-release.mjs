// Maintainer build packaging, never untrusted repository build execution.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, inventory, parseRelease, units } from './host-release.mjs';

try {
    if (process.argv.length !== 3 || process.versions.node.split('.')[0] !== '24') throw new Error();
    const source = dirname(dirname(fileURLToPath(import.meta.url))), output = resolve(process.argv[2]);
    const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (git(['status', '--porcelain', '--', '.'])) throw new Error('source_not_clean');
    const commit = git(['rev-parse', 'HEAD']);
    await mkdir(output, { mode: 0o700 }); // Never overwrite a prior release.
    const payload = join(output, 'payload'); await mkdir(payload);
    for (const name of ['package.json', 'package-lock.json']) await copyFile(join(source, name), join(payload, name));
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, npm_config_userconfig: '/dev/null', npm_config_audit: 'false', npm_config_fund: 'false' };
    execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--registry=https://registry.npmjs.org'], {
        cwd: payload, env, timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1048576,
    });
    // Rebuild from this clean tree rather than packaging an old dist directory.
    execFileSync(process.execPath, [join(source, 'node_modules/typescript/bin/tsc'), '--project', join(source, 'tsconfig.build.json'),
        '--outDir', join(payload, 'dist')], { cwd: source, env, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    await mkdir(join(payload, 'deploy'));
    for (const name of [...units, 'configuration-document.json', 'mount-document.json']) await copyFile(join(source, 'deploy', name), join(payload, 'deploy', name));
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceCommit: commit, nodeMajor: 24, files: await inventory(payload) }) + '\n');
    const digest = hash(bytes); parseRelease(bytes, digest);
    // Lockfile bytes are part of the release; npm must not have rewritten them.
    if (!(await readFile(join(source, 'package-lock.json'))).equals(await readFile(join(payload, 'package-lock.json')))) throw new Error();
    await writeFile(join(output, 'release.json'), bytes, { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ sourceCommit: commit, releaseDigest: digest }) + '\n');
} catch { process.stderr.write('{"code":"host_release_build_failed"}\n'); process.exitCode = 1; }
