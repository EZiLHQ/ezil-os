import { randomBytes } from 'node:crypto';
/** Bounded, process-local secret vault. Restart/replica miss fails closed; no disk or browser token storage. */
export class Vault<T> {
    private entries = new Map<string, { expiresAt: number; value: T }>();
    constructor(private max = 10000) {}
    put(value: T, expiresAt: number, now = Date.now()) {
        for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
        if (this.entries.size >= this.max || expiresAt <= now) throw new Error('project_repo_unavailable');
        const key = randomBytes(32).toString('base64url');
        this.entries.set(key, { value, expiresAt }); return key;
    }
    get(key: string | undefined, now = Date.now()): T | undefined {
        if (!key) return;
        const entry = this.entries.get(key);
        if (!entry || entry.expiresAt <= now) { this.entries.delete(key); return; }
        return entry.value;
    }
    take(key: string | undefined, now = Date.now()) { const value = this.get(key, now); if (key) this.entries.delete(key); return value; }
    expire(key: string, expiresAt: number) { const entry = this.entries.get(key); if (entry) entry.expiresAt = expiresAt; }
    delete(key: string | undefined) { if (key) this.entries.delete(key); }
}
