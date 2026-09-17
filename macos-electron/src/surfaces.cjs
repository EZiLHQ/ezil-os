'use strict';
const { surfaceSchema, senderAllowed } = require('./policy.cjs');
// The shell gets a fixed result only, including on unexpected launch failures.
async function operation(event, raw, caller, activeID, open) {
  try {
    if (!caller || caller.role !== 'desktop' || !senderAllowed(event, caller.wc, caller.url)) throw Error('Sender');
    const input = surfaceSchema(raw);
    if (input.workspaceId !== activeID) throw Error('Workspace');
    if (await open(input) !== true) throw Error('Unavailable');
    return { ok: true, state: 'opened' };
  } catch { return { ok: false, state: 'unavailable' }; }
}
module.exports = { operation };
