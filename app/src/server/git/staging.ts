import 'server-only';

import { readBillingConfig } from '@/server/billing/config';

/**
 * The two canonical funding roots (os-staging's and production's AI Gateway), each bare or with exactly
 * one root slash. A closed string table: nothing is parsed, trimmed or case-folded, so userinfo, a path,
 * query, hash, any explicit port, http, whitespace or a look-alike never matches.
 */
const STANDALONE_GIT_FUNDING_ROOTS: ReadonlySet<string> = new Set([
    'https://ai-staging.ezil.work', 'https://ai-staging.ezil.work/',
    'https://ai.ezil.work', 'https://ai.ezil.work/',
]);

/** The direct Git URL route is enabled only where OS uses a canonical funding root; anything else fails closed. */
export function standaloneGitUrlEnabled(env: Record<string, string | undefined> = process.env): boolean {
    try {
        const { fundingUrl } = readBillingConfig(env);
        // The raw value must be the accepted one: a config reader that ever normalised it never widens this gate.
        return typeof fundingUrl === 'string' && fundingUrl === env.BILLING_FUNDING_URL && STANDALONE_GIT_FUNDING_ROOTS.has(fundingUrl);
    } catch {
        return false;
    }
}

/** Host standalone operation is capability-gated independently of the existing URL feature. */
export function awsStandaloneGitEnabled(env: Record<string, string | undefined> = process.env): boolean {
    return /^(1|true|on)$/i.test((env.AWS_STANDALONE_REPO_OPEN_ENABLED ?? '').trim());
}
