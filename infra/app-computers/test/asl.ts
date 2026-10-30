import assert from 'node:assert/strict';

/** A strict interpreter for the subset of ASL our graphs use. Unlike a lenient
 * walker it throws on a missing reference path, as Step Functions does with
 * States.Runtime (which States.ALL does not catch), so a field-list or
 * ResultPath mistake fails here instead of at the first real execution. */
export class StatesRuntime extends Error { constructor(message: string) { super(message); this.name = 'States.Runtime'; } }
export interface TaskError extends Error { name: string }
export interface AslRun { error?: string; cause?: string; output?: any; data: Record<string, any>; visited: string[] }

function walk(path: string, data: any, executionArn: string): any {
    if (path === '$$.Execution.Id') return executionArn;
    if (path === '$') return data;
    if (!path.startsWith('$.')) throw new StatesRuntime(`unsupported path ${path}`);
    let value = data;
    for (const key of path.slice(2).split('.')) {
        if (value === null || typeof value !== 'object' || !(key in value)) throw new StatesRuntime(`missing ${path}`);
        value = value[key];
    }
    return value;
}
function evaluate(expr: string, data: any, executionArn: string): any {
    const intrinsic = /^States\.(\w+)\((.*)\)$/.exec(expr);
    if (!intrinsic) return walk(expr, data, executionArn);
    const [, fn, rawArgs] = intrinsic as unknown as [string, string, string];
    const args = rawArgs.split(',').map(a => a.trim()).map(a => /^-?\d+$/.test(a) ? Number(a) : walk(a, data, executionArn));
    if (fn === 'MathAdd') { assert.equal(typeof args[0], 'number'); return (args[0] as number) + (args[1] as number); }
    if (fn === 'JsonToString') return JSON.stringify(args[0]);
    throw new StatesRuntime(`unsupported intrinsic ${fn}`);
}
function resolve(template: any, data: any, executionArn: string): any {
    if (Array.isArray(template)) return template.map(v => resolve(v, data, executionArn));
    if (template === null || typeof template !== 'object') return template;
    return Object.fromEntries(Object.entries(template).map(([key, value]) => key.endsWith('.$')
        ? [key.slice(0, -2), evaluate(value as string, data, executionArn)] : [key, resolve(value, data, executionArn)]));
}
function place(data: any, resultPath: string | null | undefined, value: any): any {
    if (resultPath === null) return data;
    if (resultPath === undefined || resultPath === '$') return value;
    const keys = resultPath.slice(2).split('.'), copy = structuredClone(data);
    let target = copy;
    for (const key of keys.slice(0, -1)) { if (typeof target[key] !== 'object' || target[key] === null) target[key] = {}; target = target[key]; }
    target[keys.at(-1)!] = value;
    return copy;
}

/** Runs a graph. `invoke` performs a Task; throw an Error whose name is the
 * Step Functions error name to simulate a failure. Wait advances `clock`. */
export async function runAsl(graph: any, opts: { input: any; executionArn: string; invoke: (resource: string, parameters: any, state: string) => Promise<any>;
    sleep: (seconds: number) => void; maxSteps?: number }): Promise<AslRun> {
    let data = structuredClone(opts.input), next: string = graph.StartAt;
    const visited: string[] = [];
    // Preserve the old test safety budget at the lifecycle's 5x faster cadence.
    for (let n = 0; n < (opts.maxSteps ?? 10000); n++) {
        const s = graph.States[next]; assert.ok(s, `unknown state ${next}`); visited.push(next);
        if (s.Type === 'Fail') return { error: s.Error ?? evaluate(s.ErrorPath, data, opts.executionArn),
            cause: s.Cause ?? (s.CausePath ? evaluate(s.CausePath, data, opts.executionArn) : undefined), data, visited };
        if (s.Type === 'Pass') {
            if (s.End) return { output: s.InputPath ? walk(s.InputPath, data, opts.executionArn) : data, data, visited };
            const value = s.Parameters ? resolve(s.Parameters, data, opts.executionArn) : s.InputPath ? walk(s.InputPath, data, opts.executionArn) : s.Result;
            data = place(data, s.ResultPath, structuredClone(value)); next = s.Next; continue;
        }
        if (s.Type === 'Choice') {
            next = s.Choices.find((c: any) => { try { const value = walk(c.Variable, data, opts.executionArn);
                if ('IsPresent' in c) return c.IsPresent === true;
                if ('NumericEquals' in c) return typeof value === 'number' && value === c.NumericEquals;
                return value === c.StringEquals; } catch { return c.IsPresent === false; } })?.Next ?? s.Default;
            assert.ok(next, 'Choice without match or default'); continue;
        }
        if (s.Type === 'Wait') {
            const seconds = s.Seconds ?? evaluate(s.SecondsPath, data, opts.executionArn);
            assert.ok(Number.isInteger(seconds) && seconds >= 0, 'Wait seconds must be a non-negative integer');
            opts.sleep(seconds); next = s.Next; continue;
        }
        assert.equal(s.Type, 'Task');
        const parameters = resolve(s.Parameters, data, opts.executionArn);
        let attempts = 0;
        for (;;) {
            try {
                const raw = await opts.invoke(s.Resource, parameters, next);
                const result = s.ResultSelector ? resolve(s.ResultSelector, raw, opts.executionArn) : raw;
                data = place(data, s.ResultPath, result); next = s.Next; break;
            } catch (error) {
                if (error instanceof StatesRuntime || (error as Error).name === 'AssertionError') throw error;
                const name = (error as Error).name, message = (error as Error).message;
                const retry = (s.Retry ?? []).find((r: any) => r.ErrorEquals.includes(name) || r.ErrorEquals.includes('States.ALL'));
                if (retry && attempts < retry.MaxAttempts) { attempts++; opts.sleep(retry.IntervalSeconds * retry.BackoffRate ** (attempts - 1)); continue; }
                const caught = (s.Catch ?? []).find((c: any) => c.ErrorEquals.includes(name) || c.ErrorEquals.includes('States.ALL'));
                if (!caught) return { error: name, cause: message, data, visited };
                data = place(data, caught.ResultPath, { Error: name, Cause: message }); next = caught.Next; break;
            }
        }
    }
    throw new Error('unbounded workflow');
}
/** An error as a Step Functions task would report it. */
export function taskError(name: string, cause = name): TaskError { const e = new Error(cause); e.name = name; return e; }
