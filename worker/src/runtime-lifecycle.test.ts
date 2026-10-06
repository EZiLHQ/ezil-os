import { describe, expect, it } from 'bun:test';
import { classifyRuntimeExit, RuntimeLifecycleMonitor } from './runtime-lifecycle';

describe('runtime lifecycle diagnostics', () => {
  it('retains known exit codes and never retains private provider messages', () => {
    expect(classifyRuntimeExit()).toEqual({reason:'exit',exitCode:0});
    expect(classifyRuntimeExit(new Error('runtime signalled the container to exit: 137')))
      .toEqual({reason:'runtime_signal',exitCode:137});
    expect(classifyRuntimeExit(new Error('container exited with unexpected exit code: 1')))
      .toEqual({reason:'exit',exitCode:1});
    expect(classifyRuntimeExit(new Error('there is no container instance that can be provided to this durable object')))
      .toEqual({reason:'instance_unavailable',exitCode:null});
    expect(classifyRuntimeExit(new Error('secret URL and credentials')))
      .toEqual({reason:'monitor_error',exitCode:null});
  });
  it('shares an active monitor, reports its exit once, and observes the next runtime', async () => {
    const watcher = new RuntimeLifecycleMonitor();
    const reports: unknown[] = []; let calls = 0;
    let stop!: () => void;
    const monitor = () => { calls++; return new Promise<void>(resolve => { stop = resolve; }); };
    watcher.watch(monitor, exit => reports.push(exit));
    watcher.watch(monitor, exit => reports.push(exit));
    expect(calls).toBe(1);
    stop(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(reports).toEqual([{reason:'exit',exitCode:0}]);
    watcher.watch(() => { calls++; return Promise.reject(new Error('runtime signalled the container to exit: 137')); }, exit => reports.push(exit));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    expect(reports[1]).toEqual({reason:'runtime_signal',exitCode:137});
  });
  it('reports a synchronous monitor failure without retrying or leaking its error', () => {
    let calls = 0; const reports: unknown[] = [];
    new RuntimeLifecycleMonitor().watch(() => { calls++; throw new Error('private configuration'); }, exit => reports.push(exit));
    expect(calls).toBe(1);
    expect(reports).toEqual([{reason:'monitor_error',exitCode:null}]);
  });
});
