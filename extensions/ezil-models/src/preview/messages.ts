import { record, TOKEN, validToken, validateAgentResult, validateDoc, validateSelection, type AgentResult, type PreviewDoc, type Selection } from './contract';

export type FrameMessage = { type: 'select'; sel: Selection } | { type: 'ready' | 'navigate' | 'changed'; doc: PreviewDoc }
    | { type: 'state'; state: string } | { type: 'agent-result'; id: string; doc: PreviewDoc; result: AgentResult };
export interface FrameEvent { source: unknown; origin: string; data: unknown }
const FRAME_TYPES = new Map<string, FrameMessage['type']>([
    ['ezil.preview.ready', 'ready'], ['ezil.preview.navigate', 'navigate'], ['ezil.preview.changed', 'changed'],
    ['ezil.preview.select', 'select'], ['ezil.preview.state', 'state'], ['ezil.preview.agent-result', 'agent-result'],
]);

/** Each host navigation invalidates the previous hello, even though contentWindow itself is unchanged. */
export class FrameMessages {
    private nonce: string | undefined;
    private generation = 0;
    private helloGeneration = -1;
    private ready = false;
    private doc: PreviewDoc | undefined;
    selecting = false;
    constructor(readonly origin: string) {}
    invalidate(): void { this.generation++; this.nonce = undefined; this.ready = false; this.doc = undefined; }
    hello(nonce: string): void {
        this.nonce = TOKEN.test(nonce) ? nonce : undefined;
        this.helloGeneration = this.generation;
        this.ready = false;
        this.doc = undefined;
    }
    accept(event: FrameEvent, frameWindow: unknown): FrameMessage | undefined {
        const data = event.data;
        if (!frameWindow || event.source !== frameWindow || event.origin !== this.origin || !this.nonce
            || this.helloGeneration !== this.generation || !record(data) || data.v !== 1 || data.nonce !== this.nonce) return;
        const type = typeof data.type === 'string' ? FRAME_TYPES.get(data.type) : undefined;
        if (!type) return;
        if (type === 'agent-result') {
            if (this.ready && Object.keys(data).length === 6 && validToken(data.id) && validateDoc(data.doc)
                && data.doc.gen === this.doc?.gen && validateAgentResult(data.result)) {
                return { type, id: data.id, doc: data.doc, result: data.result };
            }
            return;
        }
        const payload = type === 'select' ? 'sel' : type === 'state' ? 'state' : 'doc';
        if (Object.keys(data).some(key => !['type', 'v', 'nonce', payload].includes(key))) return;
        if (type === 'state' && typeof data.state === 'string' && /^[a-z_]{1,40}$/.test(data.state)) {
            this.ready = false;
            this.doc = undefined;
            return { type, state: data.state };
        }
        if (['ready', 'navigate', 'changed'].includes(type) && validateDoc(data.doc)) {
            if (type === 'ready') {
                if (this.ready) return;
                this.ready = true;
            } else if (!this.ready || data.doc.gen !== this.doc?.gen || data.doc.mut < this.doc.mut) return;
            this.doc = data.doc;
            return { type: type as 'ready' | 'navigate' | 'changed', doc: data.doc };
        }
        if (type === 'select' && this.ready && this.selecting && validateSelection(data.sel)) return { type, sel: data.sel };
    }
}
