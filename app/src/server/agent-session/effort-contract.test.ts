import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { handleEditorSync, signEditorSync } from './sync-route';
import { syncEditor, type SessionDb, type SqlExecutor, type EditorReport } from './store';
import { createSession, configureSession } from './control-store';
import { applyControlReport } from './control-sync';
vi.mock('./store', async importOriginal => ({...await importOriginal<typeof import('./store')>(),syncEditor:vi.fn()}));
const cid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', uid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const op='cccccccc-cccc-4ccc-8ccc-cccccccccccc', attempt='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const now=1800000000000, secret='synthetic-local-test-secret', sandbox='guac-bbbbbbbbbbbb4bbb-aaaaaaaaaaaa4aaa';
const db={execute:vi.fn(async()=>[{id:cid,user_id:uid}])} as unknown as SessionDb;
const head={ownerId:'test',epoch:1,seq:1}, session={resource:'vscode-chat-session://local/a',title:'',open:true,status:'idle'};
function request(body:unknown) {
    const bytes=new TextEncoder().encode(JSON.stringify(body)), timestamp=String(now/1000);
    return new Request('https://os.invalid/api/editor-bridge/v1/sync',{method:'POST',body:bytes,headers:{'content-type':'application/json','x-ezil-sandbox':sandbox,'x-ezil-timestamp':timestamp,'x-ezil-signature':signEditorSync(secret,timestamp,sandbox,bytes)}});
}
async function sync(body:unknown,effort='enabled') {return handleEditorSync(request(body),{db,secret,now:()=>now,enabled:'enabled',controls:'enabled',effort});}
beforeEach(()=>{vi.mocked(syncEditor).mockReset().mockResolvedValue({owner:'self',epoch:1,leaseMs:15000,pollMs:2000,deliver:[],applied:0});});
it('strict protocol1/2 reject effort fields; model-only protocol2 stays accepted',async()=>{
    expect((await sync({protocol:1,...head,sessions:[{...session,effort:'low'}]})).status).toBe(400);
    expect((await sync({protocol:2,...head,sessions:[{...session,model:'ezil/a',requests:0,effort:'low'}]})).status).toBe(400);
    expect(syncEditor).not.toHaveBeenCalled();
    const res=await sync({protocol:2,...head,sessions:[{...session,model:'ezil/a',requests:0}]});
    expect(res.status).toBe(200); expect(await res.json()).toMatchObject({protocol:2,supportedProtocols:[1,2,3]});
});
it('protocol3 bounds actual effort; separate gate controls negotiation and persistence',async()=>{
    const body={protocol:3,...head,sessions:[{...session,model:'ezil/a',requests:0,effort:'low'}]};
    expect((await sync(body)).status).toBe(200);
    expect(vi.mocked(syncEditor).mock.calls.at(-1)?.[3]).toEqual({controls:true,effort:true});
    const downgraded=await sync(body,''); expect(await downgraded.json()).toMatchObject({protocol:2});
    expect(vi.mocked(syncEditor).mock.calls.at(-1)?.[3]).toEqual({controls:true,effort:false});
    expect((await sync({...body,sessions:[{...body.sessions[0],effort:'x'.repeat(33)}]})).status).toBe(400);
});
it('invalid signature refuses before dispatch',async()=>{
    const req=request({protocol:3,...head});req.headers.set('x-ezil-signature','v1='+'0'.repeat(64));
    expect((await handleEditorSync(req,{db,secret,now:()=>now,enabled:'enabled'})).status).toBe(401);
    expect(syncEditor).not.toHaveBeenCalled();
});
it('requested effort cannot become effective without matching readback; old protocols refuse effort success',async()=>{
    for(const protocol3 of [false,true]) {
        const statements:{sql:string;params:unknown[]}[]=[], dialect=new PgDialect();
        const tx:SqlExecutor={execute:async query=>{
            const q=dialect.sqlToQuery(query);statements.push(q);
            return q.sql.includes('report-target') ? [{id:op,kind:'configure',status:'delivered',session_id:cid,requested_model:'ezil/a',requested_effort:'high'}] : [];
        }};
        const report:EditorReport={operationId:op,attemptId:attempt,status:'applied',model:'ezil/a',effort:'low'};
        expect(await applyControlReport(tx,{id:cid,userId:uid},1,sql`clock_timestamp()`,report,protocol3)).toBe(true);
        expect(statements.at(-1)?.sql).toContain("status='uncertain'");
        expect(statements.some(q=>q.sql.includes('session-model'))).toBe(false);
        expect(statements[0]?.params).toContain(attempt);
        expect(await applyControlReport({execute:async()=>[]},{id:cid,userId:uid},1,sql`clock_timestamp()`,report,protocol3)).toBe(false);
    }
});

afterEach(() => vi.unstubAllEnvs());
it.each(['', 'disabled', 'true'])('effort gate %s rejects before any DB access, regardless of identity or resource', async gate => {
    vi.stubEnv('EZIL_EDITOR_BRIDGE_EFFORT', gate);
    const transaction = vi.fn(() => { throw new Error('must not touch database'); });
    const execute = vi.fn(() => { throw new Error('must not touch database'); });
    const neverDb = {transaction, execute} as unknown as SessionDb;
    for (const userId of [uid, cid]) {
        const caller = {userId, clientId:'synthetic-client'};
        await expect(createSession(neverDb, caller, {computerId:cid, effort:'high', idempotencyKey:op})).rejects.toMatchObject({code:'BAD_REQUEST', reason:'effort_not_per_session'});
        await expect(configureSession(neverDb, caller, {sessionId:cid, effort:'high', idempotencyKey:op})).rejects.toMatchObject({code:'BAD_REQUEST', reason:'effort_not_per_session'});
    }
    expect(transaction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
});
