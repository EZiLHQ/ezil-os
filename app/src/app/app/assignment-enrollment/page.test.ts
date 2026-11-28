import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({context:vi.fn(),headers:vi.fn(),enabled:vi.fn()}));
vi.mock('@/server/api/trpc',()=>({createTRPCContext:mocks.context}));
vi.mock('next/headers',()=>({headers:mocks.headers}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('not-found');},redirect:(url:string)=>{throw Error(url);}}));
vi.mock('@/server/git/assignment-enrollment',()=>({assignmentEnrollmentEnabled:mocks.enabled}));
import Page from './page';
const attempt='0a34112f-dfea-4a67-aa15-b9e3a214f266';
beforeEach(()=>{mocks.enabled.mockReturnValue(true);mocks.context.mockResolvedValue({user:null,delegation:null});
    mocks.headers.mockResolvedValue(new Headers({'sec-fetch-dest':'iframe'}));});
it('holds cold embedded enrollment on the OS origin while the Universe parent offers top-level sign-in',async()=>{
    expect(renderToStaticMarkup(await Page({searchParams:Promise.resolve({attempt})}))).toContain('<p role="status">Opening Code…</p>');
    await expect(Page({searchParams:Promise.resolve({attempt:'invalid'})})).rejects.toThrow('not-found');
});
it('keeps the normal authentication gate for a direct cold enrollment and refuses disabled deployment',async()=>{
    mocks.headers.mockResolvedValue(new Headers({'sec-fetch-dest':'document'}));
    await expect(Page({searchParams:Promise.resolve({attempt})})).rejects.toThrow('/login?');
    mocks.enabled.mockReturnValue(false);
    await expect(Page({searchParams:Promise.resolve({attempt})})).rejects.toThrow('not-found');
});
