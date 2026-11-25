// legacy-work-link.test.mjs — EZiL-authored. Run: node --test shell/ezil/apps/legacy-work-link.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_WORK_LABEL, legacyWorkLink } from './legacy-work-link.js';

const origin = 'https://os-staging.ezil.work';
const errorCode = 'repo_open_unsupported_provider';
const project = { projectId: '11111111-1111-4111-8111-111111111111', repoId: '22222222-2222-4222-8222-222222222222' };
const href = 'https://universe-staging.ezil.work/assignment/legacy-work/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';

test('a staging unsupported-provider refusal of a legacy two-id bookmark names only its two ids', () => {
    assert.deepEqual(legacyWorkLink({ origin, errorCode, project }), { label: LEGACY_WORK_LABEL, href });
    assert.equal(LEGACY_WORK_LABEL, 'Check this link in Universe');
});

test('a deep path in the bookmark never reaches the link', () => {
    assert.deepEqual(legacyWorkLink({ origin, errorCode, project: { ...project, path: 'src/secret.ts' } }), { label: LEGACY_WORK_LABEL, href });
});

test('production, other origins and a missing origin offer nothing', () => {
    for ( const other of ['https://os.ezil.work', 'https://os-prod.ezil.work', 'https://ezil.local', 'http://os-staging.ezil.work', undefined] )
        assert.equal(legacyWorkLink({ origin: other, errorCode, project }), null, String(other));
});

test('only the unsupported-provider refusal offers it', () => {
    for ( const other of ['project_not_authorized', 'identity_refresh_required', 'repo_open_failed', 'assignment_aws_unverified', undefined] )
        assert.equal(legacyWorkLink({ origin, errorCode: other, project }), null, String(other));
});

test('a repository address, a missing project and non-canonical ids offer nothing', () => {
    for ( const bad of [
        null, undefined, {}, { repoUrl: 'https://github.ezil.work/default/a.git' },
        { ...project, repoUrl: 'https://github.ezil.work/default/a.git' },
        { projectId: project.projectId }, { repoId: project.repoId },
        { projectId: 'AAAAAAAA-1111-4111-8111-111111111111', repoId: project.repoId },
        { projectId: project.projectId, repoId: '22222222-2222-4222-8222-22222222222' },
        { projectId: `${project.projectId}/..`, repoId: project.repoId },
        { ...project, projectId: project.projectId + '\n' },
        { projectId: 1, repoId: 2 },
    ] ) assert.equal(legacyWorkLink({ origin, errorCode, project: bad }), null, JSON.stringify(bad));
    assert.equal(legacyWorkLink(), null);
});

test('an id with a line break or other whitespace is not an exact UUID and offers nothing', () => {
    for ( const edge of ['\n', '\r\n', '\r', '\u2028', '\u2029', ' ', '\t'] ) {
        for ( const bad of [
            { ...project, projectId: project.projectId + edge }, { ...project, repoId: project.repoId + edge },
            { ...project, projectId: edge + project.projectId }, { ...project, repoId: edge + project.repoId },
        ] ) assert.equal(legacyWorkLink({ origin, errorCode, project: bad }), null, JSON.stringify(bad));
    }
});
