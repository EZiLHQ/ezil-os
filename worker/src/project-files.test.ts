/**
 * Package-local tests for the `/project-files/*` storage-proxy pure logic
 * (`./project-files`). Run with `bun test`, no Workers runtime or real R2
 * bucket required — exercised against an in-memory `R2BucketLike` fake that
 * mirrors the real binding's documented semantics (`put` returns `null` on a
 * failed `onlyIf`; `head`/`get` return `null` for a missing key; `delete` is
 * unconditional and idempotent) — see
 * https://developers.cloudflare.com/r2/api/workers/workers-api-reference/.
 *
 * HMAC gating for these endpoints reuses `./hmac`'s `verifyPreviewToken`
 * envelope verbatim (wired in `index.ts`), already covered by the shared
 * `./hmac` suite in `index.test.ts` — not re-tested here.
 */

import { describe, expect, it } from 'bun:test';

import {
  base64ToBytes,
  bytesToBase64,
  deleteProjectFile,
  getProjectFileBytes,
  getProjectFileProperties,
  listProjectFiles,
  parseProjectFilesKey,
  projectFilesPutTooLarge,
  PROJECT_FILES_MAX_KEY_BYTES,
  PROJECT_FILES_MAX_PUT_BYTES,
  putProjectFile,
  type R2BucketLike,
  type R2ObjectLike,
} from './project-files';

// ── In-memory R2BucketLike fake ─────────────────────────────────────────────

function makeFakeBucket(): R2BucketLike {
  const store = new Map<string, { bytes: Uint8Array; contentType?: string; etag: string; uploaded: Date }>();
  let etagCounter = 0;

  return {
    async put(key, value, options) {
      const existing = store.get(key);
      if (options?.onlyIf?.etagMatches !== undefined) {
        if (!existing || existing.etag !== options.onlyIf.etagMatches) return null;
      }
      if (options?.onlyIf?.etagDoesNotMatch !== undefined) {
        if (existing && existing.etag === options.onlyIf.etagDoesNotMatch) return null;
      }
      etagCounter += 1;
      const etag = `etag-${etagCounter}`;
      const uploaded = new Date();
      store.set(key, {
        bytes: value.slice(),
        contentType: options?.httpMetadata?.contentType,
        etag,
        uploaded,
      });
      const result: R2ObjectLike = {
        key,
        etag,
        uploaded,
        size: value.byteLength,
        httpMetadata: { contentType: options?.httpMetadata?.contentType },
      };
      return result;
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        key,
        etag: entry.etag,
        uploaded: entry.uploaded,
        size: entry.bytes.byteLength,
        httpMetadata: { contentType: entry.contentType },
        async arrayBuffer() {
          return entry.bytes.buffer.slice(
            entry.bytes.byteOffset,
            entry.bytes.byteOffset + entry.bytes.byteLength,
          ) as ArrayBuffer;
        },
      };
    },
    async head(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        key,
        etag: entry.etag,
        uploaded: entry.uploaded,
        size: entry.bytes.byteLength,
        httpMetadata: { contentType: entry.contentType },
      };
    },
    async delete(key) {
      store.delete(key);
    },
    async list(options) {
      const prefix = options?.prefix ?? '';
      const all = [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

      const limit = options?.limit ?? 1000;
      const startIndex = options?.cursor ? Number(options.cursor) : 0;
      const page = all.slice(startIndex, startIndex + limit);
      const truncated = startIndex + limit < all.length;

      return {
        objects: page.map(([key, entry]) => ({
          key,
          etag: entry.etag,
          uploaded: entry.uploaded,
          size: entry.bytes.byteLength,
          httpMetadata: { contentType: entry.contentType },
        })),
        truncated,
        cursor: truncated ? String(startIndex + limit) : undefined,
      };
    },
  };
}

// ── Key validation ───────────────────────────────────────────────────────────

describe('parseProjectFilesKey', () => {
  it('rejects an empty or non-string key', () => {
    expect(parseProjectFilesKey('')).toEqual({ ok: false, error: 'invalid_key' });
    expect(parseProjectFilesKey(undefined)).toEqual({ ok: false, error: 'invalid_key' });
    expect(parseProjectFilesKey(42)).toEqual({ ok: false, error: 'invalid_key' });
  });

  it('rejects control characters', () => {
    expect(parseProjectFilesKey('proj-1/branches/main/a\x00b.txt')).toEqual({
      ok: false,
      error: 'key_has_control_chars',
    });
  });

  it('rejects a key over the length ceiling', () => {
    const long = 'a'.repeat(PROJECT_FILES_MAX_KEY_BYTES + 1);
    expect(parseProjectFilesKey(long)).toEqual({ ok: false, error: 'key_too_long' });
  });

  it('accepts a well-formed scoped key', () => {
    expect(parseProjectFilesKey('proj-1/branches/main/src/index.ts')).toEqual({
      ok: true,
      key: 'proj-1/branches/main/src/index.ts',
    });
  });
});

// ── Size ceiling ─────────────────────────────────────────────────────────────

