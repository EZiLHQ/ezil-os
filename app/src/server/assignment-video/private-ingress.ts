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
    // Compose raw env files keep the renderer's backslash-newline encoding literal.
    const decoded = pem.replaceAll('\r\n', '\n').replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n');
    if (pem.length > 16384 || !/^-----BEGIN CERTIFICATE-----\n[a-zA-Z0-9+/=\n]+\n-----END CERTIFICATE-----\n?$/.test(decoded))
        throw new Error('Invalid assignment ingress CA');
    const certificate = new X509Certificate(decoded);
    if (!certificate.ca) throw new Error('Invalid assignment ingress CA');
    return new Promise((resolve, reject) => {
        const outgoing = request(url, {
            method:'POST', signal, agent:false, rejectUnauthorized:true, ca:[...rootCertificates,certificate.toString()],
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
