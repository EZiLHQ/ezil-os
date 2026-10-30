/** Offline browser fixtures: never serve a stub for a lookalike or malformed origin. */
export function fixtureUrl(raw, expected) {
    try {
        const url = new URL(raw);
        return url.origin === new URL(expected).origin && !url.username && !url.password ? url : null;
    } catch {
        return null;
    }
}
