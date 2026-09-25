import { DatabaseSync } from 'node:sqlite';
import { constants, lstatSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { ControlNonceStore } from './control-auth.js';
import { canonicalJson, intentDigest, type ReconcileCommand } from './control-protocol.js';

export type StoredIntent = { installationId: string; generation: number; desired: 'running' | 'stopped';
    command: ReconcileCommand; observed: 'unknown' | 'running' | 'stopped' | 'failed' };

/** Host-private recovery ledger. Postgres remains the control-plane authority.
 * The directory must be provisioned outside every application mount. The host
 * controller rotates its secret/computer generation on instance replacement. */
export class ControlStore implements ControlNonceStore {
    private readonly db: DatabaseSync;
    constructor(directory: string, private readonly computerId: string, private readonly computerGeneration: number) {
        if (!isAbsolute(directory) || normalize(directory) !== directory || /[\x00-\x1f\x7f]/.test(directory)) {
            throw new Error('invalid_control_directory');
        }
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(computerId)
            || !Number.isInteger(computerGeneration) || computerGeneration < 1 || computerGeneration > 2_147_483_647) {
            throw new Error('invalid_control_identity');
        }
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const directoryStat = lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077)) {
            throw new Error('invalid_control_directory');
        }
        const path = join(directory, 'control.sqlite');
        try { const file = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600); closeSync(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const file = lstatSync(path);
        if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077)) throw new Error('invalid_control_database');
        this.db = new DatabaseSync(path);
        try {
            this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), computer TEXT NOT NULL, generation INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS intents (installation TEXT PRIMARY KEY, generation INTEGER NOT NULL,
                digest TEXT NOT NULL, command TEXT NOT NULL, observed TEXT NOT NULL DEFAULT 'unknown');
            CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, installation TEXT NOT NULL, generation INTEGER NOT NULL, digest TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS runtime_leases (installation TEXT NOT NULL, generation INTEGER NOT NULL,
                digest TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(installation,generation));`);
            this.transaction(() => {
                const identity = this.db.prepare('SELECT computer,generation FROM identity WHERE id=1').get();
                if (identity && (identity.computer !== computerId || identity.generation !== computerGeneration)) {
                    throw new Error('control_identity_mismatch');
                }
                this.db.prepare('INSERT OR IGNORE INTO identity VALUES (1,?,?)').run(computerId, computerGeneration);
            });
        } catch (error) { this.db.close(); throw error; }
    }
    private transaction<T>(operation: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = operation(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    reserve(nonce: string, validUntilMs: number, nowMs: number): 'ok' | 'replay' | 'full' {
        return this.transaction(() => {
            this.db.prepare('DELETE FROM nonces WHERE expires < ?').run(nowMs);
            if (this.db.prepare('SELECT 1 FROM nonces WHERE nonce=?').get(nonce)) return 'replay';
            if (Number(this.db.prepare('SELECT count(*) AS n FROM nonces').get()?.n) >= 10_000) return 'full';
            this.db.prepare('INSERT INTO nonces VALUES (?,?)').run(nonce, validUntilMs);
            return 'ok';
        });
    }
    /** Records intent before any Docker operation. Same-generation changes
     * are rejected; a fresh request ID cannot resurrect an older generation. */
    accept(command: ReconcileCommand): 'accepted' | 'reused' {
        if (command.computerId !== this.computerId || command.computerGeneration !== this.computerGeneration) {
            throw new Error('control_identity_mismatch');
        }
        const digest = intentDigest(command);
        return this.transaction(() => {
            const request = this.db.prepare('SELECT digest FROM requests WHERE id=?').get(command.requestId);
            if (request && request.digest !== digest) throw new Error('request_id_conflict');
            const current = this.db.prepare('SELECT generation,digest FROM intents WHERE installation=?').get(command.installationId);
            if (current && Number(current.generation) > command.generation) throw new Error('stale_generation');
            if (current && Number(current.generation) === command.generation && current.digest !== digest) {
                throw new Error('generation_conflict');
            }
            if (!request && Number(this.db.prepare('SELECT count(*) AS n FROM requests').get()?.n) >= 100_000) {
                throw new Error('control_request_capacity');
            }
            this.db.prepare('INSERT OR IGNORE INTO requests VALUES (?,?,?,?)')
                .run(command.requestId, command.installationId, command.generation, digest);
            if (current?.digest === digest) return 'reused';
            this.db.prepare(`INSERT INTO intents VALUES (?,?,?,?,'unknown')
                ON CONFLICT(installation) DO UPDATE SET generation=excluded.generation,digest=excluded.digest,
                command=excluded.command,observed='unknown'`)
                .run(command.installationId, command.generation, digest, canonicalJson(command));
            return 'accepted';
        });
    }
    get(installationId: string): StoredIntent | undefined {
        const row = this.db.prepare('SELECT generation,command,observed FROM intents WHERE installation=?').get(installationId);
        if (!row) return undefined;
        const command = JSON.parse(String(row.command)) as ReconcileCommand;
        return { installationId, generation: Number(row.generation), desired: command.desired,
            command, observed: row.observed as StoredIntent['observed'] };
    }
    /** Commit a deadline before Docker creation. Retries, process restarts,
     * failed starts and deleted containers cannot extend the same command's
     * allowance. A known older Docker deadline may tighten the reservation. */
    reserveRuntimeDeadline(command: ReconcileCommand, proposed: number): number {
        if (command.computerId !== this.computerId || command.computerGeneration !== this.computerGeneration
            || command.desired !== 'running' || !Number.isSafeInteger(proposed) || proposed <= 0
            || proposed > Date.now() + command.plan.resources.maxRuntimeSeconds * 1000 + 1000) {
            throw new Error('invalid_runtime_deadline');
        }
        const digest = intentDigest(command);
        return this.transaction(() => {
            const intent = this.db.prepare('SELECT generation,digest FROM intents WHERE installation=?').get(command.installationId);
            if (intent?.generation !== command.generation || intent.digest !== digest) throw new Error('runtime_deadline_scope_mismatch');
            const lease = this.db.prepare('SELECT digest,expires FROM runtime_leases WHERE installation=? AND generation=?')
                .get(command.installationId, command.generation);
            if (lease && lease.digest !== digest) throw new Error('runtime_deadline_scope_mismatch');
            const expires = lease ? Math.min(Number(lease.expires), proposed) : proposed;
            this.db.prepare(`INSERT INTO runtime_leases VALUES (?,?,?,?)
                ON CONFLICT(installation,generation) DO UPDATE SET expires=excluded.expires`)
                .run(command.installationId, command.generation, digest, expires);
            return expires;
        });
    }
    /** Read the original reservation without creating or extending it. A
     * controller must reconcile observed expiry, never guess from enqueue time. */
    runtimeDeadline(command: ReconcileCommand): number | null {
        if (command.computerId !== this.computerId || command.computerGeneration !== this.computerGeneration) {
            throw new Error('control_identity_mismatch');
        }
        const lease = this.db.prepare('SELECT digest,expires FROM runtime_leases WHERE installation=? AND generation=?')
            .get(command.installationId, command.generation);
        if (!lease) return null;
        if (lease.digest !== intentDigest(command)) throw new Error('runtime_deadline_scope_mismatch');
        return Number(lease.expires);
    }
    list(): StoredIntent[] {
        return this.db.prepare('SELECT installation FROM intents ORDER BY installation').all()
            .map(row => this.get(String(row.installation))!);
    }
    observe(installationId: string, generation: number, state: StoredIntent['observed']): boolean {
        if (!['unknown', 'running', 'stopped', 'failed'].includes(state)) throw new Error('invalid_observation');
        return this.db.prepare('UPDATE intents SET observed=? WHERE installation=? AND generation=?')
            .run(state, installationId, generation).changes === 1;
    }
    close(): void { this.db.close(); }
}
