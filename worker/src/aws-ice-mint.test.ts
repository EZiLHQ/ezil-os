import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { relayExpiryFor } from './relay-refresh';
import type { RelayMint } from './aws-ice';

// Execute the production factory with a local credential issuer. Importing the
// whole Worker requires Cloudflare runtime bindings; no network is involved.
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const factory = source.slice(source.indexOf('function awsRelayMint('), source.indexOf('\n/**', source.indexOf('function awsRelayMint(')));
const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(factory);
const servers = [{ urls: ['turn:relay.example:3478'], username: 'test-user', credential: 'test-password' }];
const issuedAt = 1_800_000_000_000;
const make = (ttl: number, issued = servers) => new Function('generateTurnCredentials', 'resolveTurnTtlSeconds', 'relayExpiryFor', 'Date',
    `${js}; return awsRelayMint({});`)(async () => issued, () => ttl, relayExpiryFor, { now: () => issuedAt }) as RelayMint;

describe('AWS production relay issuer uses the host clock margin at boot and renewal', () => {
    for (const purpose of ['boot', 'renewal', undefined] as const) {
        it(`${purpose ?? 'default renewal'} stays below the host maximum with 59 seconds clock lag`, async () => {
            const minted = await make(1800)(new AbortController().signal, purpose);
            expect(minted?.servers).toEqual(servers);
            expect(minted!.expiresAt).toBe(issuedAt + 1_740_000);
            expect(minted!.expiresAt).toBeLessThanOrEqual(issuedAt - 59_000 + 1_800_000);
        });
    }
    it('the shortest configured TTL remains above the host minimum', async () => {
        const minted = await make(300)(new AbortController().signal);
        expect(minted!.expiresAt).toBeGreaterThan(issuedAt + 60_000);
    });
});
