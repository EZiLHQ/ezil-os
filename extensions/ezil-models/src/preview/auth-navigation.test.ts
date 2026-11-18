import { expect, test } from 'bun:test';

// Run separately so importing the real Worker handlers does not pull Worker types into the extension build.
test('real auth checks iframe partitions and fresh tabs on Cloudflare and AWS, cookies kept or blocked', () => {
    const result = Bun.spawnSync([process.execPath, new URL('fixtures/auth-navigation.mjs', import.meta.url).pathname]);
    expect(result.stderr.toString()).toBe('');
    expect(result.stdout.toString()).toContain('PASS AWS blocked-cookie bootstrap and reload authenticate through the Worker fallback');
    expect(result.stdout.toString()).not.toContain('KNOWN BASELINE GAP');
    expect(result.stdout.toString()).toContain('5 pass, 0 known baseline gap, 0 fail; modeled browser contexts, real Worker auth');
    expect(result.exitCode).toBe(0);
});
