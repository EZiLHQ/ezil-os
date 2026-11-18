import { attachmentName, renderSelectionContext, validateAttachment, validateDoc, validateSelection, type Attachment, type PreviewDoc, type Selection } from './contract';

interface OpenSelection { sel: Selection; id: string; added: boolean }
/** Effects are serialized so a slow initial add can never overwrite its subsequent stale update. */
export class SelectionContext {
    private doc: PreviewDoc | undefined;
    private selections = new Map<string, OpenSelection>();
    private effects = Promise.resolve();
    private disposed = false;
    selecting = false;
    constructor(private readonly token: () => string, private readonly add: (attachment: Attachment) => Promise<boolean>, private readonly status: (text: string) => void) {}
    reset(): void { this.doc = undefined; }
    dispose(): void { this.disposed = true; this.selections.clear(); this.doc = undefined; }
    private enqueue(effect: () => Promise<void>): Promise<void> {
        this.effects = this.effects.then(async () => { if (!this.disposed) await effect(); });
        return this.effects;
    }
    observe(value: unknown): Promise<void> {
        if (!validateDoc(value)) return Promise.resolve();
        this.doc = value;
        for (const entry of this.selections.values()) {
            if (entry.sel.doc.gen === value.gen && entry.sel.doc.mut === value.mut && entry.sel.doc.path === value.path) continue;
            // Forget it before queueing: later revisions must never re-add a removed attachment.
            this.selections.delete(entry.id);
            void this.enqueue(async () => { if (entry.added) await this.send(entry, true); });
        }
        return this.effects;
    }
    select(value: unknown): Promise<void> {
        if (!this.selecting || !validateSelection(value)) return Promise.resolve();
        if (!this.doc || value.doc.gen !== this.doc.gen) {
            this.status('Selection ignored: the preview document has changed.');
            return Promise.resolve();
        }
        const entry: OpenSelection = { sel: value, id: `ezil-preview:${this.token()}`, added: false };
        this.selections.set(entry.id, entry);
        const added = this.enqueue(async () => {
            entry.added = await this.send(entry, false);
            if (!entry.added) this.selections.delete(entry.id);
        });
        // A mutation may have reached the host before the click message from the same document.
        if (value.doc.mut !== this.doc.mut || value.doc.path !== this.doc.path) return this.observe(this.doc);
        return added;
    }
    private async send(entry: OpenSelection, stale: boolean): Promise<boolean> {
        const attachment: Attachment = { v: 1, id: entry.id, name: attachmentName(entry.sel), value: renderSelectionContext(entry.sel, { stale }), stale };
        let accepted = false;
        try { if (validateAttachment(attachment)) accepted = await this.add(attachment); } catch { /* Never expose hook errors or URLs. */ }
        if (!this.disposed) this.status(accepted ? stale ? 'Selection marked stale in chat.' : 'Selection added to chat.' : 'Could not update the chat attachment.');
        return accepted;
    }
}
