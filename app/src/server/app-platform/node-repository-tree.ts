import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { PublicRepositoryUrlSchema, type RepositoryInspectionV1 } from './repository-submission';

type Analysis = Pick<RepositoryInspectionV1,
    'workspaces' | 'launchTargets' | 'stateRequirements' | 'license' | 'compatibility'>;
type Workspace = RepositoryInspectionV1['workspaces'][number];
type Reason = RepositoryInspectionV1['compatibility']['reasons'][number];
type Package = { name?: unknown; license?: unknown; packageManager?: unknown;
    workspaces?: unknown; dependencies?: unknown; devDependencies?: unknown;
    optionalDependencies?: unknown };

const MAX_FILE_BYTES = 256 * 1024;
const MAX_WORKSPACE_PATTERNS = 64;
const MAX_PATTERN_ENTRIES = 512;
const MAX_WORKSPACES = 64;

/** This reads only a checkout already pinned, fetched, bounded and extracted by
 * a trusted intake worker. It does not fetch a URL, verify a commit/archive,
 * run package scripts, or grant release authority. The caller must provide
 * those provenance and authorization checks before using its findings. */
export async function inspectNodeRepositoryTree(checkoutPath: string, repositoryUrlInput: string): Promise<Analysis> {
    const parsedUrl = PublicRepositoryUrlSchema.safeParse(repositoryUrlInput);
    if (!parsedUrl.success) throw new Error('invalid_repository_url');
    const repositoryUrl = parsedUrl.data;
    const reasons = new Set<Reason>();
    if (new URL(repositoryUrl).hostname !== 'github.com') {
        return {
            workspaces: [], launchTargets: [], stateRequirements: [],
            compatibility: { status: 'unsupported', reasons: ['unsupported-host'] },
        };
    }

    const root = await realpath(checkoutPath);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) throw new Error('checkout_not_directory');
    const rootPackageText = await safeText(root, 'package.json');
    const rootPackage = parsePackage(rootPackageText);
    const pnpmWorkspaceText = await safeText(root, 'pnpm-workspace.yaml', 64 * 1024);
    if (pnpmWorkspaceText === null && await safeRegularFile(root, 'pnpm-workspace.yaml')) {
        reasons.add('build-or-runtime-unknown');
    }
    const packageManager = packageManagerFor(
        rootPackage, pnpmWorkspaceText, await safeRegularFile(root, 'package-lock.json'),
    );
    if (!rootPackage) reasons.add('build-or-runtime-unknown');
    if (packageManager === 'unknown' || packageManager === 'yarn' || packageManager === 'bun') {
        reasons.add('build-or-runtime-unknown');
    }
    // Lockfiles can be large; existence is enough at inspection time. The
    // builder later checks the approved digest and package-manager version.
    if (!(await safeRegularFile(root, packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json'))) {
        reasons.add('missing-lockfile');
    }

    const patterns = pnpmWorkspaceText !== null
        ? parsePnpmWorkspacePatterns(pnpmWorkspaceText)
        : parseNpmWorkspacePatterns(rootPackage?.workspaces);
    if (patterns === null) reasons.add('build-or-runtime-unknown');
    const paths = new Set<string>();
    if (rootPackage) paths.add('.');
    for (const pattern of patterns ?? []) {
        for (const path of await expandWorkspacePattern(root, pattern)) paths.add(path);
        if (paths.size > MAX_WORKSPACES) throw new Error('too_many_workspaces');
    }

    const packages: { path: string; value: Package; text: string; name: string }[] = [];
    for (const path of [...paths].sort()) {
        const packagePath = path === '.' ? 'package.json' : `${path}/package.json`;
        const text = path === '.' ? rootPackageText : await safeText(root, packagePath);
        // Workspace globs may include grouping directories with no package.
        // pnpm ignores them, so they are not a compatibility failure.
        if (!text) {
            if (await safeRegularFile(root, packagePath)) reasons.add('build-or-runtime-unknown');
            continue;
        }
        const value = parsePackage(text);
        if (!value || typeof value.name !== 'string'
            || !/^[a-z0-9@/._-]{1,120}$/i.test(value.name)) {
            reasons.add('build-or-runtime-unknown');
            continue;
        }
        packages.push({ path, value, text, name: value.name });
    }
    const names = new Set(packages.map((item) => item.name));
    if (names.size !== packages.length) reasons.add('build-or-runtime-unknown');
    const workspaces: Workspace[] = packages.map((item) => {
        const dependencies = Object.entries({
            ...record(item.value.dependencies),
            ...record(item.value.devDependencies),
            ...record(item.value.optionalDependencies),
        }).filter(([, version]) => typeof version === 'string' && version.startsWith('workspace:'))
            .map(([name]) => name);
        if (dependencies.some((name) => !names.has(name))) reasons.add('build-or-runtime-unknown');
        const workspaceDependencies = [...new Set(dependencies.filter((name) => names.has(name) && name !== item.name))].sort();
        return {
            path: item.path,
            name: item.name,
            packageManager,
            workspaceDependencies,
            evidence: [{ kind: 'file', path: item.path === '.' ? 'package.json' : `${item.path}/package.json`,
                line: lineOf(item.text, /"name"\s*:/) }],
        };
    });

    const launchTargets: Analysis['launchTargets'] = [];
    const stateRequirements: Analysis['stateRequirements'] = [];
    let license: Analysis['license'];
    const reticleServer = packages.find((item) => item.path === 'server' && item.name === '@reticlehq/server');
    if (repositoryUrl === 'https://github.com/reticlehq/reticle' && reticleServer) {
        const cli = await safeText(root, 'server/src/command/cli/cli-parse.ts');
        const bin = await safeText(root, 'server/bin/reticle.js');
        const readme = await safeText(root, 'README.md');
        if (cli?.includes('reticle serve') && bin && readme?.includes('~/.reticle')) {
            launchTargets.push({
                name: 'reticle-daemon', workspacePath: 'server', kind: 'service',
                integrationAdapter: 'reticle-v1', entrypointPath: 'server/bin/reticle.js',
                internalPort: 4400, dependsOn: [],
                evidence: [{ kind: 'file', path: 'server/src/command/cli/cli-parse.ts',
                    line: lineOf(cli, /reticle serve/) }],
            });
            stateRequirements.push({
                kind: 'filesystem', evidence: [{ kind: 'file', path: 'README.md', line: lineOf(readme, /~\/\.reticle/) }],
            });
            if (typeof reticleServer.value.license === 'string') {
                license = {
                    identifier: reticleServer.value.license,
                    evidence: [{ kind: 'file', path: 'server/package.json', line: lineOf(reticleServer.text, /"license"\s*:/) }],
                };
            }
            reasons.add('license-review-required');
            reasons.add('configuration-required');
        }
    }
    if (!license && rootPackage && typeof rootPackage.license === 'string'
        && /^[a-z0-9.+_-]{1,80}$/i.test(rootPackage.license) && rootPackageText) {
        license = {
            identifier: rootPackage.license,
            evidence: [{ kind: 'file', path: 'package.json', line: lineOf(rootPackageText, /"license"\s*:/) }],
        };
    }
    if (!launchTargets.length) {
        reasons.add('missing-web-ui');
        reasons.add('configuration-required');
    }
    return {
        workspaces, launchTargets, stateRequirements,
        ...(license ? { license } : {}),
        compatibility: {
            status: rootPackage && workspaces.length ? 'needs-configuration' : 'unsupported',
            reasons: [...reasons].sort(),
        },
    };
}

function parsePackage(text: string | null): Package | null {
    if (!text) return null;
    try {
        const value: unknown = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Package : null;
    } catch { return null; }
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function packageManagerFor(
    root: Package | null, pnpmWorkspace: string | null, npmLockPresent: boolean,
): Workspace['packageManager'] {
    if (pnpmWorkspace) return 'pnpm';
    if (typeof root?.packageManager === 'string') {
        const match = /^(npm|pnpm|yarn|bun)@/.exec(root.packageManager);
        if (match) return match[1] as Workspace['packageManager'];
    }
    if (npmLockPresent) return 'npm';
    return 'unknown';
}

function parseNpmWorkspacePatterns(value: unknown): string[] | null {
    const patterns = Array.isArray(value) ? value : record(value).packages;
    if (patterns === undefined) return [];
    if (!Array.isArray(patterns) || patterns.length > MAX_WORKSPACE_PATTERNS
        || !patterns.every((item) => typeof item === 'string' && validPattern(item))) return null;
    return patterns;
}

function parsePnpmWorkspacePatterns(text: string): string[] | null {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/.test(line));
    if (start < 0) return null;
    const patterns: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line && !/^\s/.test(line) && !/^#/.test(line)) break;
        const match = /^\s+-\s+(?:'([^']+)'|"([^"]+)"|([^\s#]+))(?:\s+#.*)?\s*$/.exec(line);
        if (match) patterns.push(match[1] ?? match[2] ?? match[3]!);
        else if (/^\s+-/.test(line)) return null;
    }
    if (patterns.length > MAX_WORKSPACE_PATTERNS || patterns.some((pattern) => !validPattern(pattern))) return null;
    return patterns;
}

