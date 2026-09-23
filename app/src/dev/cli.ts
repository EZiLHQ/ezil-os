import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import postgres from 'postgres';
import { verifyLocalWeb } from './verify-local-web';
import { checkDevelopmentEnvironment, ENV_HEADER, formatDiagnostics, isLocalDockerEndpoint, LOCAL_PROJECT } from './environment';
import {
    LocalWebError, isLocalAuthConfigured, loadMigrations, localAccounts, localDatabase, localEnvironment,
    migrateLocalDatabase, parseLocalStatus, privateDirectory, readPrivateFile,
    seedLocalAccounts, writePrivateFileOnce,
} from './local-supabase';

const appDirectory = fileURLToPath(new URL('../../', import.meta.url));
const workDirectory = path.join(appDirectory, 'dev');
const stateDirectory = path.join(appDirectory, '.local-web');
const envFile = path.join(appDirectory, '.env.local');
const network = `${LOCAL_PROJECT}-loopback`;
const cli = path.join(appDirectory, 'node_modules', 'supabase', 'bin', process.platform === 'win32' ? 'supabase.exe' : 'supabase');
const execute = promisify(execFile);
let stage = 'local_web';

// Do not pass application/cloud credentials or CLI remote-project settings to local tools.
const toolEnvironment: NodeJS.ProcessEnv = { NODE_ENV: 'development', ...Object.fromEntries([
    'PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR',
    'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])) };

async function run(command: string, args: string[], timeout = 30_000): Promise<string> {
    try {
        // start/status output contains credentials. Capture it; never inherit stdout/stderr.
        const pending = execute(command, args, {
            cwd: workDirectory, env: toolEnvironment, timeout, maxBuffer: 16 * 1024 * 1024,
        });
        const reported = new Set<string>();
        pending.child.stderr?.on('data', (chunk: Buffer) => {
            for (const phase of ['Pulling', 'Downloading', 'Starting database', 'Starting containers', 'Waiting for health checks']) {
                if (chunk.toString().includes(phase) && !reported.has(phase)) {
                    reported.add(phase);
                    console.log(`Local Supabase: ${phase.toLowerCase()}.`);
                }
            }
        });
        const result = await pending;
        return result.stdout.trim();
    } catch (error) {
        const failure = error as { code?: unknown; stderr?: string; killed?: boolean };
        const reason = failure.killed ? 'timeout' : failure.code === 'ENOENT' ? 'executable_missing'
            : /address already in use|port is already allocated/i.test(failure.stderr ?? '') ? 'port_in_use'
                : /failed to pull|pull access denied|manifest unknown/i.test(failure.stderr ?? '') ? 'image_pull_failed'
                    : /unhealthy|health check/i.test(failure.stderr ?? '') ? 'health_check_failed' : 'command_failed';
        throw new LocalWebError(`${stage}: ${reason}; check Docker, pinned CLI installation, and local port availability`);
    }
}

async function doctor(checkServices = true): Promise<void> {
    const managedFile = (await readPrivateFile(envFile))?.startsWith(ENV_HEADER) ?? false;
    loadEnvConfig(appDirectory, true, { info: () => {}, error: () => {
        throw new LocalWebError('env_files: could not load development environment');
    } });
    const issues = checkDevelopmentEnvironment(process.env, managedFile || process.env.EZIL_LOCAL_WEB === '1');
    if (issues.length) throw new LocalWebError(`${formatDiagnostics(issues)}\nRun bun run dev:setup for the isolated local setup; remove blank unused optional settings.`);
    if (checkServices && (managedFile || process.env.EZIL_LOCAL_WEB === '1')) {
        try {
            const health = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
                headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! },
                redirect: 'error', signal: AbortSignal.timeout(5_000),
            });
            if (!health.ok) throw new Error();
            const settings = await health.json();
            if (!isLocalAuthConfigured(settings)) {
                throw new LocalWebError('supabase_config: check auth.enable_signup and auth.email.enable_signup; local password login must be enabled and public signup disabled');
            }
        } catch (error) {
            if (error instanceof LocalWebError) throw error;
            throw new LocalWebError('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY: local Auth unavailable; run bun run dev:setup');
        }
        const sql = postgres(process.env.SUPABASE_DATABASE_URL!, { max: 1, connect_timeout: 5, onnotice: () => {} });
        try {
            const [row] = await sql`select to_regclass('public.ezil_computers') as computers, to_regclass('public.ezil_os_access') as access`;
            if (!row.computers || !row.access) throw new Error();
        } catch {
            throw new LocalWebError('SUPABASE_DATABASE_URL: local database or schema unavailable; run bun run dev:setup');
        } finally {
            await sql.end({ timeout: 5 });
        }
    }
    console.log('Development configuration: OK (values withheld).');
}

