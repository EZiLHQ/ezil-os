import { describe, expect, it, vi } from 'vitest';
import { initTRPC, TRPCError } from '@trpc/server';
const spies=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../trpc',()=>{
    const t=initTRPC.context<{user:{id:string}|null;db:unknown}>().create();
    return {createTRPCRouter:t.router,protectedProcedure:t.procedure.use(({ctx,next})=>{
        if(!ctx.user)throw new TRPCError({code:'UNAUTHORIZED'});
        return next({ctx:{...ctx,user:ctx.user}});
    })};
});
vi.mock('@/server/lib/cloudflare-guacamole-provider',async(importOriginal)=>{
    const actual=await importOriginal<Record<string,unknown>>();
    return {...actual,requestRelayRefresh:spies.request,resolveCloudflareGuacamoleConfig:()=>({isConfigured:true,workerUrl:'https://worker.example'})};
});
import { cloudflareGuacamoleRouter } from './cloudflare-guacamole';
const userId='11111111-1111-4111-8111-111111111111';
const computerId='22222222-2222-4222-8222-222222222222';
const runtimeId='a'.repeat(32);
describe('relay read and refresh ownership',()=>{
    it('rejects nonexistent, deleted or other-owner computer before forwarding',async()=>{
        spies.request.mockReset();
        const findFirst=vi.fn(async()=>undefined);
        const caller=cloudflareGuacamoleRouter.createCaller({user:{id:userId},db:{query:{computers:{findFirst}}}} as never);
        await expect(caller.relayState({computerId})).rejects.toMatchObject({code:'NOT_FOUND'});
        await expect(caller.refreshRelay({computerId,runtimeId})).rejects.toMatchObject({code:'NOT_FOUND'});
        expect(findFirst).toHaveBeenCalledTimes(2);
        expect(spies.request).not.toHaveBeenCalled();
    });
    it('forwards only the authenticated owner-derived sandbox and runtime fence',async()=>{
        spies.request.mockReset();spies.request.mockResolvedValue({ok:true,runtimeId,expiresAt:Date.now()+300000});
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET','test-only-secret');
        const caller=cloudflareGuacamoleRouter.createCaller({user:{id:userId},db:{query:{computers:{findFirst:async()=>({id:computerId})}}}} as never);
        try {
            await caller.relayState({computerId});await caller.refreshRelay({computerId,runtimeId});
            expect(spies.request).toHaveBeenCalledTimes(2);
            expect(spies.request.mock.calls[0]?.[2]).toMatch(/^guac-/);
            expect(spies.request.mock.calls[1]?.[2]).toBe(spies.request.mock.calls[0]?.[2]);
            expect(spies.request.mock.calls[1]?.[4]).toBe(runtimeId);
        } finally {vi.unstubAllEnvs()}
    });
});
