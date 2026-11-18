import React from 'react';
import { gatewayLink, tokenValue, type TraceRow } from '@/server/ai-traces/admin';
export function TraceTable({ rows, gatewayOrigin }: { rows: TraceRow[]; gatewayOrigin?: string }) {
    return <table><thead><tr>{['Received (UTC)', 'User / model', 'Input / output', 'Cache read / write', 'Tools requested', 'Results', 'Detail'].map(t => <th key={t}>{t}</th>)}</tr></thead>
        <tbody>{rows.map(({ userId, receivedAt, trace: t }) => {
            const gateway = gatewayLink(t.gatewayRequestId, gatewayOrigin);
            return <tr key={`${userId}:${t.requestId}`}>
                <td>{receivedAt}<br />{t.durationMs} ms</td><td>{userId}<br />{t.modelAlias}<br />{t.outcome} (client reported)</td>
                <td>{tokenValue(t.usage?.inputTokens)} / {tokenValue(t.usage?.outputTokens)}<br />Estimated input: {t.estimatedInputTokens}</td>
                <td>{tokenValue(t.usage?.cacheReadTokens)} / {tokenValue(t.usage?.cacheWriteTokens)}</td>
                <td>Read {t.requested.read}, search {t.requested.search}, write {t.requested.write}, other {t.requested.other}<br />{t.readHeavyWithoutVerifiedEdit ? 'read-heavy' : '—'}</td>
                <td>Reported success {t.results.reportedSuccess}, errors {t.results.error}, unknown {t.results.unknown}<br />Verified file change: unknown</td>
                <td><details><summary>{t.requestId}</summary>
                    <p>Compaction: {t.compaction ? `${t.compaction.trigger}, count ${t.compaction.count}, folded ${t.compaction.folded}, shortened ${t.compaction.shortened}` : 'none reported'}</p>
                    <p>Turn ID is per inference. Session coverage unknown. Tool acknowledgement does not verify an edit or semantic success.</p>
                    {gateway && <a href={gateway} target="_blank" rel="noreferrer noopener">Gateway request (unverified client reference; separate login)</a>}
                    <pre>{JSON.stringify(t, null, 2)}</pre>
                </details></td>
            </tr>;
        })}</tbody></table>;
}
