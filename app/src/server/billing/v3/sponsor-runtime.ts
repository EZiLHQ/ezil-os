/**
 * The sponsor runtime a request sees (server-only, built per call from the environment like the rest of the billing deps). Disabled unless
 * SPONSOR_TRIALS_ENABLED is exactly "1" AND a usable key AND a validly signed, non-empty registry are present: anything missing fails closed to
 * "no sponsor". Public trial authorization is read fresh from Stripe by the billing router. Nothing here reads the database or Stripe.
 */
import { accountKeyFor, parseSponsorRegistry, publicTrialEnabled, sponsorTrialsEnabled, EMPTY_REGISTRY, type SponsorRegistry } from './sponsor';

export interface SponsorRuntime {
    enabled: boolean;
    /** @deprecated Legacy compatibility projection; billing authorization ignores this and reads Stripe Product metadata. */
    publicTrial: boolean;
    registry: SponsorRegistry;
    /** Pseudonymous account key, or null when the runtime is disabled. */
    accountKey(userId: string): string | null;
}

type Env = Record<string, string | undefined>;
export function readSponsorRuntime(env: Env = process.env): SponsorRuntime {
    const key = env.SPONSOR_KEY;
    const registry = sponsorTrialsEnabled(env) && key && key.length >= 32
        ? parseSponsorRegistry({ document: env.SPONSOR_REGISTRY, signature: env.SPONSOR_REGISTRY_SIG, key: env.SPONSOR_REGISTRY_KEY }) : EMPTY_REGISTRY;
    const enabled = registry.size > 0;
    return { enabled, publicTrial: publicTrialEnabled(env), registry, accountKey: userId => (enabled && key ? accountKeyFor(userId, key) : null) };
}
