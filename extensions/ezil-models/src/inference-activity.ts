import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, futimesSync, lstatSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import type { ResolvedProvider } from './config';

export const INFERENCE_ACTIVITY_DIR = '/tmp/ezil-code-ai-activity';
export const INFERENCE_ACTIVITY_REFRESH_MS = 15_000;

/** Only the workspace extension using the hosted boot proxy can produce the guest idle-work marker. */
export function hostedInferenceActivity(provider: ResolvedProvider, signal: AbortSignal): (() => void) | undefined {
    const bootUrl = process.env.EZIL_AI_BASE_URL?.trim().replace(/\/+$/, '');
    const bootToken = process.env.EZIL_AI_PROXY_TOKEN;
    if (provider.type !== 'ezil-gateway' || !bootUrl || provider.baseUrl !== bootUrl ||
        !bootToken || !/^[0-9a-f]{64}$/.test(bootToken) || provider.apiKey !== bootToken) return;
    return beginInferenceActivity(signal);
}

/** An empty, private lease for one inference. The host also checks process liveness and mtime. */
export function beginInferenceActivity(signal: AbortSignal, directory = INFERENCE_ACTIVITY_DIR): (() => void) | undefined {
    if (process.platform !== 'linux' || signal.aborted) return;

    let directoryFd: number | undefined;
    let markerFd: number | undefined;
    let markerPath: string | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let ended = false;

    const end = () => {
        if (ended) return;
        ended = true;
        if (timer !== undefined) clearInterval(timer);
        signal.removeEventListener('abort', end);
        if (markerFd !== undefined) {
            try {
                const marker = fstatSync(markerFd);
                const visible = lstatSync(markerPath!);
                if (marker.dev === visible.dev && marker.ino === visible.ino) unlinkSync(markerPath!);
            } catch { /* A missing/replaced marker must not affect inference or another file. */ }
            try { closeSync(markerFd); } catch { /* A stale marker expires even if cleanup fails. */ }
        }
        if (directoryFd !== undefined) {
            try { closeSync(directoryFd); } catch { /* Best effort only. */ }
        }
    };

    try {
        try { mkdirSync(directory, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        directoryFd = openSync(directory, constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY);
        const owner = fstatSync(directoryFd);
        if (owner.uid !== process.getuid?.() || (owner.mode & 0o7777) !== 0o700) { end(); return; }
        // Resolve the filename through the verified directory descriptor, even if its public path is replaced.
        markerPath = `/proc/self/fd/${directoryFd}/${process.pid}-${randomUUID()}`;
        markerFd = openSync(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
        fchmodSync(markerFd, 0o600);
        const fd = markerFd;
        timer = setInterval(() => {
            if (ended) return;
            const now = new Date();
            try { futimesSync(fd, now, now); } catch { end(); }
        }, INFERENCE_ACTIVITY_REFRESH_MS);
        timer.unref?.();
        signal.addEventListener('abort', end, { once: true });
        return end;
    } catch {
        end();
        return;
    }
}
