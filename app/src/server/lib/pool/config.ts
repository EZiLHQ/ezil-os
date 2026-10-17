export const POOL_HARD_MAX = 8;

function integer(value: string | undefined, fallback: number, ceiling: number) {
    if (value === undefined || !/^\d+$/.test(value.trim())) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? Math.min(parsed, ceiling) : fallback;
}

export function parsePoolConfig(env: Record<string, string | undefined> = process.env) {
    const maxTotal = integer(env.POOL_MAX_TOTAL, 0, POOL_HARD_MAX);
    const targets = {
        standard: integer(env.POOL_TARGET_STANDARD, 0, POOL_HARD_MAX),
        performance: integer(env.POOL_TARGET_PERFORMANCE, 0, POOL_HARD_MAX),
    };
    return {
        targets,
        maxTotal,
        subscriberReserve: integer(env.POOL_SUBSCRIBER_RESERVE, 1, POOL_HARD_MAX),
        readyTtlSeconds: integer(env.POOL_READY_TTL_SECONDS, 1800, 2_147_483_647),
        enabled: maxTotal > 0 && (targets.standard > 0 || targets.performance > 0),
    };
}

export type PoolConfig = ReturnType<typeof parsePoolConfig>;
