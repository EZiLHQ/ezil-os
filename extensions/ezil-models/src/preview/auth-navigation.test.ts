import { expect, test } from 'bun:test';

// Run separately so importing the real Worker handlers does not pull Worker types into the extension build.
test('real auth checks iframe partitions and fresh tabs; AWS blocked cookies remain a known baseline gap', () => {
    const result = Bun.spawnSync([process.execPath, new URL('fixtures/auth-navigation.mjs', import.meta.url).pathname]);
    expect(result.stderr.toString()).toBe('');
    expect(result.stdout.toString()).toContain('KNOWN BASELINE GAP (not acceptance): AWS blocked-cookie navigation');
    expect(result.stdout.toString()).toContain('4 pass, 1 known baseline gap, 0 fail; modeled browser contexts, real Worker auth');
    expect(result.exitCode).toBe(0);
});
