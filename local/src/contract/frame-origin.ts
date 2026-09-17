import { localUrlFor } from '../container/run-spec.ts';

export type FrameSurface = 'desktop' | 'code' | 'preview';
export type FrameProbe = { alive: boolean; reason: 'ok' | 'http_error' | 'unreachable' | 'timeout' | 'foreign_origin'; status?: number };

/** Pin each frame to its own port, including configured port offsets. */
export function isOwnFrameOrigin(raw: string, surface: FrameSurface, offset = 0): boolean {
    try {
        if (!['desktop', 'code', 'preview'].includes(surface)) return false;
        const url = new URL(raw);
        const port = surface === 'preview' ? 'appPreview' : surface;
        const own = new URL(localUrlFor(port, offset));
        return !url.username && !url.password && url.origin === own.origin;
    } catch { return false; }
}

export async function probeFrameOrigin(raw: string, surface: FrameSurface, offset = 0,
    fetcher: typeof fetch = fetch): Promise<FrameProbe> {
    if (!isOwnFrameOrigin(raw, surface, offset)) return { alive: false, reason: 'foreign_origin' };
    try {
        const response = await fetcher(raw, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(3_000) });
        // Read only the status; release the body even if it is a persistent stream.
        await response.body?.cancel();
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location || !isOwnFrameOrigin(new URL(location, raw).href, surface, offset)) {
                return { alive: false, reason: 'foreign_origin', status: response.status };
            }
        }
        return { alive: response.status < 400, reason: response.status < 400 ? 'ok' : 'http_error', status: response.status };
    } catch (error) {
        return { alive: false, reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
}
