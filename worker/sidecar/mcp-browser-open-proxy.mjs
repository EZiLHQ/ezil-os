import { createServer, request } from 'node:http';
import { connect } from 'node:net';

/**
 * Context-local proxy. CDP guards navigation semantics; this also contains
 * requests started by subframes, workers and pages before they have a CDP
 * session. Chromium sends HTTPS as a CONNECT authority and loopback fixtures
 * as absolute HTTP URLs. The proxy serves only the approved origin.
 */
export async function createBrowserOpenProxy (target) {
    const sockets = new Set();
    const requests = new Set();
    const expectedAuthority = target.hostname + ':' + (target.port || '443');
    const server = createServer((incoming, response) => {
        let destination;
        try { destination = new URL(incoming.url); } catch { /* not an absolute target */ }
        if (target.protocol !== 'http:' || destination?.origin !== target.origin
            || destination.username || destination.password) {
            response.writeHead(403).end();
            return;
        }
        const headers = { ...incoming.headers, host: target.host };
        delete headers['proxy-authorization'];
        delete headers['proxy-connection'];
        const upstream = request({
            hostname: target.hostname,
            port: target.port,
            path: destination.pathname + destination.search,
            method: incoming.method,
            headers,
        }, result => {
            response.writeHead(result.statusCode || 502, result.headers);
            result.pipe(response);
        });
        requests.add(upstream);
        upstream.on('close', () => requests.delete(upstream));
        upstream.on('error', () => {
            if (!response.headersSent) response.writeHead(502);
            response.end();
        });
        response.once('close', () => upstream.destroy());
        incoming.pipe(upstream);
    });
    server.on('connection', track);
    server.on('connect', (incoming, client, head) => {
        if (target.protocol !== 'https:' || incoming.url?.toLowerCase() !== expectedAuthority) {
            client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return;
        }
        const upstream = connect({ host: target.hostname, port: Number(target.port || 443) });
        track(upstream);
        upstream.once('connect', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
        client.once('close', () => upstream.destroy());
        upstream.once('close', () => client.destroy());
    });
    // Plain HTTP WebSocket upgrades are outside the smoke operation. A
    // same-origin HTTPS WebSocket stays inside its authorized CONNECT tunnel.
    server.on('upgrade', (_incoming, socket) => socket.destroy());

    function track (socket) {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('error', () => socket.destroy());
    }

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    let closed = false;
    return {
        url: 'http://127.0.0.1:' + server.address().port,
        close () {
            if (closed) return;
            closed = true;
            for (const upstream of requests) upstream.destroy();
            for (const socket of sockets) socket.destroy();
            server.close();
        },
    };
}