async function main(): Promise<void> {
    const command = process.argv[2];
    if (command === 'doctor') { await doctor(); return; }
    if (command === 'verify') { await doctor(); await verifyLocalWeb(appDirectory); return; }
    if (!['setup', 'stop'].includes(command)) throw new LocalWebError('command: use dev:setup, dev:doctor, dev:verify, or dev:stop');
    if (process.env.NODE_ENV === 'production') throw new LocalWebError('NODE_ENV: local setup is disabled in production');
    stage = 'supabase_version';
    // This CLI's --version also makes a blocking GitHub update request. The
    // lockfile pins its package; execute that package's binary, never PATH.
    const cliPackage = JSON.parse(await readPrivateFile(path.join(appDirectory, 'node_modules', 'supabase', 'package.json')) ?? '{}');
    if (cliPackage.version !== '2.65.2') throw new LocalWebError('supabase: install the pinned CLI with bun install --frozen-lockfile');
    const config = await readPrivateFile(path.join(workDirectory, 'supabase', 'config.toml'));
    if (!config?.includes(`project_id = "${LOCAL_PROJECT}"`)) throw new LocalWebError('supabase_config: unexpected project identity');
    stage = 'docker_context';
    const endpoint = process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT
        ? process.env.DOCKER_HOST
        : await run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
    if (!isLocalDockerEndpoint(endpoint)) throw new LocalWebError('DOCKER_HOST / DOCKER_CONTEXT: select a local Docker socket; remote daemons are not allowed');
    if (command === 'stop') {
        stage = 'supabase_stop';
        await run(cli, ['stop', '--workdir', workDirectory], 120_000);
        console.log('Dedicated local Supabase stopped; data volumes retained.');
        return;
    }
    const existing = await readPrivateFile(envFile);
    if (existing !== null && !existing.startsWith(ENV_HEADER)) {
        throw new LocalWebError('.env.local: already exists; preserve or move it before local setup');
    }
    stage = 'docker';
    await run('docker', ['info', '--format', '{{.ServerVersion}}']);
    const networks = await run('docker', ['network', 'ls', '--filter', `name=^${network}$`, '--format', '{{.Name}}']);
    if (!networks) {
        await run('docker', ['network', 'create', '--label', 'org.ezil.local-web=1',
            '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', network]);
    }
    const networkPolicy = await run('docker', ['network', 'inspect', '--format',
        '{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}|{{index .Labels "org.ezil.local-web"}}', network]);
    if (networkPolicy !== '127.0.0.1|1') throw new LocalWebError('docker_network: expected setup-owned loopback network');
    stage = 'supabase_start';
    console.log('Starting dedicated local Supabase. The first run downloads its container images.');
    await run(cli, ['start', '--workdir', workDirectory, '--network-id', network, '--exclude',
        'realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor'], 900_000);
    stage = 'supabase_status';
    const status = parseLocalStatus(JSON.parse(await run(cli, ['status', '--workdir', workDirectory, '--output', 'json'])));
    // Verify the database container belongs to this project before any mutation.
    const project = await run('docker', ['inspect', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}', `supabase_db_${LOCAL_PROJECT}`]);
    if (project !== LOCAL_PROJECT) throw new LocalWebError('supabase_container: project identity mismatch');
    for (const service of ['db', 'kong']) {
        const ports = JSON.parse(await run('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', `supabase_${service}_${LOCAL_PROJECT}`])) as Record<string, { HostIp: string }[] | null>;
        if (Object.values(ports).some((bindings) => bindings?.some((binding) => binding.HostIp !== '127.0.0.1'))) {
            throw new LocalWebError('docker_ports: existing local project is not loopback-only; run dev:stop then dev:setup');
        }
    }
    await privateDirectory(stateDirectory);
    await writePrivateFileOnce(envFile, localEnvironment(status));
    await doctor(false);
    const accounts = await localAccounts(path.join(stateDirectory, 'accounts.json'));
    const sql = localDatabase(status);
    try {
        stage = 'local_migrations';
        const applied = await migrateLocalDatabase(sql, await loadMigrations(path.join(appDirectory, 'drizzle')));
        console.log(`Local schema ready; ${applied} existing migrations applied.`);
        stage = 'local_accounts';
        await seedLocalAccounts(sql, status, accounts);
    } finally {
        await sql.end({ timeout: 5 });
    }
    await doctor();
    console.log('Two confirmed, invited local accounts ready. Credentials: app/.local-web/accounts.json (owner-only).');
    console.log('Run bun run dev, then open http://127.0.0.1:3000/login. Cloud desktop services are unconfigured.');
}

void main().catch((error: unknown) => {
    console.error(error instanceof LocalWebError ? error.message : `${stage}: failed (details withheld to protect credentials)`);
    process.exitCode = 1;
});
