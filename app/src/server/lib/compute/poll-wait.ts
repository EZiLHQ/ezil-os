/** A polling delay with no outstanding timer/listener after a disconnect. */
export function pollWait(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
        const finish = (elapsed: boolean) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            resolve(elapsed);
        };
        const abort = () => finish(false);
        const timer = setTimeout(() => finish(true), ms);
        signal?.addEventListener('abort', abort, { once: true });
    });
}
