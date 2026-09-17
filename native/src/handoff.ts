import { randomUUID } from 'node:crypto';
import { NativeError, type Surface } from './contract.ts';

export type HandoffState = 'opened' | 'unavailable';
export interface Handoff {
    id: string; workspaceId: string; surface: Surface; action: 'open' | 'focus';
    files: string; profile: string; previewPorts: number[];
}
/** Authenticated Electron admin polls and acknowledges these bounded requests. */
export class Handoffs {
    private pending = new Map<string, { request: Handoff; finish: (state: HandoffState) => void; delivered: boolean }>();
    constructor(private timeoutMs = 8_000) {}
    open(input: Omit<Handoff, 'id'>): Promise<HandoffState> {
        if (this.pending.size >= 16) throw new NativeError('handoff_busy', 429);
        const id = randomUUID();
        return new Promise(resolve => {
            const timer = setTimeout(() => finish('unavailable'), this.timeoutMs);
            const finish = (state: HandoffState) => { clearTimeout(timer); this.pending.delete(id); resolve(state); };
            this.pending.set(id, { request: { ...input, id }, finish, delivered: false });
        });
    }
    take(): Handoff[] {
        const requests: Handoff[] = [];
        for (const entry of this.pending.values()) if (!entry.delivered) { entry.delivered = true; requests.push(entry.request); }
        return requests;
    }
    hasWorkspace(workspaceId: string): boolean {
        return [...this.pending.values()].some(entry => entry.request.workspaceId === workspaceId);
    }
    complete(id: string, state: HandoffState): void {
        const entry = this.pending.get(id);
        if (!entry?.delivered) throw new NativeError('handoff_not_found', 404);
        entry.finish(state);
    }
    stop(): void { for (const entry of this.pending.values()) entry.finish('unavailable'); }
}
