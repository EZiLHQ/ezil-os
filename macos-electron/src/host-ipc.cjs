'use strict';
const { exact, uuid, senderAllowed } = require('./policy.cjs');
const { browserSchema } = require('./browser.cjs');
function hostSchema(input) {
  exact(input, ['op', 'workspaceId', 'generation', 'sequence', ...(input?.op === 'browser' ? ['operation'] : [])]);
  if (!['browser', 'editor.start', 'editor.stop', 'editor.status'].includes(input.op)) throw Error('Operation');
  uuid(input.workspaceId);
  if (typeof input.generation !== 'string' || !Number.isSafeInteger(input.sequence) || input.sequence < 1) throw Error('Generation');
  if (input.op === 'browser') {
    browserSchema(input.operation);
    for (const key of ['workspaceId', 'generation', 'sequence']) if (input[key] !== input.operation[key]) throw Error('Browser owner');
  }
  return input;
}
function authorize(event, caller, host, input) {
  if (!caller || !host || caller.role !== 'desktop' || !senderAllowed(event, caller.wc, caller.url) || caller.workspaceId !== host.workspace.id || input.workspaceId !== caller.workspaceId || input.generation !== host.generation || input.generation !== caller.generation || input.sequence <= caller.sequence) throw Error('Untrusted or stale IPC');
  caller.sequence = input.sequence;
}
module.exports = { hostSchema, authorize };
