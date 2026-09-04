/**
 * Serving `bundle.min.js`, `bundle.min.css` and `icons.js` BY PATH.
 *
 * 🔴 NEVER COPIED INTO `local/`. The committed `app/public/os/bundle.min.js`
 * must match its `shell/` sources; a second copy under this package would be a
 * second thing to keep in step and the first release where they diverged would
 * ship a desktop shell nobody could diff against its source. The directory is
 * resolved at startup (`../config.ts`'s `pickShellAssetsDir`) from the package
 * root, so a checkout finds `app/public/os` and a release tarball finds `os/`
 * beside `local/` — neither needs an environment variable.
 *
 * ── The cache header has to move when the file does ─────────────────────────
 * These three files are rebuilt by `shell/build-shell.sh` at the same three
 * paths. A cache header that did not change with the bytes would leave a
 * developer — and a user who updated — running the previous bundle with no way
 * to tell. So the validator is derived from the file's OWN mtime and size, and
 * `Cache-Control: no-cache` forces the browser to ask every time. `no-cache`
 * is not `no-store`: the browser still keeps the bytes and a matching
 * `If-None-Match` gets a 304 with no body, which is what makes a 687KB bundle
 * cheap to re-check.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

import { SHELL_ASSET_FILES, type ShellAssetFile } from '../config.ts';

export { SHELL_ASSET_FILES };
export type { ShellAssetFile };

/**
 * Content types.
 *
 * `text/javascript` rather than `application/javascript`: the former is the
 * only one the WHATWG MIME Sniffing standard lists as the JavaScript MIME
 * essence, and a browser in a strict mode refuses to execute a `<script src>`
 * whose type is not a JavaScript MIME type. Getting this wrong is a shell that
 * silently never boots.
 */
export const ASSET_CONTENT_TYPES: Readonly<Record<ShellAssetFile, string>> = Object.freeze({
    'bundle.min.js': 'text/javascript; charset=utf-8',
    'bundle.min.css': 'text/css; charset=utf-8',
    'icons.js': 'text/javascript; charset=utf-8',
});

/** `/os/<file>` for each served file. The `/os` document links these exact strings. */
export function assetRoutePath(file: ShellAssetFile): string {
    return `/os/${file}`;
}

/** The route path -> file map the server switches on. A closed table, so no request path is ever joined onto a directory. */
export const ASSET_ROUTES: Readonly<Record<string, ShellAssetFile>> = Object.freeze(
    Object.fromEntries(SHELL_ASSET_FILES.map((f) => [assetRoutePath(f), f])),
);

export interface AssetStat {
    readonly path: string;
    readonly sizeBytes: number;
    readonly mtimeMs: number;
}

/**
 * Stat one asset, or `null` when it is not there.
 *
 * Never throws: a missing bundle is a 404 with a diagnosable body, not a crash
 * that takes the whole host down and tells the user nothing.
 */
export function statAsset(dir: string, file: ShellAssetFile): AssetStat | null {
    const path = join(dir, file);
    try {
        const st = statSync(path);
        if (!st.isFile()) return null;
        return { path, sizeBytes: st.size, mtimeMs: st.mtimeMs };
    } catch {
        return null;
    }
}

/**
 * The validator for one asset: a weak ETag over `<mtime-ms>-<size>`.
 *
 * Weak (`W/`) because it is derived from metadata rather than from the bytes —
 * two builds producing identical content one millisecond apart would get
 * different tags, which costs a re-download and never serves a stale file. The
 * error that matters here is the other one.
 *
 * `Math.trunc` because `mtimeMs` is fractional on filesystems with nanosecond
 * timestamps and a float in a header field is noise, not information.
 */
export function assetETag(stat: AssetStat): string {
    return `W/"${Math.trunc(stat.mtimeMs)}-${stat.sizeBytes}"`;
}

/**
 * `no-cache`, NOT `no-store` and NOT `max-age`.
 *
 * `no-store` would forbid keeping the bytes at all and re-download 687KB on
 * every navigation. A positive `max-age` would serve a stale bundle for that
 * long after a rebuild. `no-cache` keeps the bytes and revalidates every time,
 * so the ETag above is what actually decides.
 */
export const ASSET_CACHE_CONTROL = 'no-cache';

/**
 * Build the response for one shell asset, honouring `If-None-Match`.
 *
 * Returns `null` when the file is absent so the caller owns the 404 body — this
 * module answers about assets, not about the shape of this host's errors.
 */
export function shellAssetResponse(
    dir: string,
    file: ShellAssetFile,
    req: Request,
): Response | null {
    const stat = statAsset(dir, file);
    if (!stat) return null;

    const etag = assetETag(stat);
    const headers = new Headers({
        'content-type': ASSET_CONTENT_TYPES[file],
        'cache-control': ASSET_CACHE_CONTROL,
        etag,
    });

    // A conditional request whose validator still matches gets no body. Compared
    // literally rather than parsed: this host mints every tag it ever serves, so
    // the only value that can legitimately match is one of its own, and a
    // permissive parser here would be parsing untrusted input for no gain.
    if (req.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers });
    }

    headers.set('content-length', String(stat.sizeBytes));
    return new Response(Bun.file(stat.path), { status: 200, headers });
}
