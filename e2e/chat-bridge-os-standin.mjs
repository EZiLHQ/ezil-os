// In-container stand-in for the code host in e2e/chat-bridge-workbench.sh. It serves the ONE editor-bridge
// route the extension calls (POST /editor-bridge/v1/sync) with a scripted, in-memory copy of OS's protocol
// (owner/epoch, per-owner seq, one attempt id per handout, reports only for the current attempt), and passes
// every other path to the offline messages mock (/ai/v1). It is NOT OS: the real queue is
// app/src/server/agent-session/store.ts, proven against this same client by chain.pg.test.ts. This proves the
// real workbench, extension host, Copilot Chat session and ezil-models provider behind it.
//
// Script: an instruction into the still-empty chat as the window's first chat request; once the person has used
// the session, a send to it; once that completes, a slow send and, as soon as it runs, a cancel of it.
// GET /bridge-state returns everything observed.
// Usage: node chat-bridge-os-standin.mjs <port> <mock port> <bridge token> <ai token>
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const [port, mockPort, bridgeToken, aiToken] = process.argv.slice(2);
const state = { owner: null, epoch: 0, lastSeq: 0, syncs: 0, refused: [], sessions: [], ops: [], reports: [], used: new Set() };
const opOf = (role) => state.ops.find((o) => o.role === role);
const op = (kind, fields) => { const o = { id: randomUUID(), kind, status: 'queued', attemptId: null, ...fields }; state.ops.push(o); return o; };
const read = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

function script() {
  // The rest only into a session the person has already used and that is idle.
  const fresh = state.sessions.find((s) => s.open && !state.used.has(s.resource));
  if (process.env.EZIL_STANDIN_NEWCHAT) {
    // Experiment: once the person has used one chat, target a NEW, never-used chat they opened afterwards.
    if (fresh && state.used.size > 0 && !state.ops.some((o) => o.role === 'newchat')) {
      op('send', { role: 'newchat', sessionResource: fresh.resource, text: 'EZIL_BRIDGE_NEWCHAT into a fresh chat' });
    }
    return;
  }
  // First, an instruction into the brand-new chat before the person has sent anything: in a cold profile Copilot
  // Chat cannot be activated yet, so the editor must hold it (agent_not_ready) and run it only once chat is in use.
  if (fresh && !state.ops.some((o) => o.role === 'early')) op('send', { role: 'early', sessionResource: fresh.resource, text: 'EZIL_BRIDGE_EARLY as the first request in this window' });
  const [first, slow, cancel] = ['ping', 'slow', 'cancel'].map((role) => state.ops.find((o) => o.role === role));
  // The cancel does not wait for an idle session: its session is the one running the slow request.
  if (slow && slow.status === 'running' && !cancel) return void op('cancel', { role: 'cancel', sessionResource: slow.sessionResource, targetOperationId: slow.id });
  const open = state.sessions.find((s) => s.open && s.status === 'idle' && state.used.has(s.resource));
  if (!open || opOf('early')?.status !== 'completed') return;
  if (!first) op('send', { role: 'ping', sessionResource: open.resource, text: 'EZIL_BRIDGE_PING from the stand-in OS: please reply.' });
  else if (first.status === 'completed' && !slow) op('send', { role: 'slow', sessionResource: first.sessionResource, text: 'EZIL_E2E_SLOW EZIL_BRIDGE_CANCEL_ME' });
}

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/bridge-state') return json(res, 200, { ...state, used: [...state.used] });
  if (req.url.startsWith('/editor-bridge')) {
    const auth = req.headers.authorization ?? '';
    if (req.method !== 'POST' || req.url !== '/editor-bridge/v1/sync') return json(res, 404, { error: 'not_found' });
    if (auth !== `Bearer ${bridgeToken}`) {
      state.refused.push(auth === `Bearer ${aiToken}` ? 'ai_token' : 'other');
      return json(res, 401, { error: { code: 'os_bridge_unauthorized' } });
    }
    const body = JSON.parse((await read(req)).toString('utf8'));
    state.syncs += 1;
    if (state.owner && state.owner !== body.ownerId) return json(res, 200, { ok: true, protocol: 1, owner: 'other', pollMs: 5000 });
    if (state.owner === body.ownerId && body.seq <= state.lastSeq) return json(res, 409, { error: 'replayed_sync' });
    if (!state.owner) { state.owner = body.ownerId; state.epoch = 1; }
    state.lastSeq = body.seq;
    if (body.sessions) {
      state.sessions = body.sessions;
      // A session seen running (the person's own request), or already titled from it, has been used.
      for (const x of body.sessions) if (x.status === 'running' || (x.title && x.title !== 'New Chat')) state.used.add(x.resource);
    }
    for (const r of body.epoch === state.epoch ? body.reports ?? [] : []) {
      const o = state.ops.find((x) => x.id === r.operationId && x.attemptId === r.attemptId);
      state.reports.push({ ...r, applied: !!o, at: Date.now() });
      if (!o) continue;
      o.status = r.status === 'not_delivered' ? 'queued' : r.status;
      if (r.status === 'not_delivered') o.attemptId = null;
      if (r.responseText !== undefined) o.responseText = r.responseText;
      if (r.selectedModelId) o.selectedModelId = r.selectedModelId;
      if (r.mode) o.mode = r.mode;
    }
    script();
    const deliver = [];
    for (const o of state.ops.filter((x) => x.status === 'queued')) {
      o.status = 'delivered'; o.attemptId = randomUUID();
      deliver.push({ operationId: o.id, attemptId: o.attemptId, kind: o.kind, sessionResource: o.sessionResource, deliverWithinMs: 120000,
        ...(o.kind === 'send' ? { text: o.text } : { targetOperationId: o.targetOperationId }) });
    }
    return json(res, 200, { ok: true, protocol: 1, owner: 'self', epoch: state.epoch, leaseMs: 30000, pollMs: 1000, deliver, applied: 0 });
  }
  // Everything else is the messages mock's.
  const upstream = http.request({ host: '127.0.0.1', port: mockPort, path: req.url, method: req.method, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res);
  });
  upstream.on('error', () => json(res, 502, { error: 'mock_unreachable' }));
  req.pipe(upstream);
}).listen(Number(port), '127.0.0.1');
