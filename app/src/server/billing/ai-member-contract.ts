/**
 * The Gateway membership contract OS uses, chosen by the parsed origin of BILLING_FUNDING_URL,
 * exactly (render-env pins production to ai.ezil.work and staging to ai-staging.ezil.work):
 *   - staging: gw-ui scripts/os-staging, `ezil_works.enroll_ai_member` and the `ezil_works.ai_members` view;
 *   - production: Gateway 0030_identity_sources, `ezil_ai.enroll_os_member` and `ezil_ai.os_member_by_auth`.
 * Both enroll through the NOLOGIN role `ezil_os_ai_enroller`. Any other origin, or none, is null.
 */
export type AiMemberContract = 'staging' | 'production';

const CONTRACTS: ReadonlyMap<string, AiMemberContract> = new Map([
    ['https://ai-staging.ezil.work', 'staging'],
    ['https://ai.ezil.work', 'production'],
]);

export function aiMemberContract(fundingUrl: string | undefined): AiMemberContract | null {
    if (!fundingUrl) return null;
    try { return CONTRACTS.get(new URL(fundingUrl).origin) ?? null; } catch { return null; }
}
