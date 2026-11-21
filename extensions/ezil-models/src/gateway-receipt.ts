import { createHmac } from 'node:crypto';
import type { InferenceDiagnostic } from './inference-diagnostics';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const localSession = /^vscode-chat-session:\/\/local\/([A-Za-z0-9_-]{48})$/;
export function conversationFingerprint(secret: Buffer, sessionId: string): string {
    return createHmac('sha256', secret).update(JSON.stringify(['session', sessionId])).digest('hex');
}

/** Code encodes its local chat UUID in the URI. Copilot passes that UUID to the Gateway provider on foreground calls. */
export function beginGatewayReceipt(secret: Buffer, operationId: string, sessionResource: string,
    snapshot: () => InferenceDiagnostic[], emit: (line: string) => void): ((requestId: string) => void) | undefined {
    const match = localSession.exec(sessionResource);
    if (!match || !uuid.test(operationId)) return;
    const sessionId = Buffer.from(match[1]!, 'base64url').toString('utf8');
    if (!uuid.test(sessionId) || Buffer.from(sessionId).toString('base64url') !== match[1]) return;
    const conversation = conversationFingerprint(secret, sessionId);
    const matching = () => snapshot().filter(row => row.conversationId === conversation && row.outcome === 'completed'
        && row.gatewayRequestId !== null && /^[a-zA-Z0-9_-]{1,128}$/.test(row.gatewayRequestId));
    const before = new Set(matching().map(row => row.gatewayRequestId));
    return requestId => {
        if (!requestId.startsWith('request_') || !uuid.test(requestId.slice(8))) return;
        const ids = new Set(matching().map(row => row.gatewayRequestId!).filter(id => !before.has(id)));
        for (const gatewayRequestId of ids) {
            emit('[ezil.code.gateway-receipt.v1] ' + JSON.stringify({ operationId, editorRequestId: requestId,
                conversationFingerprint: conversation, gatewayRequestId }));
        }
    };
}
