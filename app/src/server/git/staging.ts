import 'server-only';

import { readBillingConfig } from '@/server/billing/config';

/** The direct Git URL route is staged only where OS uses its staging funding origin. */
export function standaloneGitUrlEnabled(env: Record<string, string | undefined> = process.env): boolean {
    try {
        const { fundingUrl } = readBillingConfig(env);
        return Boolean(fundingUrl && new URL(fundingUrl).origin === 'https://ai-staging.ezil.work');
    } catch {
        return false;
    }
}

/** Host standalone operation is capability-gated independently of the existing URL feature. */
export function awsStandaloneGitEnabled(env: Record<string, string | undefined> = process.env): boolean {
    return /^(1|true|on)$/i.test((env.AWS_STANDALONE_REPO_OPEN_ENABLED ?? '').trim());
}
