// Each file runs in its own Node process. Only schedule independent suites together.
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const usage = 'Usage: node shell/run-suites.mjs [--jobs N] [--timeout-ms MS] file...';

function parseArgs(args) {
    let jobs = Math.min(4, availableParallelism());
    let timeoutMs = 10 * 60 * 1000;
    const files = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            files.push(...args.slice(i + 1));
            break;
        }
        if (arg === '--jobs' || arg === '--timeout-ms') {
            const raw = args[++i];
            const value = Number(raw);
            if (!/^\d+$/.test(raw ?? '') || !Number.isSafeInteger(value) || value < 1
                || (arg === '--timeout-ms' && value > 2 ** 31 - 1)) {
                throw new Error(`Invalid ${arg}: expected a positive integer${arg === '--timeout-ms' ? ' <= 2147483647' : ''}`);
            }
            if (arg === '--jobs') jobs = value;
            else timeoutMs = value;
        } else if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            files.push(arg);
        }
    }
    if (files.length === 0) throw new Error('At least one suite file is required');
    return { jobs, timeoutMs, files };
}

function runSuite(file, timeoutMs, logFile) {
    return new Promise(resolveResult => {
        const started = performance.now();
        let timedOut = false;
        let error;
        // A private file buffers both streams in write order without accumulating
        // every running suite's output in memory or relying on stdio pipe support.
        const fd = openSync(logFile, 'wx');
        let child;
        try {
            // Resolving prevents a filename beginning with '-' becoming a Node option.
            child = spawn(process.execPath, [resolve(file)], {
                shell: false,
                stdio: ['ignore', fd, fd],
            });
        } finally {
            closeSync(fd);
        }
        child.on('error', cause => { error = cause; });
        const timer = setTimeout(() => {
            timedOut = true;
            // SIGKILL cannot be ignored; Node also supports it on Windows.
            child.kill('SIGKILL');
        }, timeoutMs);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolveResult({ file, code, signal, timedOut, error, logFile,
                seconds: (performance.now() - started) / 1000 });
        });
    });
}

function failureReason(result, timeoutMs) {
    const reasons = [];
    if (result.timedOut) reasons.push(`timed out after ${timeoutMs} ms`);
    if (result.error) reasons.push(result.error.message);
    if (result.signal) reasons.push(`signal ${result.signal}`);
    else if (result.code !== 0) reasons.push(`exit code ${result.code}`);
    return reasons.join('; ');
}

async function runSuites({ files, jobs, timeoutMs }) {
    const directory = mkdtempSync(join(tmpdir(), 'ezil-shell-suites-'));
    const results = new Array(files.length);
    let nextToStart = 0;
    let nextToPrint = 0;
    async function worker() {
        while (nextToStart < files.length) {
            const index = nextToStart++;
            results[index] = await runSuite(files[index], timeoutMs, join(directory, `${index}.log`));
            // A slow earlier suite delays printing, but never delays scheduling.
            while (results[nextToPrint]) {
                const result = results[nextToPrint++];
                const output = readFileSync(result.logFile);
                process.stdout.write(Buffer.concat([
                    Buffer.from(`── ${result.file} (${result.seconds.toFixed(2)}s)\n`),
                    output,
                    Buffer.from(output.length && output.at(-1) !== 10 ? '\n' : ''),
                ]));
                rmSync(result.logFile);
            }
        }
    }
    try {
        await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, () => worker()));
        const failed = results.filter(result => failureReason(result, timeoutMs));
        if (failed.length) {
            process.stderr.write(`\nFailed suites (${failed.length}/${files.length}):\n`
                + failed.map(result => `  ${result.file}: ${failureReason(result, timeoutMs)}\n`).join(''));
            process.exitCode = 1;
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

let options;
try {
    options = parseArgs(process.argv.slice(2));
} catch (error) {
    process.stderr.write(`${error.message}\n${usage}\n`);
    process.exitCode = 2;
}
if (options) await runSuites(options);
