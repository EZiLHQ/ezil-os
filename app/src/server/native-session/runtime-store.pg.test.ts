import { controlNativeRuntime } from './runtime-service';
import { runtimeRequestDigest } from './runtime-contract';
/** Disposable PostgreSQL only (`EZIL_PG_TEST_URL`); never imports the app DB or reads credentials. */
import { randomUUID } from 'node:crypto';
import { lookupRuntimeRequest, tombstoneBeforeDispatch, advanceRuntimeRequest, claimRuntimeDispatch } from './runtime-store';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { deriveControlKey } from '@/server/lib/compute/aws-enroll';
import { handleNativeRuntimeAuthorityQuery, RUNTIME_AUTHORITY_DOMAIN } from './runtime-authority-query';
import type { Placement } from '@/server/lib/compute/placement';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTableConfig } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { nativeSessionOperations } from '@/server/db/schema/native-sessions';
import { PLACEMENT_LOCK_NAMESPACE, PlacementIsolationError, type PlacementExecutor } from '@/server/lib/compute/placement';

import {
    NATIVE_OPERATION_LOCK_NAMESPACE, NATIVE_SESSION_LOCK_NAMESPACE, advanceNativeOperation, claimNativeOperation, lookupNativeOperation, nativeRequestDigest,
    readNativeSessionStatus, recheckNativeAuthority, type NativeAuthorityDb, type NativeCreateRequest, type NativeOperation,
} from './authority';

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `native_session_test_${randomUUID().replaceAll('-', '')}`;
const ROOT = path.resolve(__dirname, '../../../..');
const GENERATION = '3000000001'; // above int4: counters must stay bigint end to end
const LEASE_EPOCH = '4294967301';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe.skipIf(!PG)('native runtime cancel on disposable PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 12, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const production = client ? drizzle(client) : null;
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const textOf = (q: SQL): string => q.queryChunks.map(c => c instanceof StringChunk ? c.value.join('') : c instanceof SQL ? textOf(c) : '?').join('');
    type Hook = (statement: string) => Promise<void> | void;
    const executor = (db: Pick<NonNullable<typeof production>, 'execute'>, hook?: Hook): PlacementExecutor => ({
        execute: async q => { await hook?.(textOf(q)); return db.execute(scoped(q)); },
    });
    const authority = (hook?: Hook, config?: Parameters<NonNullable<typeof production>['transaction']>[1]): NativeAuthorityDb => ({
        execute: q => executor(production!, hook).execute(q),
        transaction: fn => production!.transaction(tx => fn(executor(tx, hook)), config),
    });
    const db = authority();
    const rows = (q: string, ...args: unknown[]) => client!.unsafe(local(q), args as never[]);

    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        // Supabase grants every new public table to anon/authenticated by default; the migration must revoke it.
        await client!.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated;
            ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO anon, authenticated;
            CREATE TABLE ${schema}.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, slot smallint NOT NULL DEFAULT 1,
                deleted_at timestamptz NULL)`);
        for (const file of ['docs/aws-computers/sql/0001_compute_placement.sql.txt', 'docs/aws-computers/sql/0002_image_rebase.sql.txt',
            'app/drizzle/0029_native_session_operations.sql', 'app/drizzle/0032_runtime_control.sql']) await client!.unsafe(local(readFileSync(path.join(ROOT, file), 'utf8')));
    });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });


    async function seed(expired = false, withRuntime = false) {
        const owner = randomUUID(), computer = randomUUID(), session = randomUUID(), lease = randomUUID(), a = randomUUID(), b = randomUUID(), fence = randomUUID();
        const runtime=withRuntime?randomUUID():null;
        await rows(`INSERT INTO public.ezil_computers(id,user_id) VALUES($1,$2)`, computer, owner);
        await rows(`INSERT INTO public.ezil_computer_placements(computer_id,owner_user_id,provider,workspace_store,generation,lease_epoch,state,
            instance_id,instance_type,volume_id,fence_token,lease_until,updated_at) VALUES($1,$2,'aws-ec2','ebs',7,3,'RUNNING',
            'i-0123456789abcdef0','m6i.large','vol-11111111111111111',$3,now()+interval '1 hour',now())`, computer,owner,fence);
        await rows(`INSERT INTO public.ezil_native_runtime_leases(control_authorization_id,owner_user_id,client_id,session_id,computer_id,
            runtime_id,host_epoch,placement_generation,placement_lease_epoch,placement_instance_id,placement_fence_token,profile,policy_digest,
            ai_authorization_id,action_set,prepared_request_id,lease_digest,state,consent_expires_at,control_deadline,decided_at,created_at,updated_at)
            VALUES($1,$2,'fixture-client',$3,$4,${runtime ? "'"+runtime+"'" : 'NULL'},${runtime ? "'"+'e'.repeat(32)+"'" : 'NULL'},7,3,'i-0123456789abcdef0',$5,'ezil-native-claude-v1',NULL,$6,'${withRuntime?'runtime':'cancel_only'}',$7,$8,
            'approved',now()+interval '${expired ? '-2 minutes' : '5 minutes'}',now()+interval '${expired ? '-1 minutes' : '10 minutes'}',now()-interval '4 minutes',now()-interval '5 minutes',now())`,
            lease,owner,session,computer,fence,randomUUID(),a,DIGEST);
        for (const [id,target] of [[a,b],[b,a]]) await rows(`INSERT INTO public.ezil_native_runtime_requests(owner_user_id,request_id,client_id,session_id,
            computer_id,kind,request_digest,target_request_id,control_authorization_id,request_deadline,state,effect,created_at,updated_at)
            VALUES($1,$2,'fixture-client',$3,$4,'cancel',$5,$6,$7,now()+interval '${expired ? '-1 minutes' : '10 minutes'}','approved','none',now(),now())`,
            owner,id,session,computer,runtimeRequestDigest({kind:'cancel',requestId:id!,sessionId:session,targetRequestId:target!}),target,lease);
        return {owner,computer,session,lease,a,b,runtime};
    }
    it('serializes reciprocal cancellation without deadlock or double completion', async () => {
        const s = await seed(), a = (await lookupRuntimeRequest(db,s.owner,s.a))!, b = (await lookupRuntimeRequest(db,s.owner,s.b))!;
        const result = await Promise.all([tombstoneBeforeDispatch(db,a.request),tombstoneBeforeDispatch(db,b.request)]);
        expect(result.filter(r=>r.kind==='tombstoned')).toHaveLength(1);
        expect(Number((await rows('SELECT count(*) AS n FROM public.ezil_native_runtime_tombstones WHERE owner_user_id=$1',s.owner))[0]!.n)).toBe(1);
    });
    it('expired lease writes no tombstone', async () => {
        const s=await seed(true), a=(await lookupRuntimeRequest(db,s.owner,s.a))!;
        const result=await tombstoneBeforeDispatch(db,a.request); expect(result.kind).toBe('refused');
        expect(Number((await rows('SELECT count(*) AS n FROM public.ezil_native_runtime_tombstones WHERE owner_user_id=$1',s.owner))[0]!.n)).toBe(0);
    });
    it('reassigned computer writes no tombstone', async () => {
        const s=await seed(), a=(await lookupRuntimeRequest(db,s.owner,s.a))!;
        await rows('UPDATE public.ezil_computers SET user_id=$1 WHERE id=$2',randomUUID(),s.computer);
        expect((await tombstoneBeforeDispatch(db,a.request)).kind).toBe('refused');
        expect(Number((await rows('SELECT count(*) AS n FROM public.ezil_native_runtime_tombstones WHERE owner_user_id=$1',s.owner))[0]!.n)).toBe(0);
    });
    it('persists actual claimed Core cancel tombstone without erasing dispatch evidence', async () => {
        const s=await seed();
        await rows("UPDATE public.ezil_native_runtime_requests SET state='dispatching',dispatch_claimed_at=now() WHERE owner_user_id=$1 AND request_id=$2",s.owner,s.a);
        const result=await advanceRuntimeRequest(db,s.owner,s.a,'dispatching','cancelled','tombstone_before_dispatch',null);
        expect(result?.request.effect).toBe('tombstone_before_dispatch');expect(result?.request.dispatchClaimedAt).not.toBeNull();
    });
    function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
    it('cancel lock wins before claim: claim waits and sends nothing after target tombstone', async () => {
        const s = await seed(), a = (await lookupRuntimeRequest(db, s.owner, s.a))!;
        const reached = deferred(), release = deferred();
        const cancelDb = authority(async text => { if (text.includes('native-runtime:target-operation')) { reached.resolve(); await release.promise; } });
        const cancelling = tombstoneBeforeDispatch(cancelDb, a.request);
        await reached.promise; // cancel holds the exact target request lock, before observing target state
        let claimed = false;
        const claiming = claimRuntimeDispatch(db, s.owner, s.b).then(value => { claimed = true; return value; });
        await new Promise(r => setTimeout(r, 30)); expect(claimed).toBe(false);
        release.resolve(); expect((await cancelling).kind).toBe('tombstoned'); expect(await claiming).toBeNull();
        expect((await lookupRuntimeRequest(db, s.owner, s.b))?.request.state).toBe('cancelled_before_dispatch');
    });
    it('claim lock wins before cancel: cancel observes dispatch_target and cannot report no-dispatch', async () => {
        const s = await seed(), a = (await lookupRuntimeRequest(db, s.owner, s.a))!;
        const reached = deferred(), release = deferred();
        const claimDb = authority(async text => { if (text.includes('native-runtime:claim */')) { reached.resolve(); await release.promise; } });
        const claiming = claimRuntimeDispatch(claimDb, s.owner, s.b);
        await reached.promise; // claim owns target lock, before its dispatch UPDATE
        let cancelled = false;
        const cancelling = tombstoneBeforeDispatch(db, a.request).then(value => { cancelled = true; return value; });
        await new Promise(r => setTimeout(r, 30)); expect(cancelled).toBe(false);
        release.resolve(); expect((await claiming)?.request.state).toBe('dispatching');
        expect((await cancelling).kind).toBe('dispatch_target');
        expect(Number((await rows('SELECT count(*) AS n FROM public.ezil_native_runtime_tombstones WHERE owner_user_id=$1', s.owner))[0]!.n)).toBe(0);
        expect((await lookupRuntimeRequest(db, s.owner, s.a))?.request.state).toBe('approved');
    });
    it('a failed target CAS never creates tombstone or completes cancel', async () => {
        const s = await seed(), a = (await lookupRuntimeRequest(db, s.owner, s.a))!;
        const raced = authority(async text => { if (text.includes('native-runtime:target-cancel')) {
            await rows("UPDATE public.ezil_native_runtime_requests SET state='blocked',reason='target_settled' WHERE owner_user_id=$1 AND request_id=$2", s.owner, s.b);
        } });
        expect((await tombstoneBeforeDispatch(raced, a.request)).kind).toBe('stale');
        expect(Number((await rows('SELECT count(*) AS n FROM public.ezil_native_runtime_tombstones WHERE owner_user_id=$1', s.owner))[0]!.n)).toBe(0);
        expect((await lookupRuntimeRequest(db, s.owner, s.a))?.request.state).toBe('approved');
    });

    it('produces an actual signed runtime full-scope READ reply larger than legacy1024 bytes', async () => {
        const s=await seed(), operation=randomUUID(), auth=randomUUID(), clientId='fixture-'+ 'c'.repeat(400);
        const initial=await claimNativeOperation(db,s.owner,{kind:'create',operationId:operation,sessionId:s.session,computerId:s.computer,
            instructionRevision:1,instructionDigest:DIGEST,taskRef:'task:runtime-reply'});
        expect(initial.kind).toBe('claimed');
        const p=(await rows('SELECT fence_token::text AS fence FROM public.ezil_computer_placements WHERE computer_id=$1',s.computer))[0]!;
        const deadline=new Date(Date.now()+9000).toISOString(), expires=new Date(Date.now()+10000).toISOString(), issued=new Date().toISOString();
        const aiExpires=new Date(Date.now()+300000).toISOString(), nonce='n'.repeat(43), secret='runtime-r2-isolated-fixture';
        const scope={authority:'read',ownerUserId:s.owner,originalOAuthClientId:clientId,sessionId:s.session,computerId:s.computer,runtimeId:null,hostEpoch:null,
            placement:{generation:'7',leaseEpoch:'3',instanceId:'i-0123456789abcdef0',fenceToken:p.fence},profile:'ezil-native-claude-v1',policyDigest:null,
            aiAuthorization:{authorizationId:auth,state:'inactive',expiresAt:aiExpires,policyDigest:null},controlAuthorizationId:null,controlDeadline:null};
        const rpc={v:'ezil-native-runtime-rpc/1',action:'read',scope,rootRequestId:null,requestDigest:null,deadline,payload:{action:'read',cursor:null,limit:1}};
        const ordered=(v:unknown):unknown=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,ordered(x)])):v;
        const requestRaw=JSON.stringify(ordered({v:1,requestNonce:nonce,issuedAt:issued,expiresAt:deadline,request:rpc}));
        const key=deriveControlKey(secret,{computerId:s.computer,generation:7,leaseEpoch:3,nonceHash:'a'.repeat(64)}), ts=String(Math.floor(Date.now()/1000));
        const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
        const signature='v1='+createHmac('sha256',key).update([RUNTIME_AUTHORITY_DOMAIN,ts,s.computer,'7','3',hash(requestRaw)].join('|')).digest('hex');
        const response=await handleNativeRuntimeAuthorityQuery(new Request('https://fixture.invalid/api',{method:'POST',body:requestRaw,headers:{
            'x-ezil-computer-id':s.computer,'x-ezil-generation':'7','x-ezil-lease-epoch':'3','x-ezil-timestamp':ts,'x-ezil-signature':signature}}),
            {env:{CLOUDFLARE_GUACAMOLE_HMAC_SECRET:secret},db,now:()=>new Date(),aiPort:{history:async()=>({authorizationId:auth,
                originalOAuthClientId:clientId,sessionId:s.session,computerId:s.computer,expiresAt:aiExpires,policyDigest:null}),active:async()=>null,revocation:async()=>null},
             placement:async()=>({provider:'aws-ec2',computerId:s.computer,generation:7,leaseEpoch:3,state:'RUNNING',enrollConsumedHash:'a'.repeat(64)} as Placement)});
        const reply=await response.text(); expect(response.status).toBe(200);expect(Buffer.byteLength(reply)).toBeGreaterThan(1024);
        expect(JSON.parse(reply).ok).toBe(true);
    });

    it('persists uncertain native delivery as dispatch_unknown and identical replay never resends', async () => {
        const s=await seed(false,true), a=(await lookupRuntimeRequest(db,s.owner,s.a))!;
        await claimRuntimeDispatch(db,s.owner,s.b); // target already crossed its outbox boundary
        const initial=await claimNativeOperation(db,s.owner,{kind:'create',operationId:randomUUID(),sessionId:s.session,computerId:s.computer,
            instructionRevision:1,instructionDigest:DIGEST,taskRef:'task:unknown'});
        expect(initial.kind).toBe('claimed');
        const ai={authorizationId:a.lease!.aiAuthorizationId,originalOAuthClientId:'fixture-client',sessionId:s.session,computerId:s.computer,
            expiresAt:new Date(Date.now()+300000).toISOString(),policyDigest:null};
        let calls=0;
        const deps={db,origin:'https://fixture.invalid',now:Date.now,aiPort:{history:async()=>ai,active:async()=>null,revocation:async()=>null},
            host:{available:true,call:async()=>{calls++;return {kind:'reply' as const,body:JSON.stringify({v:'ezil-native-runtime-rpc/1',outcome:'unknown',reason:'host_timeout'})};}}};
        const body={kind:'cancel' as const,requestId:s.a,sessionId:s.session,targetRequestId:s.b};
        const response=await controlNativeRuntime(deps,{userId:s.owner,clientId:'fixture-client'},body);
        expect(response.status).toBe(200);const stored=(await lookupRuntimeRequest(db,s.owner,s.a))!;
        expect(stored.request.state).toBe('dispatch_unknown');expect(stored.request.effect).toBe('unknown');
        expect(stored.request.dispatchClaimedAt).not.toBeNull();expect(calls).toBe(1);
        expect((await controlNativeRuntime(deps,{userId:s.owner,clientId:'fixture-client'},body)).status).toBe(200);
        expect(calls).toBe(1);expect((await lookupRuntimeRequest(db,s.owner,s.a))?.request.state).toBe('dispatch_unknown');
    });

});
