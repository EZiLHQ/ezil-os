import assert from 'node:assert/strict';
import { REQUEST_ID } from './code-app-failure-mock.mjs';

export function assertFailureRecord(record, variant) {
  const keys = ['eventId', 'source', 'operation', 'category', 'code', 'stage', 'outcome', 'streamReason', 'cancellationSource',
    'clientRequestId', 'gatewayRequestId', 'vscodeRequestId', 'retryOfClientRequestId', 'attempt', 'retryable', 'durationMs', 'modelKey', 'httpStatus'];
  assert.ok(Object.keys(record).every(key => keys.includes(key)), 'Only contract fields');
  assert.equal(record.source, 'ezil_chat'); assert.equal(record.operation, 'chat_request');
  assert.equal(record.category, variant === 'missing_terminal' ? 'interrupted' : 'provider');
  assert.equal(record.code, variant === 'missing_terminal' ? 'stream_interrupted' : 'provider_error');
  assert.equal(record.stage, 'stream'); assert.equal(record.outcome, 'failed');
  if (variant === 'missing_terminal') assert.equal(record.streamReason, 'missing_terminal');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const key of ['eventId', 'clientRequestId', 'gatewayRequestId']) assert.match(record[key], uuid);
  assert.equal(record.gatewayRequestId, REQUEST_ID);
}