describe('projectFilesPutTooLarge', () => {
  it('is false at and under the ceiling, true over it', () => {
    expect(projectFilesPutTooLarge(PROJECT_FILES_MAX_PUT_BYTES)).toBe(false);
    expect(projectFilesPutTooLarge(PROJECT_FILES_MAX_PUT_BYTES + 1)).toBe(true);
  });
});

// ── Base64 round-trip ────────────────────────────────────────────────────────

describe('base64ToBytes / bytesToBase64', () => {
  it('round-trips arbitrary binary bytes, including a large buffer spanning multiple chunks', () => {
    const original = new Uint8Array(200_000);
    for (let i = 0; i < original.length; i++) original[i] = i % 256;
    const roundTripped = base64ToBytes(bytesToBase64(original));
    expect(roundTripped).toEqual(original);
  });
});

// ── putProjectFile / getProjectFileBytes / getProjectFileProperties ─────────

describe('putProjectFile + getProjectFileBytes + getProjectFileProperties', () => {
  it('round-trips exact bytes and a provider-confirmed version', async () => {
    const bucket = makeFakeBucket();
    const key = 'proj-1/branches/main/src/index.ts';
    const bodyBytes = new TextEncoder().encode('export const x = 1;\n');

    const put = await putProjectFile(bucket, {
      key,
      contentType: 'application/typescript',
      bodyBase64: bytesToBase64(bodyBytes),
    });
    expect(put.ok).toBe(true);
    if (!put.ok) throw new Error('unreachable');
    expect(typeof put.version).toBe('string');
    expect(put.version.length).toBeGreaterThan(0);

    const got = await getProjectFileBytes(bucket, key);
    expect(got).toMatchObject({ ok: true, found: true, contentType: 'application/typescript' });
    if (!got.ok || !got.found) throw new Error('unreachable');
    expect(base64ToBytes(got.bodyBase64)).toEqual(bodyBytes);

    const props = await getProjectFileProperties(bucket, key);
    expect(props).toMatchObject({ ok: true, found: true, contentLength: bodyBytes.byteLength });
  });

  it('getProjectFileBytes / getProjectFileProperties report found:false for a missing key', async () => {
    const bucket = makeFakeBucket();
    expect(await getProjectFileBytes(bucket, 'proj-1/branches/main/missing.txt')).toEqual({
      ok: true,
      found: false,
    });
    expect(await getProjectFileProperties(bucket, 'proj-1/branches/main/missing.txt')).toEqual({
      ok: true,
      found: false,
    });
  });

  it('ifNotExists succeeds when absent, and returns a typed 409 already_exists conflict when present', async () => {
    const bucket = makeFakeBucket();
    const key = 'proj-1/branches/main/exists.txt';

    const first = await putProjectFile(bucket, {
      key,
      contentType: 'text/plain',
      bodyBase64: bytesToBase64(new TextEncoder().encode('v1')),
      ifNotExists: true,
    });
    expect(first.ok).toBe(true);

    const second = await putProjectFile(bucket, {
      key,
      contentType: 'text/plain',
      bodyBase64: bytesToBase64(new TextEncoder().encode('v2')),
      ifNotExists: true,
    });
    expect(second).toMatchObject({ ok: false, status: 409, reason: 'already_exists' });

    // The conflicting write must never have landed.
    const got = await getProjectFileBytes(bucket, key);
    if (!got.ok || !got.found) throw new Error('unreachable');
    expect(new TextDecoder().decode(base64ToBytes(got.bodyBase64))).toBe('v1');
  });

  it('ifMatchVersion: correct version overwrites, stale version is a typed 409 conflict leaving the object intact', async () => {
    const bucket = makeFakeBucket();
    const key = 'proj-1/branches/main/versioned.txt';

    const v1 = await putProjectFile(bucket, {
      key,
      contentType: 'text/plain',
      bodyBase64: bytesToBase64(new TextEncoder().encode('v1')),
    });
    if (!v1.ok) throw new Error('unreachable');

    const v2 = await putProjectFile(bucket, {
      key,
      contentType: 'text/plain',
      bodyBase64: bytesToBase64(new TextEncoder().encode('v2')),
      ifMatchVersion: v1.version,
    });
    expect(v2.ok).toBe(true);

    const stale = await putProjectFile(bucket, {
      key,
      contentType: 'text/plain',
      bodyBase64: bytesToBase64(new TextEncoder().encode('v3')),
      ifMatchVersion: 'not-the-real-version',
    });
    expect(stale).toMatchObject({ ok: false, status: 409, reason: 'version_mismatch' });

    const got = await getProjectFileBytes(bucket, key);
    if (!got.ok || !got.found) throw new Error('unreachable');
    expect(new TextDecoder().decode(base64ToBytes(got.bodyBase64))).toBe('v2');
  });

  it('rejects a body over the size ceiling with a typed 400 before ever calling put', async () => {
    const bucket = makeFakeBucket();
    const oversized = new Uint8Array(PROJECT_FILES_MAX_PUT_BYTES + 1);
    const result = await putProjectFile(bucket, {
      key: 'proj-1/branches/main/huge.bin',
      contentType: 'application/octet-stream',
      bodyBase64: bytesToBase64(oversized),
    });
    expect(result).toMatchObject({ ok: false, status: 400, error: 'body_too_large' });
    expect(await getProjectFileProperties(bucket, 'proj-1/branches/main/huge.bin')).toEqual({
      ok: true,
      found: false,
    });
  });

  it('rejects malformed input (bad key, non-string body/contentType) with a typed 400', async () => {
    const bucket = makeFakeBucket();
    expect(await putProjectFile(bucket, { key: '', contentType: 'text/plain', bodyBase64: 'aGk=' })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await putProjectFile(bucket, { key: 'a', contentType: 123, bodyBase64: 'aGk=' })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await putProjectFile(bucket, { key: 'a', contentType: 'text/plain', bodyBase64: 42 })).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

// ── deleteProjectFile ────────────────────────────────────────────────────────

describe('deleteProjectFile', () => {
  it('is idempotent-success ({ deleted: false }, no throw) on a missing key', async () => {
    const bucket = makeFakeBucket();
    expect(await deleteProjectFile(bucket, { key: 'proj-1/branches/main/missing.txt' })).toEqual({
      ok: true,
      deleted: false,
    });
  });

  it('deletes an existing key with no version guard', async () => {
    const bucket = makeFakeBucket();
    const key = 'proj-1/branches/main/to-delete.txt';
    await putProjectFile(bucket, { key, contentType: 'text/plain', bodyBase64: bytesToBase64(new Uint8Array([1])) });

    const result = await deleteProjectFile(bucket, { key });
    expect(result).toEqual({ ok: true, deleted: true });
    expect(await getProjectFileProperties(bucket, key)).toEqual({ ok: true, found: false });
  });

  it('deletes with a correct ifMatchVersion, and returns a typed 409 leaving the object intact for a stale one', async () => {
    const bucket = makeFakeBucket();
    const key = 'proj-1/branches/main/guarded.txt';
    const put = await putProjectFile(bucket, {
      key,
      contentType: 'text/plain',
      bodyBase64: bytesToBase64(new TextEncoder().encode('still here')),
    });
    if (!put.ok) throw new Error('unreachable');

    const stale = await deleteProjectFile(bucket, { key, ifMatchVersion: 'not-the-real-version' });
    expect(stale).toMatchObject({ ok: false, status: 409, reason: 'version_mismatch' });
    expect(await getProjectFileProperties(bucket, key)).toMatchObject({ ok: true, found: true });

    const result = await deleteProjectFile(bucket, { key, ifMatchVersion: put.version });
    expect(result).toEqual({ ok: true, deleted: true });
  });
});

// ── listProjectFiles ─────────────────────────────────────────────────────────

describe('listProjectFiles', () => {
  it('isolates sibling projects sharing an overlapping numeric prefix', async () => {
    const bucket = makeFakeBucket();
    const oneByte = bytesToBase64(new Uint8Array([1]));
    await putProjectFile(bucket, { key: 'proj-1/branches/main/a.txt', contentType: 'text/plain', bodyBase64: oneByte });
    await putProjectFile(bucket, {
      key: 'proj-1/branches/main/dir/b.txt',
      contentType: 'text/plain',
      bodyBase64: oneByte,
    });
    await putProjectFile(bucket, { key: 'proj-10/branches/main/c.txt', contentType: 'text/plain', bodyBase64: oneByte });

    const page = await listProjectFiles(bucket, { prefix: 'proj-1/branches/main/' });
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error('unreachable');
    expect(page.entries.map((e) => e.path).sort()).toEqual([
      'proj-1/branches/main/a.txt',
      'proj-1/branches/main/dir/b.txt',
    ]);
  });

  it('paginates via continuationToken until every matching key is seen exactly once', async () => {
    const bucket = makeFakeBucket();
    const oneByte = bytesToBase64(new Uint8Array([1]));
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) {
      const key = `proj-1/branches/main/file-${i}.txt`;
      keys.push(key);
      await putProjectFile(bucket, { key, contentType: 'text/plain', bodyBase64: oneByte });
    }

    const seen: string[] = [];
    let continuationToken: string | undefined;
    let pages = 0;
    do {
      const page = await listProjectFiles(bucket, {
        prefix: 'proj-1/branches/main/',
        continuationToken,
        maxResults: 2,
      });
      expect(page.ok).toBe(true);
      if (!page.ok) throw new Error('unreachable');
      seen.push(...page.entries.map((e) => e.path));
      continuationToken = page.continuationToken;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (continuationToken);

    expect(seen.sort()).toEqual([...keys].sort());
  });

  it('rejects a non-string prefix / continuationToken / non-number maxResults with a typed 400', async () => {
    const bucket = makeFakeBucket();
    expect(await listProjectFiles(bucket, { prefix: 42 })).toMatchObject({ ok: false, status: 400 });
    expect(await listProjectFiles(bucket, { continuationToken: 42 })).toMatchObject({ ok: false, status: 400 });
    expect(await listProjectFiles(bucket, { maxResults: '2' })).toMatchObject({ ok: false, status: 400 });
  });
});
