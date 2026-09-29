'use strict';
const { credential } = require('../src/broker.cjs');
const { WORKS_ORIGIN, GATEWAY_ORIGIN, WorksSession } = require('../src/works-session.cjs');
const accountId = '11111111-1111-4111-8111-111111111111';
const now = 1800000000000;
const grant = { accessToken: 'test.header.signature', refreshToken: 'synthetic-refresh-token', accountId, expiresIn: 3600, tokenType: 'bearer', role: 'builder' };
const session = { accessToken: grant.accessToken, refreshToken: grant.refreshToken, accountId, expiresAt: now + 3600000 };
const modelList = { object: 'list', killswitch: false, data: [
  { id: 'ezil-fast', enabled: true, max_input_tokens: 32768, max_output_tokens: 8192 },
  { id: 'ezil-code', enabled: true, max_input_tokens: 16384, max_output_tokens: 4096 }
] };
class MemoryVault {
  constructor(value = { provider: 'ezil', session }) { this.value = structuredClone(value); this.revision = 0; this.writes = []; }
  get() { return structuredClone(this.value); }
  set(value) { credential(value); this.value = structuredClone(value); this.revision++; this.writes.push(this.get()); }
  remove() { this.value = null; this.revision++; }
}
function fixture(override = () => undefined, vault = new MemoryVault()) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const result = await override(url, options);
    if (result !== undefined) return result;
    if (url === WORKS_ORIGIN + '/auth/signin' || url === WORKS_ORIGIN + '/auth/refresh') return Response.json(grant);
    if (url === WORKS_ORIGIN + '/v1/me') return Response.json({ accountId, role: 'builder', onboarded: true });
    if (url === GATEWAY_ORIGIN + '/v1/models') return Response.json(modelList);
    throw Error('Unexpected destination');
  };
  return { vault, calls, fetchImpl, works: new WorksSession(vault, { fetchImpl, now: () => now }) };
}
const event = (type, fields = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const complete = event('response.completed', { response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] } });
module.exports = { accountId, now, grant, session, modelList, MemoryVault, fixture, event, complete };
