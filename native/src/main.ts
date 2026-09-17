import { startNativeServer } from './server.ts';
import { launchOptions, readyLine } from './launch.ts';

// Only inherited values; no .env loader, config discovery, credentials, or CLI flags.
try {
    const server = startNativeServer(launchOptions(process.env));
    console.log(readyLine(server.port));
    let stopping = false;
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => {
        if (stopping) return;
        stopping = true;
        await server.stop(); process.exit(0);
    });
} catch {
    console.error('native_start_failed'); process.exit(1);
}
