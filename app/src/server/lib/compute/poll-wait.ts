import type { PlacementDb } from './placement';

export class PollStoppedError extends Error {
    constructor() { super('poll_stopped'); }
}

/** One monotonic budget, shared by every read and delay in a hold. */
export class PollDeadline {
    readonly deadline: number;
    constructor(ms: number, readonly signal?: AbortSignal) {
        this.deadline = performance.now() + ms;
    }
    remaining(): number { return this.deadline - performance.now(); }
    check(): void {
        if (this.signal?.aborted || this.remaining() <= 0) throw new PollStoppedError();
    }
    /** Only read-only work may be abandoned. Late results/rejections are consumed. */
    async read<T>(read: () => Promise<T>): Promise<T> {
        this.check();
        return new Promise<T>((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                this.signal?.removeEventListener('abort', stop);
            };
            const stop = () => { cleanup(); reject(new PollStoppedError()); };
            const timer = setTimeout(stop, this.remaining());
            this.signal?.addEventListener('abort', stop, { once: true });
            // Check again when accepting an answer: the event loop may deliver a
            // dependency before an already-due timer callback.
            void Promise.resolve().then(() => { this.check(); return read(); }).then(value => {
                this.check();
                cleanup();
                resolve(value);
            }).catch(error => { cleanup(); reject(error); });
        });
    }
    /** Never detach a command that can mutate state or hold a database lock. */
    async settle<T>(work: () => Promise<T>): Promise<T> {
        this.check();
        const value = await work();
        this.check();
        return value;
    }
}

/** Outside transactions callers only read. Inside, drain each issued command
 * before checking cancellation, and throw before commit to roll back writes.
 * A transaction already in flight must settle; it is never raced/detached.
 */
export function pollDatabase(db: PlacementDb, poll: PollDeadline): PlacementDb {
    return {
        execute: query => poll.read(() => db.execute(query)),
        transaction: run => poll.settle(() => db.transaction(async tx => {
            poll.check();
            const value = await run({ execute: query => poll.settle(() => tx.execute(query)) });
            poll.check();
            return value;
        })),
    };
}

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
