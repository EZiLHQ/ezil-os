import { deriveGuacamoleSandboxId, mintAppPreviewBootstrapToken } from '../cloudflare-guacamole-provider';
import { readAwsBrowserZone, type Env } from './aws-config';
import { getFollowingSameOriginCookies } from './aws-preview-cookies';
import type { ImagePlacement } from './placement';

/** Uses the existing authenticated browser path and probes the desktop and editor. */
export async function imageDesktopHealthy(p: ImagePlacement, env: Env, now = Date.now()): Promise<boolean> {
    const zone = readAwsBrowserZone(env), secret = env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET;
    if (!zone || !secret || p.lastError !== 'enroll_succeeded' || !p.enrollConsumedHash) return false;
    const sandbox = deriveGuacamoleSandboxId(p.ownerUserId, p.computerId);
    const token = mintAppPreviewBootstrapToken(secret, sandbox, now);
    try {
        for (const [port, path] of [[8181, '/'], [8443, '/healthz']] as const) {
            const url = new URL(`https://aws-${port}-${sandbox}-aws.${zone}/preview-bootstrap`);
            url.searchParams.set('token', token); url.searchParams.set('path', path);
            const { response, url: final } = await getFollowingSameOriginCookies(url.toString(), { cache: 'no-store', signal: AbortSignal.timeout(10000) });
            const ok = final.origin === url.origin && final.pathname === path && response.status === 200;
            await response.body?.cancel();
            if (!ok) return false;
        }
        return true;
    } catch { return false; }
}
