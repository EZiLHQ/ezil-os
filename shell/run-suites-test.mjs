import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run-suites.mjs', import.meta.url));

async function fixtures(t, scripts) {
    // Spaces exercise argument handling on Windows as well as Unix.
    const directory = await mkdtemp(join(tmpdir(), 'shell suites '));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const files = [];
    for (const [name, source] of Object.entries(scripts)) {
        const file = join(directory, name);
        await writeFile(file, source);
        files.push(file);
    }
    return { directory, files };
}

async function run(args) {
    const directory = await mkdtemp(join(tmpdir(), 'shell runner output '));
    const stdout = await open(join(directory, 'stdout'), 'wx+');
    const stderr = await open(join(directory, 'stderr'), 'wx+');
    try {
        const result = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [runner, ...args], {
                shell: false,
                stdio: ['ignore', stdout.fd, stderr.fd],
            });
            child.on('error', reject);
            const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                resolve({ code, signal });
            });
        });
        return { ...result,
            stdout: await readFile(join(directory, 'stdout'), 'utf8'),
            stderr: await readFile(join(directory, 'stderr'), 'utf8') };
    } finally {
        await stdout.close();
        await stderr.close();
        await rm(directory, { recursive: true, force: true });
    }
}

test('all pass: complete stdout/stderr blocks follow input order, not completion order', async t => {
    const { files } = await fixtures(t, {
        'first.mjs': `
            import { existsSync } from 'node:fs';
            import { setTimeout as delay } from 'node:timers/promises';
            console.log('first stdout');
            // The queued third suite must run even while the first block cannot print.
            while (!existsSync(new URL('./third-finished', import.meta.url))) await delay(10);
            process.stderr.write('first stderr without newline');
        `,
        'second.mjs': `
            console.log('second stdout');
            console.error('second stderr');
        `,
        'third.mjs': `
            import { writeFileSync } from 'node:fs';
            console.log('third stdout');
            writeFileSync(new URL('./third-finished', import.meta.url), 'done');
        `,
    });
    const result = await run(['--jobs', '2', '--timeout-ms', '10000', ...files]);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const headers = [...result.stdout.matchAll(/^── (.+) \(\d+\.\d{2}s\)$/gm)].map(match => match[1]);
    assert.deepEqual(headers, files);
    const secondHeader = result.stdout.indexOf(`── ${files[1]}`);
    for (const message of ['first stdout', 'first stderr without newline']) {
        assert.ok(result.stdout.indexOf(message) > result.stdout.indexOf(`── ${files[0]}`));
        assert.ok(result.stdout.indexOf(message) < secondHeader);
    }
    for (const message of ['second stdout', 'second stderr']) assert.ok(result.stdout.indexOf(message) > secondHeader);
    assert.ok(result.stdout.indexOf('third stdout') > result.stdout.indexOf(`── ${files[2]}`));
});

test('failure is named with its exit code and queued suites still run', async t => {
    const { files } = await fixtures(t, {
        'bad.mjs': "console.error('failure detail'); process.exitCode = 7;",
        'later.mjs': "console.log('later suite ran');",
        'also-bad.mjs': 'process.exitCode = 9;',
    });
    const result = await run(['--jobs', '1', ...files]);
    assert.equal(result.code, 1);
    assert.ok(result.stdout.includes('failure detail'));
    assert.ok(result.stdout.includes('later suite ran'));
    assert.ok(result.stderr.includes(`${files[0]}: exit code 7`));
    assert.ok(result.stderr.includes(`${files[2]}: exit code 9`));
    assert.match(result.stderr, /Failed suites \(2\/3\)/);
});

test('timeout kills the suite, reports failure and releases its slot', async t => {
    const { directory, files } = await fixtures(t, {
        'hang.mjs': `
            import { writeFileSync } from 'node:fs';
            process.on('SIGTERM', () => {});
            writeFileSync(new URL('./started', import.meta.url), String(process.pid));
            setInterval(() => {}, 1000);
        `,
        'after.mjs': "console.log('ran after timeout');",
    });
    const result = await run(['--jobs', '1', '--timeout-ms', '1000', ...files]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes(`${files[0]}: timed out after 1000 ms`));
    assert.match(result.stderr, /signal SIGKILL|exit code [1-9]\d*/);
    assert.ok(result.stdout.includes('ran after timeout'));
    const pid = Number(await readFile(join(directory, 'started'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('actual overlap reaches N and never exceeds N, including queued work', async t => {
    const jobs = 2;
    const scripts = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`suite-${i}.mjs`, `
        import { existsSync, writeFileSync } from 'node:fs';
        import { setTimeout as delay } from 'node:timers/promises';
        const start = process.hrtime.bigint();
        writeFileSync(new URL('./ready-${i}', import.meta.url), 'ready');
        // Each pair must overlap. This makes a serial implementation fail reliably.
        while (!existsSync(new URL('./ready-${i ^ 1}', import.meta.url))) await delay(10);
        await delay(40);
        writeFileSync(new URL('./interval-${i}.json', import.meta.url),
            JSON.stringify({ start: String(start), end: String(process.hrtime.bigint()) }));
    `]));
    const { directory, files } = await fixtures(t, scripts);
    const result = await run(['--jobs', String(jobs), '--timeout-ms', '10000', ...files]);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const events = [];
    for (let i = 0; i < files.length; i++) {
        const interval = JSON.parse(await readFile(join(directory, `interval-${i}.json`), 'utf8'));
        events.push({ time: BigInt(interval.start), delta: 1 }, { time: BigInt(interval.end), delta: -1 });
    }
    events.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : a.delta - b.delta);
    let active = 0;
    let peak = 0;
    for (const event of events) {
        active += event.delta;
        peak = Math.max(peak, active);
        assert.ok(active <= jobs, `${active} suites overlapped with --jobs ${jobs}`);
    }
    assert.equal(peak, jobs, 'the runner must actually run suites concurrently');
    assert.equal(active, 0);
});

test('invalid options and an empty list fail clearly; default options run a suite', async t => {
    const { files } = await fixtures(t, { 'pass.mjs': "console.log('default options ran');" });
    for (const args of [[], ['--jobs'], ['--jobs', '0'], ['--jobs', '1.5'],
        ['--timeout-ms', '0'], ['--timeout-ms', '2147483648'], ['--unknown']]) {
        const result = await run(args);
        assert.equal(result.code, 2, JSON.stringify(args));
        assert.match(result.stderr, /Usage: node shell\/run-suites.mjs/);
    }
    const result = await run(files);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /default options ran/);
});

test('a missing suite fails without hiding another suite', async t => {
    const { directory, files } = await fixtures(t, { 'pass.mjs': "console.log('survivor ran');" });
    const missing = join(directory, 'missing.mjs');
    const result = await run(['--jobs', '2', missing, ...files]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes(`${missing}: exit code 1`));
    assert.match(result.stdout, /survivor ran/);
});
