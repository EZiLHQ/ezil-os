// legacy-work-link.js — EZiL-authored. The neutral Universe link Code offers when a staging AWS computer refuses a
// legacy project bookmark (`/app/code?project=<uuid>&repo=<uuid>`) as `repo_open_unsupported_provider`.
import { STAGING_OS } from '../assignment-video/current-tab.js';

/** Universe staging's protected page for a legacy two-UUID Code link. */
export const LEGACY_WORK_ORIGIN = 'https://universe-staging.ezil.work';
export const LEGACY_WORK_LABEL = 'Check this link in Universe';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `{label, href}` for that refusal, or null. Only on the staging OS origin, only for this one refusal, and only for a
 * project's two ids (never a repository address). The two canonical lowercase UUIDs the bookmark already carried are
 * the only thing the link names: no path, folder, computer or account detail leaves EZiL OS.
 */
export function legacyWorkLink ({ origin, errorCode, project } = {}) {
    if ( origin !== STAGING_OS || errorCode !== 'repo_open_unsupported_provider' ) return null;
    if ( ! project || typeof project !== 'object' || Object.hasOwn(project, 'repoUrl') ) return null;
    const { projectId, repoId } = project;
    if ( typeof projectId !== 'string' || ! UUID.test(projectId) ) return null;
    if ( typeof repoId !== 'string' || ! UUID.test(repoId) ) return null;
    return { label: LEGACY_WORK_LABEL, href: `${LEGACY_WORK_ORIGIN}/assignment/legacy-work/${projectId}/${repoId}` };
}
