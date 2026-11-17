import { record, sanitizeUrl, validPath } from './contract';

export const VIEWPORTS = ['responsive', '390x844', '768x1024', '1280x800'] as const;
export type Viewport = typeof VIEWPORTS[number];
export interface PreviewState { open: true; path: string; viewport: Viewport }
export function viewport(value: unknown): Viewport {
    return VIEWPORTS.includes(value as Viewport) ? value as Viewport : 'responsive';
}
export function safePath(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
    const path = sanitizeUrl(value);
    return validPath(path) ? path : '/';
}
/** Construct a new record, never spread untrusted state (in particular URL/token fields). */
export function persistedState(value: unknown): PreviewState {
    const state = record(value) ? value : {};
    return { open: true, path: safePath(state.path), viewport: viewport(state.viewport) };
}
export function safeUrl(origin: string, path: unknown): string {
    return new URL(origin).origin + safePath(path);
}

/** Inspector paths are the source of truth for history; host loads reconcile with the requested entry. */
export class PreviewHistory {
    private entries: string[];
    private index = 0;
    private loading = false;
    constructor(path: string) { this.entries = [safePath(path)]; }
    get path(): string { return this.entries[this.index]!; }
    get back(): boolean { return this.index > 0; }
    get forward(): boolean { return this.index < this.entries.length - 1; }
    observed(path: string): void {
        path = safePath(path);
        if (this.loading) { this.entries[this.index] = path; this.loading = false; return; }
        if (this.path === path) return;
        this.entries.splice(this.index + 1);
        this.entries.push(path);
        this.index++;
        if (this.entries.length > 100) { this.entries.shift(); this.index--; }
    }
    move(direction: -1 | 1): string | undefined {
        if (direction === -1 ? !this.back : !this.forward) return;
        this.index += direction;
        this.loading = true;
        return this.path;
    }
}
