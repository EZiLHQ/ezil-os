export async function readSmallBody(message: Request | Response, limit: number, timeout = 2000): Promise<string> {
    const declared = message.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('body_size');
    if (!message.body) throw new Error('body_missing');
    const reader = message.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let expired = false;
    const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, timeout);
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (expired) throw new Error('body_timeout');
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw new Error('body_size');
            chunks.push(value);
        }
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    } finally {
        clearTimeout(timer);
        void reader.cancel().catch(() => {});
    }
}
