import { describe, expect, it } from 'vitest';

import {
    adminAuthzOf, adminEvents, adminFinish, adminGet, adminRegister, adminStart, canonicalGitQaUrl,
    consentAccept, consentStatus, eventsBatch, type HandlerResult,
} from './service';
import type { InterviewDb } from './store';

/** Any access is a bug for a refused request: these handlers must decide before touching the database. */
const UNTOUCHED: InterviewDb = {
    execute: () => { throw new Error('DB touched'); },
    transaction: () => { throw new Error('DB touched'); },
};
const code = (r: HandlerResult) => (r.body as { error?: { code?: string } }).error?.code;
const now = () => '2026-11-22T09:06:00.000Z';
const subject = async () => 'auth0|abc';
const ID = '7c1f3f0e-5b8a-4c2d-9e41-0a6b2d9f8e13';

describe('A6: a closed staging gate is 404 not_found for every interview route, before any DB access', () => {
    it.each([
        ['consent status', () => consentStatus(UNTOUCHED, { gateOn: false, osUserId: 'u', subject, url: 'https://git-qa.ezil.work/a/b.git' })],
        ['consent accept', () => consentAccept(UNTOUCHED, { gateOn: false, osUserId: 'u', subject, interviewId: ID, noticeVersion: 1, noticeSha256: 'x', now })],
        ['events', () => eventsBatch(UNTOUCHED, { gateOn: false, osUserId: 'u', interviewId: ID, events: [], now })],
        ['admin register', () => adminRegister(UNTOUCHED, { gateOn: false, authz: 'ok', body: {} })],
        ['admin get', () => adminGet(UNTOUCHED, { gateOn: false, authz: 'ok', interviewId: ID })],
        ['admin start', () => adminStart(UNTOUCHED, { gateOn: false, authz: 'ok', interviewId: ID, now })],
        ['admin finish', () => adminFinish(UNTOUCHED, { gateOn: false, authz: 'ok', interviewId: ID, now })],
        ['admin events', () => adminEvents(UNTOUCHED, { gateOn: false, authz: 'ok', interviewId: ID })],
    ])('%s -> 404 not_found', async (_label, run) => {
        const result = await run();
        expect(result.status).toBe(404);
        expect(code(result)).toBe('not_found');
    });
});

describe('shell auth: a signed-out candidate is 401 (gate on), before any DB access', () => {
    it('consent status / accept / events all 401 UNAUTHORIZED when osUserId is null', async () => {
        for (const run of [
            () => consentStatus(UNTOUCHED, { gateOn: true, osUserId: null, subject, url: 'https://git-qa.ezil.work/a/b.git' }),
            () => consentAccept(UNTOUCHED, { gateOn: true, osUserId: null, subject, interviewId: ID, noticeVersion: 1, noticeSha256: 'x', now }),
            () => eventsBatch(UNTOUCHED, { gateOn: true, osUserId: null, interviewId: ID, events: [], now }),
        ]) {
            const result = await run();
            expect(result.status).toBe(401);
            expect(code(result)).toBe('UNAUTHORIZED');
        }
    });
});

