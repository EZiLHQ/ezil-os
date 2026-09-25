import { createConnection, createServer, isIPv4, type Socket } from 'node:net';

/** The caller supplies a provider-observed address from the installation's
 * internal network, never a client URL. Only host loopback is exposed. This
 * TCP forwarding preserves HTTP and WebSockets; browser authorization belongs
 * to the separate tunnel/router, not to an unauthenticated public listener. */
export async function createServiceProxy(hostPort: number, address: string, internalPort: number, active: () => boolean) {
    if (!isIPv4(address) || !Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535
        || !Number.isInteger(internalPort) || internalPort < 1024 || internalPort > 65535) {
        throw new Error('invalid_service_mapping');
    }
    const authorized = () => { try { return active(); } catch { return false; } };
    const sockets = new Set<Socket>();
    const server = createServer(client => {
        if (!authorized() || sockets.size >= 128) { client.destroy(); return; }
        sockets.add(client);
        const upstream = createConnection({ host: address, port: internalPort });
        sockets.add(upstream);
        const close = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
        const connecting = setTimeout(close, 5000);
        upstream.once('connect', () => clearTimeout(connecting));
        for (const socket of [client, upstream]) {
            socket.on('error', close);
            socket.once('close', () => { clearTimeout(connecting); close(); });
        }
        client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', () => reject(new Error('service_port_unavailable')));
        server.listen({ host: '127.0.0.1', port: hostPort, exclusive: true }, resolve);
    });
    // A revoked generation or elapsed deadline also severs already-open
    // WebSockets, rather than checking authority only on TCP connection.
    const revocations = setInterval(() => {
        if (!authorized()) for (const socket of sockets) socket.destroy();
    }, 250);
    revocations.unref();
    return { close: async () => {
        clearInterval(revocations);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(new Error('service_proxy_close_failed')) : resolve()));
    } };
}
