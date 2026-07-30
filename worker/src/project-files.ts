/**
 * Pure (runtime-light) request/response logic for the `/project-files/*`
 * storage-proxy endpoints.
 *
 * Factored out of `index.ts` — same split as `./hmac`, `./twen`,
 * `./workspace-diag` — so the key-validation, size-ceiling, base64, and
 * R2-conditional-emulation logic can be unit-tested with plain `bun test`
 * against an in-memory `R2BucketLike` fake, without the Workers runtime or a
 * real R2 bucket. `index.ts` wires these functions to the real
 * `SANDBOX_WORKSPACE_R2_BUCKET` binding and to the shared HMAC token
 * verification (`./hmac`'s `verifyPreviewToken` — no new auth mechanism).
 *
 * ## Why this exists
 *
 * `ProjectFilesTransport` (`apps/web/client/src/server/lib/project-files-transport.ts`)
 * has three production backends: Azure Blob, R2 over the S3-compatible API
 * (`createR2Transport()`, requires R2 S3 API credentials that can currently
 * only be minted from the Cloudflare dashboard), and this one —
 * `createWorkerProxyTransport()` — which instead talks HMAC-signed HTTP to
 * this already-deployed Worker, which performs the R2 operation via its
 * existing `SANDBOX_WORKSPACE_R2_BUCKET` binding. Zero S3 credentials to
 * provision or rotate; the Worker is already this system's trust boundary
 * for R2 (see `wrangler.toml`'s `[[r2_buckets]]` block, used today for the
 * sandbox workspace mount against the SAME `ezil-sandbox-workspaces` bucket).
 *
 * ## Wire contract (mirrored byte-for-byte in
 * `apps/web/client/src/server/lib/worker-proxy-transport.ts`)
 *
 * Every endpoint is `POST` with a small JSON request body carrying a
 * `token` field verified via `verifyPreviewToken()` — identical in shape to
 * every other token-gated endpoint this Worker already exposes
 * (`/sandbox/preview`, `/sandbox/:id/workspace-diag`, `/sandbox/:id/twen`).
 * File bytes travel as a base64 string inside the JSON envelope rather than
 * as a raw body — this keeps the auth transport IDENTICAL to the existing
 * convention (token-in-JSON-body) instead of introducing a header-based
 * bearer scheme for exactly two of the five operations. The ~33% base64
 * inflation is an acceptable, deliberate trade for that consistency given
 * project source files are small (typically KB, rarely multi-MB).
 *
 *   POST /project-files/put    { token, key, contentType, bodyBase64, ifMatchVersion?, ifNotExists? }
 *     -> 200 { ok: true, version, lastModified }
 *     -> 409 { ok: false, error, reason: 'version_mismatch' | 'already_exists' }
 *     -> 400 { ok: false, error }
 *   POST /project-files/get    { token, key }
 *     -> 200 { ok: true, found: true, bodyBase64, contentType } | { ok: true, found: false }
 *   POST /project-files/head   { token, key }
 *     -> 200 { ok: true, found: true, version, lastModified, contentLength } | { ok: true, found: false }
 *   POST /project-files/delete { token, key, ifMatchVersion? }
 *     -> 200 { ok: true, deleted: boolean }
 *     -> 409 { ok: false, error, reason: 'version_mismatch' }
 *   POST /project-files/list   { token, prefix, continuationToken?, maxResults? }
 *     -> 200 { ok: true, entries: [...], continuationToken? }
 *
 * ## R2 binding conditional semantics (why put/delete look the way they do)
 *
 * The R2 *binding* API (unlike the S3-compatible REST API `createR2Transport()`
 * uses) has no `If-None-Match: *` equivalent for "put only if absent", and
 * `delete()` accepts no conditional at all — see
 * https://developers.cloudflare.com/r2/api/workers/workers-api-reference/.
 * `putProjectFile()`'s `ifNotExists` path and `deleteProjectFile()`'s
 * `ifMatchVersion` guard therefore both emulate the check with a `head()`
 * read before the mutating call, exactly like `r2-transport.ts`'s own
 * `deleteObject()` does for the identical reason on the S3 API side. This is
 * NOT atomic — a concurrent write between the Head and the Put/Delete can
 * race past the guard — and that caveat is inherited, not introduced, by
 * this transport.
 */

