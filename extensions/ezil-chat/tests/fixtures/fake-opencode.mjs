// Stand-in for `opencode serve`: honours --port/--hostname, requires the
// basic-auth password from the environment, answers /api/info, and can be
// told to crash so the manager's restart path is exercised.
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const hostname = args[args.indexOf('--hostname') + 1] ?? '127.0.0.1';
const expected = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD ?? ''}`).toString('base64')}`;
const version = process.env.FAKE_OPENCODE_VERSION ?? '2.0.19';
const startupDelay = Number(process.env.FAKE_OPENCODE_DELAY_MS ?? '0');
if (process.env.FAKE_OPENCODE_EXIT_IMMEDIATELY) process.exit(3);

const server = createServer((request, response) => {
    if (request.headers.authorization !== expected) {
        response.writeHead(401, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ type: 'Unauthorized', message: 'Authentication required' }));
    }
    if (request.url === '/api/info') {
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ version, pid: process.pid, urls: [`http://${hostname}:${port}`], paths: { tmp: '/tmp' }, config: process.env.OPENCODE_CONFIG ?? null, cwd: process.cwd() }));
    }
    if (request.url === '/crash') { response.end('bye'); setTimeout(() => process.exit(7), 10); return; }
    response.writeHead(404); response.end();
});
setTimeout(() => {
    server.listen(port, hostname, () => { console.log(`fake opencode listening on http://${hostname}:${port}`); });
}, startupDelay);
process.on('SIGTERM', () => { server.close(); process.exit(0); });
