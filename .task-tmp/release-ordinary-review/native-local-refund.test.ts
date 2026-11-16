import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import postgres from '/dev/shm/ezil-unified-20261026/os-credits/app/node_modules/postgres/src/index.js';
import {drizzle} from '/dev/shm/ezil-unified-20261026/os-credits/app/node_modules/drizzle-orm/postgres-js/index.js';
import {eq} from '/dev/shm/ezil-unified-20261026/os-credits/app/node_modules/drizzle-orm/index.js';
import * as schema from '/dev/shm/ezil-unified-20261026/os-credits/app/src/server/db/schema/index.ts';
import {createBillingStore} from '/dev/shm/ezil-unified-20261026/os-credits/app/src/server/billing/store.ts';
import {aiCreditEntitlement,aiCreditOutboxItem,hasAiReversals} from '/dev/shm/ezil-unified-20261026/os-credits/app/src/server/billing/ai-credits.ts';
describe('independent ordinary native local refund deltas',()=>{
 it.each([false,true])('retains zero audit and separate paid allowance after prior earned restore=%s',async earned=>{
  const c=postgres(process.env.BILLING_TEST_DATABASE_URL!,{max:1,prepare:false,connect_timeout:3});
  expect(c.options.path).toBe(process.env.PGHOST+'/.s.PGSQL.5432');
  const base=drizzle(c,{schema});const rollback=Symbol('rollback');
  try {await base.transaction(async tx=>{
   const uid=randomUUID(),sub='sub_'+uid;const start=new Date('2026-10-01Z'),end=new Date('2026-11-01Z');
   await tx.insert(schema.authUsers).values({id:uid});
   const st=createBillingStore(tx as any);if(!hasAiReversals(st))throw Error('missing reversal port');
   await st.linkCustomer(uid,'cus_'+uid);
   await st.insertGrant({userId:uid,subscriptionId:sub,meter:'compute_std_seconds',kind:'plan_period',amount:144000n,periodStart:start,periodEnd:end,sourceType:'invoice',sourceId:'in_'+uid});
   const root=aiCreditOutboxItem(uid,aiCreditEntitlement({userId:uid,sku:'standard_monthly_v3',subscriptionId:sub,periodStart:start,periodEnd:end,invoiceId:'in_'+uid}),'grant','in_'+uid);
   root.payload.accountPublicId='payer_'+uid;await st.enqueueOutbox(root);
   const originals=await st.grantsBySource('invoice','in_'+uid);
   const input={action:'suspend' as const,userId:uid,customerId:'cus_'+uid,chargeId:'ch_'+uid,causeId:'dp_1_'+uid,originals,receipts:[root]};
   expect(await st.recordAiReversal(input)).toBe('applied');
   if(earned){
    expect(await st.recordAiReversal({...input,action:'restore'})).toBe('applied');
    const rr=(await tx.select().from(schema.billingOutbox).where(eq(schema.billingOutbox.eventKey,root.payload.entitlementId+':restore:'+input.causeId)))[0]!;
    await tx.update(schema.billingOutbox).set({deliveredAt:new Date(),payload:{...rr.payload,delivery:{status:'done',outcome:'restored'}}}).where(eq(schema.billingOutbox.id,rr.id));
    expect(await st.recordAiReversal({...input,causeId:'dp_2_'+uid})).toBe('applied');
   }
   await st.insertGrant({userId:uid,subscriptionId:sub,meter:'compute_std_seconds',kind:'upgrade_prorated',amount:100000n,periodStart:start,periodEnd:end,sourceType:'invoice',sourceId:'in_upgrade_'+uid});
   const refund={...input,action:'revoke' as const,causeId:'re_'+uid};
   expect(await st.recordAiReversal(refund)).toBe('applied');
   let gs=await tx.select().from(schema.billingGrants).where(eq(schema.billingGrants.userId,uid));
   expect(gs.find(g=>g.sourceType==='refund')?.amount).toBe(0n);
   expect(gs.reduce((s,g)=>s+g.amount,0n)).toBe(100000n);
   const terminal=(await tx.select().from(schema.billingOutbox).where(eq(schema.billingOutbox.eventKey,root.payload.entitlementId+':revoke:refund:'+refund.causeId)))[0]!;
   expect(terminal.kind).toBe('ai_revoke');expect(terminal.payload.credits).toBe(4000);
   const before=gs.length;expect(await st.recordAiReversal(refund)).toBe('applied');
   gs=await tx.select().from(schema.billingGrants).where(eq(schema.billingGrants.userId,uid));expect(gs.length).toBe(before);
   expect(await st.recordAiReversal({...input,action:'restore',causeId:earned?'dp_2_'+uid:input.causeId})).toBe('review:restore_refused_terminal');
   throw rollback;
  });}catch(e){if(e!==rollback)throw e;}finally{await c.end({timeout:1});}
 });
});
