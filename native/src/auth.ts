import { createHash, randomBytes } from 'node:crypto';
import { NativeError, type NativeOperation } from './contract.ts';

export type Role = 'admin' | 'shell' | 'connector';
export interface Capability { role: Role; workspaceId?: string; expiresAt: number }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export class Authority {
    // Only verifiers are retained, including for one-use pairing codes.
    private capabilities = new Map<string, Capability>();
    private pairings = new Map<string, { workspaceId: string; expiresAt: number }>();
    constructor(adminToken: string, private now = Date.now) {
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(adminToken)) throw new NativeError('invalid_admin_token');
        this.capabilities.set(hash(adminToken), { role: 'admin', expiresAt: Infinity });
    }
    private prune(): void {
        for (const [k, v] of this.capabilities) if (v.expiresAt <= this.now()) this.capabilities.delete(k);
        for (const [k, v] of this.pairings) if (v.expiresAt <= this.now()) this.pairings.delete(k);
    }
    mint(role: 'shell' | 'connector', workspaceId: string): { token: string; expiresAt: number } {
        this.prune();
        if (this.capabilities.size >= 256) throw new NativeError('capability_limit', 429);
        const token = secret();
        const expiresAt = this.now() + (role === 'shell' ? 5 : 15) * 60_000;
        this.capabilities.set(hash(token), { role, workspaceId, expiresAt });
        return { token, expiresAt };
    }
    authenticate(header: string | null): Capability {
        this.prune();
        if (!header?.startsWith('Bearer ') || header.length > 140) throw new NativeError('unauthorized', 401);
        const cap = this.capabilities.get(hash(header.slice(7)));
        if (!cap) throw new NativeError('unauthorized', 401);
        return cap;
    }
    authorize(cap: Capability, operation: NativeOperation): void {
        if (cap.role === 'admin') return;
        if (!('workspaceId' in operation) || operation.workspaceId !== cap.workspaceId) throw new NativeError('forbidden', 403);
        const allowed = cap.role === 'shell'
            ? ['workspace.get', 'workspace.select', 'surface.open', 'surface.focus', 'diagnostics.read', 'preview.list',
                'code.open', 'code.status', 'code.close', 'preview.open', 'preview.status', 'preview.close',
                'browser.attach', 'browser.layout', 'browser.focus', 'browser.detach', 'browser.snapshot',
                'browser.navigate', 'browser.back', 'browser.forward', 'browser.reload']
            : ['editor.readiness', 'preview.register', 'preview.unregister'];
        if (!allowed.includes(operation.op) || (operation.op === 'editor.readiness' && operation.state === 'closed')) throw new NativeError('forbidden', 403);
    }
    revokeWorkspace(id: string): void {
        for (const [k, cap] of this.capabilities) if (cap.workspaceId === id) this.capabilities.delete(k);
        for (const [k, code] of this.pairings) if (code.workspaceId === id) this.pairings.delete(k);
    }
    /** Primitive only: no unauthenticated pairing HTTP endpoint or browser UI. */
    createPairing(workspaceId: string): { code: string; expiresAt: number } {
        this.prune();
        if (this.pairings.size >= 16) throw new NativeError('pairing_limit', 429);
        const code = randomBytes(16).toString('base64url');
        const expiresAt = this.now() + 60_000;
        this.pairings.set(hash(code), { workspaceId, expiresAt });
        return { code, expiresAt };
    }
    redeemPairing(code: string): { token: string; expiresAt: number } {
        this.prune();
        const key = hash(code);
        const entry = this.pairings.get(key);
        if (!entry) throw new NativeError('invalid_pairing', 401);
        this.pairings.delete(key);
        return this.mint('shell', entry.workspaceId);
    }
}
