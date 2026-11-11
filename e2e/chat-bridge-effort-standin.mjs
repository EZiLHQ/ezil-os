// Local protocol3 OS stand-in + strict synthetic Responses Gateway; NOT actual OS/DB.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { validateResponseRequest, responseBody, effortRows } from './chat-bridge-effort-responses.mjs';

const [port, mockPort, bridgeToken, aiToken] = process.argv.slice(2);
const LEASE_MS = Number(process.env.EZIL_STANDIN_LEASE_MS ?? 30_000);
const t0 = Date.now();
const at = () => Date.now() - t0;
const state = {
  owner: null, epoch: 0, lastSeq: 0, leaseUntil: 0, syncs: [], owners: [], refused: [], protocols: {},
  catalog: null, catalogs: [], sessions: [], sessionsAt: null, ops: [], reports: [], upstream: [],
  gateway: { allow: (process.env.EZIL_STANDIN_ALLOW ?? '').split(',').filter(Boolean), mode: 'ok', calls: [] },
};

const read = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const FINAL = new Set(['completed', 'cancelled', 'finished_unverified', 'failed', 'rejected', 'expired', 'uncertain', 'applied', 'busy']);

function enqueue(spec) {
  const o = { id: randomUUID(), status: 'queued', attemptId: null, deliveredEpoch: null, attempts: 0, notBefore: 0, history: [], ...spec };
  state.ops.push(o);
  return o;
}

/** A session named by role resolves to the resource a create reported. */
function resourceOf(o) {
  if (o.sessionResource) return o.sessionResource;
  const made = state.ops.find((x) => x.role === o.sessionRole && x.kind === 'create');
  return made?.sessionResource ?? null;
}

