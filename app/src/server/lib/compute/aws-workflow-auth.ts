import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { parseRebaseJson } from './aws-rebase-json';

/** Same signing string and headers as lifecycle authority; bound the body before parsing. */
export async function readWorkflowRequest(req: Request, path: string, secret: string, now: number): Promise<unknown> {
    const timestamp = req.headers.get('x-ezil-workflow-timestamp'), signature = req.headers.get('x-ezil-workflow-signature');
    if (req.method !== 'POST' || new URL(req.url).pathname !== path || !/^[a-f0-9]{64}$/.test(secret)
        || req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        || !timestamp || !/^(0|[1-9][0-9]*)$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))
        || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300 || !signature || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('workflow_refused');
    const reader = req.body?.getReader();
    if (!reader) throw new Error('workflow_refused');
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 4096) { await reader.cancel(); throw new Error('workflow_refused'); }
        chunks.push(value);
    }
    const body = Buffer.concat(chunks);
    const expected = createHmac('sha256', Buffer.from(secret, 'hex')).update(['ezil-lifecycle-authority-v1', 'POST', path, timestamp,
        createHash('sha256').update(body).digest('hex')].join('\n')).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('workflow_refused');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return parseRebaseJson(text, 4096);
}
