import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const inside = (root, path) => {
    const rel = relative(root, path);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Independent check of an untrusted, stopped builder's output. Never imports
 * the artifact or follows links outside its root. This is not provenance
 * signing or permission to publish a release. */
export async function verifyArtifact(directory) {
    const root = await realpath(directory);
    const digest = createHash('sha256');
    let bytes = 0, files = 0, links = 0;
    async function visit(path) {
        const info = await lstat(path);
        const name = relative(root, path).split(sep).join('/');
        if (++files > 60_000 || name.length > 1024 || /[\x00-\x1f\x7f]/.test(name)
            || (info.mode & 0o7000)) throw new Error('artifact_limit_or_mode');
        if (info.isSymbolicLink()) {
            const target = await readlink(path);
            if (isAbsolute(target) || !inside(root, await realpath(path))) throw new Error('artifact_escaping_link');
            digest.update(JSON.stringify(['link', name, target]) + '\n');
            links++;
        } else if (info.isDirectory()) {
            digest.update(JSON.stringify(['directory', name, info.mode & 0o777]) + '\n');
            for (const child of (await readdir(path)).sort()) await visit(join(path, child));
        } else if (info.isFile()) {
            bytes += info.size;
            if (bytes > 512 * 1024 * 1024 || info.size > 32 * 1024 * 1024 || name.endsWith('.node')) {
                throw new Error('artifact_unsupported_size_or_native_module');
            }
            const hash = createHash('sha256').update(await readFile(path)).digest('hex');
            digest.update(JSON.stringify(['file', name, info.mode & 0o777, info.size, hash]) + '\n');
        } else throw new Error('artifact_special_file');
    }
    await visit(root);
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (pkg.name !== '@reticlehq/server' || pkg.version !== '3.2.0'
        || !(await lstat(join(root, 'dist/index.js'))).isFile()) throw new Error('artifact_wrong_entrypoint');
    for (const notice of ['LICENSE', 'LICENSE-ENTERPRISE']) {
        if (!(await lstat(join(root, notice))).isFile()) throw new Error('artifact_missing_license');
    }
    return { treeDigest: `sha256:${digest.digest('hex')}`, files, bytes, links };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    verifyArtifact(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(() => {
        console.error('artifact_verification_failed'); process.exitCode = 1;
    });
}