function validPattern(pattern: string): boolean {
    return pattern.split('/').every((part) => part === '*' || /^[a-z0-9][a-z0-9._-]*$/i.test(part));
}

async function expandWorkspacePattern(root: string, pattern: string): Promise<string[]> {
    let paths = [''];
    for (const segment of pattern.split('/')) {
        const next: string[] = [];
        for (const path of paths) {
            if (segment === '*') {
                const absolute = join(root, path);
                const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
                if (entries.length > MAX_PATTERN_ENTRIES) throw new Error('too_many_workspace_entries');
                next.push(...entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
                    .map((entry) => join(path, entry.name)));
            } else {
                const child = join(path, segment);
                const stats = await lstat(join(root, child)).catch(() => null);
                if (stats?.isDirectory() && !stats.isSymbolicLink()) next.push(child);
            }
        }
        paths = next;
        if (paths.length > MAX_WORKSPACES) throw new Error('too_many_workspaces');
    }
    return paths.map((path) => path.split(sep).join('/'));
}

async function safeRegularFile(root: string, path: string): Promise<boolean> {
    if (!validPattern(path) || path.includes('*')) return false;
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${root}${sep}`)) return false;
    let parent = root;
    for (const part of path.split('/').slice(0, -1)) {
        parent = join(parent, part);
        const stats = await lstat(parent).catch(() => null);
        if (!stats?.isDirectory() || stats.isSymbolicLink()) return false;
    }
    const stats = await lstat(absolute).catch(() => null);
    return stats?.isFile() === true && !stats.isSymbolicLink();
}

async function safeText(root: string, path: string, limit = MAX_FILE_BYTES): Promise<string | null> {
    if (!(await safeRegularFile(root, path))) return null;
    const absolute = resolve(root, path);
    const stats = await lstat(absolute);
    if (stats.size > limit) return null;
    return readFile(absolute, 'utf8');
}

function lineOf(text: string, pattern: RegExp): number {
    const index = text.split(/\r?\n/).findIndex((line) => pattern.test(line));
    return index < 0 ? 1 : index + 1;
}
