import { describe, expect, it } from 'vitest';
import { assignmentAuthority, productionAssignment, stageAssignment } from './authority';
import { privateMediaPost } from './private-ingress';

const production = {BILLING_FUNDING_URL:'https://ai.ezil.work', UNIVERSE_PROJECT_REPO_ORIGIN:'https://universe.ezil.work',
    EZIL_ASSIGNMENT_PRODUCTION_ENABLED:'1'};

describe('assignment service authority', () => {
    it('enables only the exact production pair with its explicit deployment switch', () => {
        expect(assignmentAuthority(production)).toBe(productionAssignment);
        for (const env of [{},{...production,EZIL_ASSIGNMENT_PRODUCTION_ENABLED:'0'}, {...production,EZIL_ASSIGNMENT_PRODUCTION_ENABLED:undefined},
            {...production,UNIVERSE_PROJECT_REPO_ORIGIN:stageAssignment.universe},{...production,BILLING_FUNDING_URL:'https://ai-staging.ezil.work'},
            {...production,UNIVERSE_PROJECT_REPO_ORIGIN:'https://example.com'}]) expect(assignmentAuthority(env)).toBeUndefined();
        expect(assignmentAuthority({BILLING_FUNDING_URL:'https://ai-staging.ezil.work',UNIVERSE_PROJECT_REPO_ORIGIN:stageAssignment.universe})).toBe(stageAssignment);
    });
    it('does not attach a private CA or phase token to any other server/path and refuses invalid certificate configuration', () => {
        const call = (url:string,pem='invalid') => privateMediaPost(url,'{}','fixture-only',pem,new AbortController().signal);
        for (const url of [stageAssignment.works, productionAssignment.universe, productionAssignment.works+'/unknown',productionAssignment.storage])
            expect(()=>call(url)).toThrow('destination');
        expect(()=>call(productionAssignment.works+'/universe/assignment-media/segments')).toThrow('CA');
    });
});