function sync(body) {
  const now = Date.now();
  const live = state.owner && state.leaseUntil > now;
  if (live && state.owner !== body.ownerId) return { ok: true, protocol: body.protocol === 3 ? 3 : 2, supportedProtocols: [1,2,3], owner: 'other', pollMs: 5000 };
  const same = live && state.owner === body.ownerId;
  if (same && body.seq <= state.lastSeq) return null;
  if (!same) {
    // A new owner (or this one after its lease lapsed): a new epoch; what the old one held has an unknown outcome.
    state.epoch += 1;
    state.owner = body.ownerId;
    state.owners.push({ ownerId: body.ownerId, epoch: state.epoch, at: at() });
    for (const o of state.ops.filter((x) => x.status === 'delivered' || x.status === 'running' || x.status === 'cancel_requested')) {
      o.status = 'uncertain'; o.reason = 'owner_changed'; o.attemptId = null; o.history.push(['uncertain', 'owner_changed', at()]);
    }
  }
  state.lastSeq = body.seq;
  state.leaseUntil = now + LEASE_MS;
  state.protocols[body.protocol] = (state.protocols[body.protocol] ?? 0) + 1;
  if (body.sessions) { state.sessions = body.sessions; state.sessionsAt = at(); }
  if (body.catalog) { state.catalog = { ...body.catalog, at: at() }; state.catalogs.push(state.catalog); }
  const reports = same && body.epoch === state.epoch ? body.reports ?? [] : [];
  for (const r of reports) {
    const o = state.ops.find((x) => x.id === r.operationId && x.attemptId === r.attemptId);
    state.reports.push({ ...r, ownerId: body.ownerId, epoch: body.epoch, applied: !!o, at: at() });
    if (!o) continue;
    o.history.push([r.status, r.reason ?? null, at()]);
    // A lost-report double: drop the first final report once and hand the SAME operation out again.
    if (o.dupDeliver && !o.dupDone && FINAL.has(r.status === 'applied' ? 'applied' : r.status)) {
      o.dupDone = true; o.firstReport = r; o.status = 'queued'; o.attemptId = null; continue;
    }
    if (r.status === 'not_delivered') {
      // A configure is never queued: busy is its answer. Anything else goes back to the queue with a backoff.
      if (o.kind === 'configure' && r.reason === 'busy') { o.status = 'busy'; o.reason = 'busy'; o.attemptId = null; continue; }
      o.status = 'queued'; o.attemptId = null; o.reason = r.reason; o.notBefore = Date.now() + Math.min(30_000, 2_000 * o.attempts);
      continue;
    }
    o.status = r.status;
    o.reason = r.reason ?? null;
    for (const k of ['responseText', 'selectedModelId', 'mode', 'requestId', 'sessionResource', 'model', 'requestCount', 'observedAt', 'effort', 'selectedEffort']) if (r[k] !== undefined) o[k] = r[k];
  }
  const deliver = [];
  const busySessions = new Set(state.ops.filter((x) => x.kind === 'send' && ['delivered', 'running', 'cancel_requested'].includes(x.status)).map(resourceOf));
  for (const o of state.ops.filter((x) => x.status === 'queued' && x.notBefore <= now)) {
    const resource = o.kind === 'create' ? null : resourceOf(o);
    if (o.kind !== 'create' && !resource) continue;
    if (o.kind === 'send' && busySessions.has(resource)) continue;
    o.status = 'delivered'; o.attemptId = randomUUID(); o.deliveredEpoch = state.epoch; o.attempts += 1;
    if (o.kind === 'send') busySessions.add(resource);
    o.history.push(['delivered', o.attemptId, at()]);
    deliver.push({ operationId: o.id, attemptId: o.attemptId, kind: o.kind, deliverWithinMs: 120_000,
      ...(resource ? { sessionResource: resource } : {}),
      ...(o.text !== undefined ? { text: o.text } : {}), ...(o.model !== undefined && o.kind !== 'send' ? { model: o.model } : {}),
      ...(o.effort !== undefined ? { effort: o.effort } : {}),
      // OS created this session (a create op), so the editor may show its tab again to act on it.
      ...(o.sessionRole && o.kind !== 'create' ? { reveal: true } : {}),
      ...(o.kind === 'cancel' ? { targetOperationId: state.ops.find((x) => x.role === o.targetRole)?.id } : {}) });
  }
  return { ok: true, protocol: body.protocol === 3 ? 3 : 2, supportedProtocols: [1,2,3], owner: 'self', epoch: state.epoch, leaseMs: LEASE_MS, pollMs: 1000, deliver, applied: reports.length };
}

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/bridge-state') return json(res, 200, { ...state, now: at() });
  if (req.method === 'POST' && req.url === '/gateway-mode') {
    state.gateway.mode = JSON.parse((await read(req)).toString('utf8')).mode;
    return json(res, 200, { mode: state.gateway.mode, at: at() });
  }
  if (req.method === 'GET' && req.url === '/ai/v1/models') {
    const auth = req.headers.authorization ?? '';
    state.gateway.calls.push({ at: at(), token: auth === `Bearer ${aiToken}` ? 'this_computer' : auth === `Bearer ${bridgeToken}` ? 'bridge_token' : 'other', mode: state.gateway.mode });
    if (auth !== `Bearer ${aiToken}`) return json(res, 401, { error: { code: 'os_proxy_unauthorized' } });
    if (state.gateway.mode === 'fail') return json(res, 503, { error: { code: 'catalog_unavailable' } });
    return json(res, 200, { contract: 'ezil.gateway.models.v1', killswitch:false, pause:null, data:effortRows });
  }
  if (req.method === 'POST' && req.url === '/enqueue') {
    const spec = JSON.parse((await read(req)).toString('utf8'));
    return json(res, 200, enqueue({ ...spec, model: spec.kind === 'send' ? undefined : spec.model, createdAt: at() }));
  }
  if (req.url.startsWith('/editor-bridge')) {
    if (req.method !== 'POST' || req.url !== '/editor-bridge/v1/sync') return json(res, 404, { error: 'not_found' });
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${bridgeToken}`) {
      state.refused.push(auth === `Bearer ${aiToken}` ? 'ai_token' : 'other');
      return json(res, 401, { error: { code: 'os_bridge_unauthorized' } });
    }
    const body = JSON.parse((await read(req)).toString('utf8'));
    state.syncs.push({ ownerId: body.ownerId, seq: body.seq, protocol: body.protocol, reports: (body.reports ?? []).length, at: at() });
    if (state.syncs.length > 4000) state.syncs.splice(0, 1000);
    const reply = sync(body);
    return reply ? json(res, 200, reply) : json(res, 409, { error: 'replayed_sync' });
  }
  if (req.method !== 'POST' || req.url !== '/ai/v1/responses') return json(res,404,{error:{code:'unsupported_route'}});
  if (req.headers.authorization !== `Bearer ${aiToken}`) return json(res,401,{error:{code:'unauthorized'}});
  let body;
  try { body=JSON.parse((await read(req)).toString('utf8')); } catch { return json(res,400,{error:{code:'invalid_json'}}); }
  const verdict=validateResponseRequest(body,state.ops);
  if (!verdict.ok) { state.upstream.push({rejected:true,reason:verdict.reason}); return json(res,400,{error:{code:'invalid_request',message:verdict.reason}}); }
  // Only synthetic fixture request bodies. No headers or credentials are retained.
  state.upstream.push({body,marker:verdict.marker,model:body.model,effort:body.reasoning?.effort ?? null,at:at()});
  return json(res,200,responseBody(verdict.marker));
}).listen(Number(port), '127.0.0.1');