// ── R2 binding surface this module depends on ───────────────────────────────
//
// Deliberately a minimal structural subset of the real `R2Bucket` type (from
// `@cloudflare/workers-types`), so `bun test` can inject a small in-memory
// fake instead of requiring the Workers runtime or a real bucket — the same
// dependency-injection style `r2-transport.ts`'s `R2ClientLike` uses on the
// Node side.

export interface R2ObjectLike {
    key: string;
    etag: string;
    uploaded: Date;
    size: number;
    httpMetadata?: { contentType?: string };
}

export interface R2ObjectBodyLike extends R2ObjectLike {
    arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2ListResultLike {
    objects: R2ObjectLike[];
    truncated: boolean;
    cursor?: string;
}

export interface R2PutOptionsLike {
    httpMetadata?: { contentType?: string };
    onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
}

export interface R2BucketLike {
    put(
        key: string,
        value: Uint8Array,
        options?: R2PutOptionsLike,
    ): Promise<R2ObjectLike | null>;
    get(key: string): Promise<R2ObjectBodyLike | null>;
    head(key: string): Promise<R2ObjectLike | null>;
    delete(key: string): Promise<void>;
    list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2ListResultLike>;
}

// ── Key validation ───────────────────────────────────────────────────────────

/** R2/S3 object key length ceiling (bytes, UTF-8). */
export const PROJECT_FILES_MAX_KEY_BYTES = 1024;

export type ParsedProjectFilesKey = { ok: true; key: string } | { ok: false; error: string };

/**
 * Validate an inbound object key. R2 is a flat key-value store (not a
 * filesystem), so there is no path-traversal risk from `..` segments the way
 * there would be against a real filesystem — this only guards against
 * pathological input (empty, oversized, or containing control characters
 * that have no legitimate place in a project file path).
 */
export function parseProjectFilesKey(raw: unknown): ParsedProjectFilesKey {
    if (typeof raw !== 'string' || raw.length === 0) {
        return { ok: false, error: 'invalid_key' };
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(raw)) {
        return { ok: false, error: 'key_has_control_chars' };
    }
    const byteLength = new TextEncoder().encode(raw).length;
    if (byteLength > PROJECT_FILES_MAX_KEY_BYTES) {
        return { ok: false, error: 'key_too_long' };
    }
    return { ok: true, key: raw };
}

// ── Size ceilings ────────────────────────────────────────────────────────────

/**
 * Ceiling on the DECODED byte length of a `putObject` body.
 *
 * Cloudflare's platform request-body limit is plan-dependent (100 MB on
 * Free/Pro, 200 MB Business, 500 MB Enterprise —
 * https://developers.cloudflare.com/workers/platform/limits/#request-limits).
 * Project source files are expected to be small; this cap is set well under
 * even the smallest platform ceiling (leaving headroom for the ~33% base64
 * inflation plus JSON envelope overhead) so a single oversized upload fails
 * fast with a clear 413 instead of straining the platform limit.
 */
export const PROJECT_FILES_MAX_PUT_BYTES = 20 * 1024 * 1024; // 20 MiB decoded

export function projectFilesPutTooLarge(decodedByteLength: number): boolean {
    return decodedByteLength > PROJECT_FILES_MAX_PUT_BYTES;
}

/**
 * Ceiling on the raw (base64-inflated) HTTP request body for `/project-files/put`,
 * checked by `index.ts` BEFORE `JSON.parse` — mirrors `twen.ts`'s
 * `twenRequestTooLarge` pre-parse size gate.
 */
export const PROJECT_FILES_MAX_PUT_REQUEST_BYTES = Math.ceil((PROJECT_FILES_MAX_PUT_BYTES * 4) / 3) + 4096;

/** Ceiling for the small, bytes-free JSON bodies of get/head/delete/list. */
export const PROJECT_FILES_MAX_CONTROL_REQUEST_BYTES = 8192;

// ── Base64 helpers (Workers runtime: `atob`/`btoa`, chunked to avoid a huge
// `String.fromCharCode(...bytes)` spread blowing the call stack) ───────────

export function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

// ── putObject ────────────────────────────────────────────────────────────────

export interface PutProjectFileParams {
    key: unknown;
    contentType: unknown;
    bodyBase64: unknown;
    ifMatchVersion?: unknown;
    ifNotExists?: unknown;
}

export type PutProjectFileResult =
    | { ok: true; version: string; lastModified: string }
    | { ok: false; status: 400; error: string }
    | { ok: false; status: 409; error: string; reason: 'version_mismatch' | 'already_exists' };

export async function putProjectFile(
    bucket: R2BucketLike,
    params: PutProjectFileParams,
): Promise<PutProjectFileResult> {
    const keyResult = parseProjectFilesKey(params.key);
    if (!keyResult.ok) return { ok: false, status: 400, error: keyResult.error };
    const key = keyResult.key;

    if (typeof params.bodyBase64 !== 'string') {
        return { ok: false, status: 400, error: 'invalid_body' };
    }
    if (typeof params.contentType !== 'string' || params.contentType.length === 0) {
        return { ok: false, status: 400, error: 'invalid_content_type' };
    }
    if (params.ifMatchVersion !== undefined && typeof params.ifMatchVersion !== 'string') {
        return { ok: false, status: 400, error: 'invalid_if_match_version' };
    }

    let bytes: Uint8Array;
    try {
        bytes = base64ToBytes(params.bodyBase64);
    } catch {
        return { ok: false, status: 400, error: 'invalid_body_base64' };
    }
    if (projectFilesPutTooLarge(bytes.byteLength)) {
        return { ok: false, status: 400, error: 'body_too_large' };
    }

    const ifMatchVersion = params.ifMatchVersion as string | undefined;
    const ifNotExists = params.ifNotExists === true;

    if (ifNotExists) {
        // See module doc: no native R2-binding "if absent" conditional, so this
        // is a Head-then-Put — not atomic. The immediately-following `put()`
        // call's own null-return (if it lost a race against a concurrent
        // create in between) is treated identically as a belt-and-braces
        // second check.
        const existing = await bucket.head(key);
        if (existing) {
            return { ok: false, status: 409, error: `already_exists: ${key}`, reason: 'already_exists' };
        }
        const result = await bucket.put(key, bytes, { httpMetadata: { contentType: params.contentType } });
        if (!result) {
            return { ok: false, status: 409, error: `already_exists: ${key}`, reason: 'already_exists' };
        }
        return { ok: true, version: result.etag, lastModified: result.uploaded.toISOString() };
    }

    const result = await bucket.put(key, bytes, {
        httpMetadata: { contentType: params.contentType },
        onlyIf: ifMatchVersion ? { etagMatches: ifMatchVersion } : undefined,
    });
    if (!result) {
        return { ok: false, status: 409, error: `version_mismatch: ${key}`, reason: 'version_mismatch' };
    }
    return { ok: true, version: result.etag, lastModified: result.uploaded.toISOString() };
}

// ── getObjectBytes ───────────────────────────────────────────────────────────

export type GetProjectFileBytesResult =
    | { ok: true; found: true; bodyBase64: string; contentType: string }
    | { ok: true; found: false }
    | { ok: false; status: 400; error: string };

export async function getProjectFileBytes(
    bucket: R2BucketLike,
    rawKey: unknown,
): Promise<GetProjectFileBytesResult> {
    const keyResult = parseProjectFilesKey(rawKey);
    if (!keyResult.ok) return { ok: false, status: 400, error: keyResult.error };

    const object = await bucket.get(keyResult.key);
    if (!object) return { ok: true, found: false };

    const buf = await object.arrayBuffer();
    return {
        ok: true,
        found: true,
        bodyBase64: bytesToBase64(new Uint8Array(buf)),
        contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
    };
}

// ── getObjectProperties ──────────────────────────────────────────────────────

export type GetProjectFilePropertiesResult =
    | { ok: true; found: true; version: string; lastModified: string; contentLength: number }
    | { ok: true; found: false }
    | { ok: false; status: 400; error: string };

export async function getProjectFileProperties(
    bucket: R2BucketLike,
    rawKey: unknown,
): Promise<GetProjectFilePropertiesResult> {
    const keyResult = parseProjectFilesKey(rawKey);
    if (!keyResult.ok) return { ok: false, status: 400, error: keyResult.error };

    const object = await bucket.head(keyResult.key);
    if (!object) return { ok: true, found: false };

    return {
        ok: true,
        found: true,
        version: object.etag,
        lastModified: object.uploaded.toISOString(),
        contentLength: object.size,
    };
}

// ── deleteObject ─────────────────────────────────────────────────────────────

export interface DeleteProjectFileParams {
    key: unknown;
    ifMatchVersion?: unknown;
}

export type DeleteProjectFileResult =
    | { ok: true; deleted: boolean }
    | { ok: false; status: 400; error: string }
    | { ok: false; status: 409; error: string; reason: 'version_mismatch' };

export async function deleteProjectFile(
    bucket: R2BucketLike,
    params: DeleteProjectFileParams,
): Promise<DeleteProjectFileResult> {
    const keyResult = parseProjectFilesKey(params.key);
    if (!keyResult.ok) return { ok: false, status: 400, error: keyResult.error };
    const key = keyResult.key;

    if (params.ifMatchVersion !== undefined && typeof params.ifMatchVersion !== 'string') {
        return { ok: false, status: 400, error: 'invalid_if_match_version' };
    }
    const ifMatchVersion = params.ifMatchVersion as string | undefined;

    // R2 binding `delete()` supports no conditional and is unconditionally
    // idempotent (deleting a missing key is a success, not an error) — a Head
    // read is required both for an accurate `deleted` flag and to emulate the
    // version guard. See module doc for the resulting non-atomic race window.
    const existing = await bucket.head(key);
    if (!existing) return { ok: true, deleted: false };

    if (ifMatchVersion && existing.etag !== ifMatchVersion) {
        return { ok: false, status: 409, error: `version_mismatch: ${key}`, reason: 'version_mismatch' };
    }

    await bucket.delete(key);
    return { ok: true, deleted: true };
}

// ── listObjects ──────────────────────────────────────────────────────────────

export interface ListProjectFilesParams {
    prefix?: unknown;
    continuationToken?: unknown;
    maxResults?: unknown;
}

export interface ProjectFilesListEntry {
    path: string;
    isDirectory: boolean;
    size: number;
    modifiedTime: string;
    version: string;
}

export type ListProjectFilesResult =
    | { ok: true; entries: ProjectFilesListEntry[]; continuationToken?: string }
    | { ok: false; status: 400; error: string };

export async function listProjectFiles(
    bucket: R2BucketLike,
    params: ListProjectFilesParams,
): Promise<ListProjectFilesResult> {
    if (params.prefix !== undefined && typeof params.prefix !== 'string') {
        return { ok: false, status: 400, error: 'invalid_prefix' };
    }
    if (params.continuationToken !== undefined && typeof params.continuationToken !== 'string') {
        return { ok: false, status: 400, error: 'invalid_continuation_token' };
    }
    if (params.maxResults !== undefined && typeof params.maxResults !== 'number') {
        return { ok: false, status: 400, error: 'invalid_max_results' };
    }

    const result = await bucket.list({
        prefix: params.prefix as string | undefined,
        cursor: params.continuationToken as string | undefined,
        limit: (params.maxResults as number | undefined) ?? 1000,
    });

    const entries: ProjectFilesListEntry[] = result.objects.map((object) => ({
        path: object.key,
        isDirectory: false,
        size: object.size,
        modifiedTime: object.uploaded.toISOString(),
        version: object.etag,
    }));

    return {
        ok: true,
        entries,
        continuationToken: result.truncated ? result.cursor : undefined,
    };
}
