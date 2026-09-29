// Minimal Server-Sent Events parser over a fetch body. Dependency-free.

export type SseEvent = { event?: string; data: string };

export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event: string | undefined;
    let data: string[] = [];
    const flush = (): SseEvent | undefined => {
        // Per the SSE spec an event with an empty data buffer is not dispatched.
        if (!data.length) { event = undefined; return undefined; }
        const out: SseEvent = { data: data.join('\n') };
        if (event !== undefined) out.event = event;
        event = undefined; data = [];
        return out;
    };
    const handleLine = (line: string): SseEvent | undefined => {
        if (line === '') return flush();
        if (line.startsWith(':')) return undefined;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
        return undefined;
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            let newline: number;
            while ((newline = buffer.search(/\r\n|\n|\r/)) >= 0) {
                // A trailing lone CR may be the first half of a CRLF split across chunks: wait for more bytes.
                if (!done && newline === buffer.length - 1 && buffer[newline] === '\r') break;
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1));
                const out = handleLine(line);
                if (out) yield out;
            }
            if (done) break;
        }
        if (buffer) { const out = handleLine(buffer); if (out) yield out; }
        const tail = flush();
        if (tail) yield tail;
    } finally {
        reader.releaseLock();
    }
}

/** Iterate `data:` payloads as parsed JSON, skipping OpenAI's `[DONE]` sentinel (reported as `{done: true}`). */
export async function* jsonEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; json?: unknown; done?: boolean; raw: string }> {
    for await (const { event, data } of sseEvents(body)) {
        const trimmed = data.trim();
        if (!trimmed) continue;
        if (trimmed === '[DONE]') { yield { event, done: true, raw: trimmed }; continue; }
        try { yield { event, json: JSON.parse(trimmed), raw: trimmed }; }
        catch { throw new Error(`Provider sent a malformed stream event: ${trimmed.slice(0, 200)}`); }
    }
}
