import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { expectedRepositoryURL } from '@/server/git/assignment-repository-name';
import { osActorHeaders } from './os-actor';

vi.mock('server-only',()=>({}));
const domain='ezil.universe.assignment.os-actor.v1',origin='https://universe.ezil.work';
const attempt='10000000-0000-4000-8000-000000000001';
const expiresAt=1800000000000,now=expiresAt-300000;
const actor={issuer:'https://id.ezil.work/',subject:'auth0|fixture',userId:'u',sessionId:'s',token:'fixture-token',expiresAt};
const secret='fixture-purpose-key-not-a-real-service-key';
const env={EZIL_ASSIGNMENT_PRODUCTION_ENABLED:'1',BILLING_FUNDING_URL:'https://ai.ezil.work',UNIVERSE_PROJECT_REPO_ORIGIN:origin,
    UNIVERSE_ASSIGNMENT_REPO_OPEN_SECRET:secret};
const path='/internal/assignment-repositories/enrollment';
const repo=expectedRepositoryURL(actor.subject,'a-'+attempt);
const json=(fields:Record<string,unknown>={})=>JSON.stringify({attemptId:attempt,userIdToken:actor.token,action:'prepare',...fields});
const encode=(text:string)=>osActorHeaders(actor,origin+path,attempt,text,now,env);

describe('OS authenticated assignment requests',()=>{
    it('signs every byte for the protected actor, attempt, origin and path; retries mint different nonces',()=>{
        const text=json(),a=encode(text),b=encode(text),nonce=a['X-Ezil-Assignment-Nonce'];
        expect(nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(b['X-Ezil-Assignment-Nonce']).not.toBe(nonce);
        const wire=[domain,String(now),nonce,'POST',origin,path,attempt,actor.issuer,actor.subject,text].join('\n');
        const key=createHmac('sha256',secret).update(domain).digest();
        expect(a).toEqual({'X-Ezil-Assignment-Actor':actor.subject,'X-Ezil-Assignment-Nonce':nonce,
            'X-Ezil-Assignment-Timestamp':String(now),'X-Ezil-Assignment-Signature':createHmac('sha256',key).update(wire).digest('hex')});
    });
    it('refuses absent keys, mismatched identity, foreign destinations and unrecognized actions before signing',()=>{
        for(const url of [origin+path+'?q=x','https://universe-staging.ezil.work'+path,'https://id.ezil.work'+path,origin+'/internal/other',
            origin+'.example'+path, origin+'@example.com'+path,origin+path+'/../enrollment'])
            expect(()=>osActorHeaders(actor,url,attempt,json(),now,env)).toThrow();
        for(const invalid of [{...actor,issuer:'https://other/'},{...actor,subject:'x\nheader'},{...actor,sessionId:''},{...actor,userId:''},{...actor,expiresAt:now}])
            expect(()=>osActorHeaders(invalid,origin+path,attempt,json(),now,env)).toThrow();
        for(const fields of [{attemptId:attempt.slice(0,-1)+'2'},{userIdToken:'different'},{action:'admin'},
            {action:'complete',repositoryUrl:repo.replace('github.ezil.work','foreign.example')}])
            expect(()=>encode(json(fields))).toThrow();
        for(const invalid of [{...env,UNIVERSE_ASSIGNMENT_REPO_OPEN_SECRET:''},{...env,EZIL_ASSIGNMENT_PRODUCTION_ENABLED:'0'}])
            expect(()=>osActorHeaders(actor,origin+path,attempt,json(),now,invalid)).toThrow();
    });
    it('signs only existing OS-owned service calls and checks session and canonical checkout',()=>{
        const media='/internal/assignment-video/';
        expect(()=>encode(json({action:'complete',repositoryUrl:repo}))).not.toThrow();
        for(const action of ['preflight','begin','status','checkpoint','finalize']){
            const text=json({osSessionId:actor.sessionId,repoOpen:{repositoryUrl:repo}});
            expect(osActorHeaders(actor,origin+media+action,attempt,text,now,env)['X-Ezil-Assignment-Actor']).toBe(actor.subject);
            expect(()=>osActorHeaders(actor,origin+media+action,attempt,json({osSessionId:'other'}),now,env)).toThrow();
        }
        expect(()=>osActorHeaders(actor,origin+media+'begin',attempt,json({osSessionId:actor.sessionId,repoOpen:{repositoryUrl:'different'}}),now,env)).toThrow();
    });
});
