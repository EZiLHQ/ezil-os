// OS, Universe, Works and storage must be selected as one deployment.
export const stageAssignment = {
    os: 'https://os-staging.ezil.work', universe: 'https://universe-staging.ezil.work',
    works: 'https://api-staging.ezil.work',
    storage: 'https://ezil-universe-staging-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com',
    prefix: '/universe-staging/assignment-media/v1/',
} as const;

export const productionAssignment = {
    os: 'https://os.ezil.work', universe: 'https://universe.ezil.work',
    works: 'https://assignment-api.ezil.work',
    storage: 'https://ezil-universe-production-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com',
    prefix: '/universe-production/assignment-media/v1/',
} as const;

export function assignmentAuthority(env: Record<string, string | undefined> = process.env) {
    const stage = env.BILLING_FUNDING_URL === 'https://ai-staging.ezil.work' || env.BILLING_FUNDING_URL === 'https://ai-staging.ezil.work/';
    const production = env.BILLING_FUNDING_URL === 'https://ai.ezil.work' || env.BILLING_FUNDING_URL === 'https://ai.ezil.work/';
    if (stage && !env.EZIL_ASSIGNMENT_PRODUCTION_ENABLED &&
        (!env.UNIVERSE_PROJECT_REPO_ORIGIN || env.UNIVERSE_PROJECT_REPO_ORIGIN === stageAssignment.universe)) return stageAssignment;
    if (production && env.EZIL_ASSIGNMENT_PRODUCTION_ENABLED === '1' &&
        env.UNIVERSE_PROJECT_REPO_ORIGIN === productionAssignment.universe) return productionAssignment;
    return undefined;
}
