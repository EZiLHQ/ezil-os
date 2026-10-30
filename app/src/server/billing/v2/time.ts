/** Convert instants before doing billing arithmetic, never carrying fractional seconds. */
export function epochSeconds(instant: Date | string, rounding: 'floor' | 'ceil' = 'floor'): number {
    const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant);
    if (!Number.isFinite(ms)) throw new RangeError('Invalid billing instant');
    return rounding === 'ceil' ? Math.ceil(ms / 1000) : Math.floor(ms / 1000);
}

/** v2 wire instants are UTC whole seconds, including the absence of `.000`. */
export function isoSeconds(seconds: number): string {
    if (!Number.isSafeInteger(seconds)) throw new RangeError('Expected integer epoch seconds');
    return new Date(seconds * 1000).toISOString().replace(/\.000Z$/, 'Z');
}
