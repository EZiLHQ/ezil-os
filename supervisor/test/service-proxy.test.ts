import assert from 'node:assert/strict';
import { createServer, createConnection, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { createServiceProxy } from '../src/service-proxy.js';

test('real TCP proxy preserves bytes, refuses occupied ports, and closes live connections on revocation', async () => {
    const upstream = createServer(socket => socket.pipe(socket));
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const hostPort = (reservation.address() as AddressInfo).port;
    const internalPort = (upstream.address() as AddressInfo).port;
    await assert.rejects(createServiceProxy(hostPort, '127.0.0.1', internalPort, () => true), /service_port_unavailable/);
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    let active = true;
    const proxy = await createServiceProxy(hostPort, '127.0.0.1', internalPort, () => active);
    const socket = createConnection(hostPort, '127.0.0.1');
    try {
        await once(socket, 'connect');
        const received = once(socket, 'data');
        socket.write('request-bytes');
        assert.equal((await received)[0].toString(), 'request-bytes');
        const closed = once(socket, 'close');
        active = false;
        await closed;
    } finally {
        socket.destroy();
        await proxy.close();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
});