describe('admin auth: 401 absent, 403 not a telemetry admin (gate on), before any DB access', () => {
    it('unauthorized -> 401, forbidden -> 403 across admin routes', async () => {
        expect((await adminGet(UNTOUCHED, { gateOn: true, authz: 'unauthorized', interviewId: ID })).status).toBe(401);
        expect(code(await adminStart(UNTOUCHED, { gateOn: true, authz: 'unauthorized', interviewId: ID, now }))).toBe('unauthorized');
        expect((await adminFinish(UNTOUCHED, { gateOn: true, authz: 'forbidden', interviewId: ID, now })).status).toBe(403);
        expect(code(await adminEvents(UNTOUCHED, { gateOn: true, authz: 'forbidden', interviewId: ID }))).toBe('forbidden');
        expect(code(await adminRegister(UNTOUCHED, { gateOn: true, authz: 'forbidden', body: {} }))).toBe('forbidden');
    });

    it('positive control: UNTOUCHED really throws once a request is allowed to reach the DB', async () => {
        // gate on, authz ok, well-formed id -> the handler reaches the store, which is the throwing db.
        await expect(adminGet(UNTOUCHED, { gateOn: true, authz: 'ok', interviewId: ID })).rejects.toThrow('DB touched');
    });

    it('adminAuthzOf reuses the telemetry-admin gate', () => {
        expect(adminAuthzOf(null, 'a@x.io')).toBe('unauthorized');
        expect(adminAuthzOf({ email: 'a@x.io' }, 'a@x.io,b@x.io')).toBe('ok');
        expect(adminAuthzOf({ email: 'c@x.io' }, 'a@x.io')).toBe('forbidden');
        expect(adminAuthzOf({ email: 'a@x.io' }, undefined)).toBe('forbidden');
    });
});

describe('canonicalGitQaUrl normalizes exactly the git-qa remotes', () => {
    it('canonicalizes case, optional .git and trailing slash', () => {
        expect(canonicalGitQaUrl('https://git-qa.ezil.work/Candidate-A/Interview-1121.git')).toBe('https://git-qa.ezil.work/candidate-a/interview-1121.git');
        expect(canonicalGitQaUrl('https://git-qa.ezil.work/candidate-a/interview-1121')).toBe('https://git-qa.ezil.work/candidate-a/interview-1121.git');
        expect(canonicalGitQaUrl('https://git-qa.ezil.work/candidate-a/interview-1121/')).toBe('https://git-qa.ezil.work/candidate-a/interview-1121.git');
    });
    it('rejects any other host, scheme, or shape', () => {
        expect(canonicalGitQaUrl('https://github.com/a/b.git')).toBeNull();
        expect(canonicalGitQaUrl('http://git-qa.ezil.work/a/b.git')).toBeNull();
        expect(canonicalGitQaUrl('https://git-qa.ezil.work/a/b?x=1')).toBeNull();
        expect(canonicalGitQaUrl('https://git-qa.ezil.work/a')).toBeNull();
        expect(canonicalGitQaUrl(42)).toBeNull();
    });
});

describe('E5: admin register refuses a non-canonical canonicalURL (400 invalid_request), never normalises', () => {
    const base = { interviewId: ID, repositoryId: '4211', handle: 'candidate-a', ownerEzilIdSubject: 'auth0|abc', worksAccountId: '1187' };
    // UNTOUCHED throws on any DB access, so a 400 that returns (rather than throws) proves the refusal is pre-DB.
    const register = (canonicalURL: unknown) => adminRegister(UNTOUCHED, { gateOn: true, authz: 'ok', body: { ...base, canonicalURL } });
    it.each([
        ['uppercase owner/name', 'https://git-qa.ezil.work/Candidate-A/Interview-1121.git'],
        ['trailing slash', 'https://git-qa.ezil.work/candidate-a/interview-1121.git/'],
        ['missing .git', 'https://git-qa.ezil.work/candidate-a/interview-1121'],
        ['no .git with trailing slash', 'https://git-qa.ezil.work/candidate-a/interview-1121/'],
        ['explicit :443', 'https://git-qa.ezil.work:443/candidate-a/interview-1121.git'],
        ['foreign host', 'https://github.com/candidate-a/interview-1121.git'],
        ['not a string', 42],
    ])('%s -> 400 invalid_request, DB untouched', async (_label, url) => {
        const result = await register(url);
        expect(result.status).toBe(400);
        expect(code(result)).toBe('invalid_request');
    });
    it('positive control: the exact canonical form os-access produces passes validation and reaches the DB', async () => {
        await expect(register('https://git-qa.ezil.work/candidate-a/interview-1121.git')).rejects.toThrow('DB touched');
    });
});
