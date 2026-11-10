import { randomBytes } from 'node:crypto';

/**
 * Bounded, process-local secret vault (ported from 1ac89c72). A restart or another replica misses and so fails
 * closed; nothing is written to disk or to the browser, which holds only the random handle.
 */
export class Vault<T> {
    private entries = new Map<string, { expiresAt: number; value: T }>();
    constructor(private max = 10000) {}
    put(value: T, expiresAt: number, now = Date.now()) {
        for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
        if (this.entries.size >= this.max || expiresAt <= now) throw new Error('vault_unavailable');
        const key = randomBytes(32).toString('base64url');
        this.entries.set(key, { value, expiresAt }); return key;
    }
    get(key: string | undefined, now = Date.now()): T | undefined {
        if (!key) return;
        const entry = this.entries.get(key);
        if (!entry || entry.expiresAt <= now) { this.entries.delete(key); return; }
        return entry.value;
    }
    delete(key: string | undefined) { if (key) this.entries.delete(key); }
}
