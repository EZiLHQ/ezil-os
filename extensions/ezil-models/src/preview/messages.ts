import { record, TOKEN, validateDoc, validateSelection, type PreviewDoc, type Selection } from './contract';

export type FrameMessage = { type: 'select'; sel: Selection } | { type: 'ready' | 'navigate' | 'changed'; doc: PreviewDoc }
    | { type: 'state'; state: string };
export interface FrameEvent { source: unknown; origin: string; data: unknown }

/** Each host navigation invalidates the previous hello, even though contentWindow itself is unchanged. */
export class FrameMessages {
    private nonce: string | undefined;
    private generation = 0;
    private helloGeneration = -1;
    private ready = false;
    selecting = false;
    constructor(readonly origin: string) {}
    invalidate(): void { this.generation++; this.nonce = undefined; this.ready = false; }
    hello(nonce: string): void {
        this.nonce = TOKEN.test(nonce) ? nonce : undefined;
        this.helloGeneration = this.generation;
        this.ready = false;
    }
    accept(event: FrameEvent, frameWindow: unknown): FrameMessage | undefined {
        const data = event.data;
        if (!frameWindow || event.source !== frameWindow || event.origin !== this.origin || !this.nonce
            || this.helloGeneration !== this.generation || !record(data) || data.v !== 1 || data.nonce !== this.nonce) return;
        const type = typeof data.type === 'string' ? data.type.replace(/^ezil\.preview\./, '') : '';
        if (data.type !== `ezil.preview.${type}`) return;
        const payload = type === 'select' ? 'sel' : type === 'state' ? 'state' : 'doc';
        if (Object.keys(data).some(key => !['type', 'v', 'nonce', payload].includes(key))) return;
        if (type === 'state' && typeof data.state === 'string' && /^[a-z_]{1,40}$/.test(data.state)) {
            this.ready = false;
            return { type, state: data.state };
        }
        if (['ready', 'navigate', 'changed'].includes(type) && validateDoc(data.doc)) {
            if (type === 'ready') this.ready = true;
            else if (!this.ready) return;
            return { type: type as 'ready' | 'navigate' | 'changed', doc: data.doc };
        }
        if (type === 'select' && this.ready && this.selecting && validateSelection(data.sel)) return { type, sel: data.sel };
    }
}
