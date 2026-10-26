import { createServer } from 'node:http';
import { openRepository } from './open.mjs';
// Private control port: never exposed by a browser preview route.
const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    if (req.method !== 'POST' || req.url !== '/open') { res.writeHead(404); return res.end('{}'); }
    try {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) throw new Error('repo_invalid_request'); }
        res.end(JSON.stringify(await openRepository(JSON.parse(raw))));
    } catch (error) {
        const allowed = ['repo_timeout', 'repo_recovery_required', 'repo_auth_required', 'repo_not_authorized', 'repo_invalid_request', 'repo_workspace_unavailable', 'repo_unsafe_destination', 'repo_cli_unavailable', 'repo_clone_failed', 'repo_invalid_result'];
        res.writeHead(409);
        res.end(JSON.stringify({ ok: false, error: allowed.includes(error.message) ? error.message : 'repo_open_failed' }));
    }
});
server.requestTimeout = 200000;
server.listen(9224, '0.0.0.0');
