// Exercise the existing mock HTTP handlers without opening a socket.
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';

export function memoryFetch(server: Server): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        const url = new URL(String(input));
        const req = Object.assign(new EventEmitter(), { url: url.pathname + url.search, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers)) });
        let status = 200;
        let headers: Record<string, string> = {};
        let body = '';
        return await new Promise<Response>((resolve, reject) => {
            const res = { writeHead(code: number, values: Record<string, string>) { status = code; headers = values; },
                write(chunk: string) { body += chunk; }, end(chunk = '') { resolve(new Response(body + chunk, { status, headers })); } };
            try {
                server.emit('request', req, res);
                req.emit('data', init?.body ?? '');
                req.emit('end');
            } catch (error) { reject(error); }
        });
    }) as typeof fetch;
}
