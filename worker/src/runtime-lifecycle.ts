/** Provider messages can contain configuration; retain only known exit classifications. */
export function classifyRuntimeExit(error?: unknown): { reason: string; exitCode: number | null } {
  if (error === undefined) return { reason: 'exit', exitCode: 0 };
  const message = error instanceof Error ? error.message : '';
  const signal = message.match(/runtime signalled the container to exit:\s*(\d+)\b/i);
  if (signal) return { reason: 'runtime_signal', exitCode: Number(signal[1]) };
  const exit = message.match(/container exited with unexpected exit code:\s*(\d+)\b/i);
  if (exit) return { reason: 'exit', exitCode: Number(exit[1]) };
  if (message.toLowerCase().includes('there is no container instance that can be provided')) {
    return { reason: 'instance_unavailable', exitCode: null };
  }
  return { reason: 'monitor_error', exitCode: null };
}

/** Observe only. Never restart compute, retry a monitor, or expose its raw error. */
export class RuntimeLifecycleMonitor {
  private flight: Promise<void> | null = null;
  watch(monitor: () => Promise<void>, report: (exit: ReturnType<typeof classifyRuntimeExit>) => void): void {
    if (this.flight) return;
    let source: Promise<void>;
    try { source = monitor(); }
    catch (error) { report(classifyRuntimeExit(error)); return; }
    const flight = source.then(
      () => report(classifyRuntimeExit()),
      error => report(classifyRuntimeExit(error)),
    ).then(() => undefined, () => undefined);
    this.flight = flight;
    void flight.finally(() => { if (this.flight === flight) this.flight = null; });
  }
}
