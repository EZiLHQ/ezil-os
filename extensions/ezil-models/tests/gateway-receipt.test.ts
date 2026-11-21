import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import type { InferenceDiagnostic } from '../src/inference-diagnostics';
import { beginGatewayReceipt, conversationFingerprint } from '../src/gateway-receipt';

test('only new completed foreground requests for the same editor session appear in its receipt', () => {
    const secret = randomBytes(32), session = randomUUID(), operation = randomUUID(), editor = 'request_' + randomUUID();
    const resource = 'vscode-chat-session://local/' + Buffer.from(session).toString('base64url');
    const hash = conversationFingerprint(secret, session);
    const item = (conversationId: string | null, gatewayRequestId: string, outcome = 'completed') =>
        ({ conversationId, gatewayRequestId, outcome } as InferenceDiagnostic);
    const trace = [item(hash, 'prior')], lines: string[] = [];
    const close = beginGatewayReceipt(secret, operation, resource, () => trace, line => lines.push(line))!;
    trace.push(item(hash, 'fresh'), item(hash, 'fresh'), item(null, 'utility'), item(hash, 'failed-call', 'failed'),
        item(conversationFingerprint(secret, randomUUID()), 'other-chat'));
    close(editor);
    expect(lines).toEqual(['[ezil.code.gateway-receipt.v1] ' + JSON.stringify({operationId: operation,
        editorRequestId: editor, conversationFingerprint: hash, gatewayRequestId: 'fresh'})]);
    expect(beginGatewayReceipt(secret, operation, 'https://invalid', () => trace, () => {})).toBeUndefined();
    expect(beginGatewayReceipt(secret, 'invalid', resource, () => trace, () => {})).toBeUndefined();
});
