import { X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { rootCertificates } from 'node:tls';

import { productionAssignment } from './authority';

const segmentPath = '/universe/assignment-media/segments';
const maxBytes = 262_144;

/** Optional extra public CA for the dedicated production media ingress only. */
export function privateMediaPost(url: string, body: string, capability: string, pem: string, signal: AbortSignal): Promise<Response> {
    if (url !== productionAssignment.works + segmentPath && url !== productionAssignment.works + segmentPath + '/confirm')
        throw new Error('Invalid assignment media destination');
    if (pem.length > 16384 || !/^-----BEGIN CERTIFICATE-----[a-zA-Z0-9+/=\s]+-----END CERTIFICATE-----$/.test(pem.trim())
        || !new X509Certificate(pem).ca) throw new Error('Invalid assignment ingress CA');
    return new Promise((resolve, reject) => {
        const outgoing = request(url, {
            method:'POST', signal, agent:false, rejectUnauthorized:true, ca:[...rootCertificates,pem],
            headers:{'content-type':'application/json', accept:'application/json', authorization:'Bearer ' + capability},
        }, response => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('error',reject);
            response.on('data',(chunk:Buffer) => {
                size += chunk.length;
                if (size > maxBytes) { outgoing.destroy(new Error('Media response too large')); return; }
                chunks.push(chunk);
            });
            response.on('end',() => {
                const status = response.statusCode ?? 502;
                resolve(new Response(chunks.length ? new Uint8Array(Buffer.concat(chunks)) : null,
                    {status,headers:{'content-type':response.headers['content-type'] ?? ''}}));
            });
        });
        outgoing.on('error',reject);
        outgoing.end(body);
    });
}
