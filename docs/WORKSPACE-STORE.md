# Durable workspace store: R2 or S3

_Founder decision 2026-10-02._ Computers keep running on Cloudflare Containers,
but the **durable workspace store** — where a computer's files are checkpointed
between container lifetimes — can be either the Cloudflare **R2 binding**
(default) or **AWS S3** (`us-east-1`).

This is the backend for the Worker-mediated **hydrate/flush** path
(`EzilSandboxDO.hydrateWorkspace` / `runWorkspaceFlush` in
`worker/src/index.ts`, on top of `worker/src/workspace-persist.ts`). It is **not**
the s3fs mount: `docs/PLATFORM-NOTES.md` §1 shows `sandbox.mountBucket()` drops
every second write, so the mount is never used for live storage. The
`/project-files/*` routes stay on R2 and are out of scope here.

Implementation: `worker/src/workspace-store-s3.ts`.

## Selecting the store

| `EZIL_WORKSPACE_STORE` | Behaviour |
| --- | --- |
| unset / `r2` | Use the `SANDBOX_WORKSPACE_R2_BUCKET` binding (unchanged). |
| `s3` | Use AWS S3 (or any S3-compatible endpoint). |
| anything else | **Fail closed**: `workspace_store_misconfigured`. |

When `EZIL_WORKSPACE_STORE='s3'`, these are read (via `resolveWorkspaceStore`):

| Variable | Required | Meaning |
| --- | --- | --- |
| `EZIL_WORKSPACE_S3_BUCKET` | yes | Bucket name. |
| `EZIL_WORKSPACE_S3_REGION` | yes | e.g. `us-east-1`. |
| `EZIL_WORKSPACE_S3_ACCESS_KEY_ID` | yes | Secret; never logged. |
| `EZIL_WORKSPACE_S3_SECRET_ACCESS_KEY` | yes | Secret; never logged. |
| `EZIL_WORKSPACE_S3_ENDPOINT` | no | Path-style endpoint (MinIO / local / tests). Absent → virtual-hosted AWS. |
| `EZIL_WORKSPACE_S3_KEY_PREFIX` | no | Static prefix inside the bucket, e.g. `workspaces/`. |
| `EZIL_WORKSPACE_S3_SSE` | no | `AES256` or `aws:kms`. |
| `EZIL_WORKSPACE_S3_KMS_KEY_ID` | no | KMS key id when SSE is `aws:kms`. |

These are **distinct** from the legacy `SANDBOX_WORKSPACE_S3_*` variables, which
only ever configured the (unused-for-storage) s3fs mount.

**Fail closed.** If `EZIL_WORKSPACE_STORE='s3'` but any required value is missing
or invalid (or the store value is unrecognised), every entry point
(`ensureWorkspaceMount`, `hydrateWorkspace`, `runWorkspaceFlush`) returns
`workspace_store_misconfigured` and the preview does not come up. It **never**
silently falls back to R2.

`EZIL_WORKSPACE_STORE` is deliberately **not** set in `wrangler.toml`, so the
default stays R2. Flip it per deployment with `wrangler secret put` (see the
`[vars]` comment in `worker/wrangler.toml`).

## Migration: R2 → S3 (one-way)

When `EZIL_WORKSPACE_STORE='s3'` **and** the R2 binding is still present, the S3
store is wrapped in a **read-through migrating store**
(`MigratingWorkspaceStore`). Per workspace prefix it decides, once per hydrate,
where reads come from:

1. S3 already holds `${prefix}/.ezil-snapshots/latest.json` → **read S3**.
2. else R2 holds a committed checkpoint head → **copy it forward** into S3 (head
   + every chunk, verified against the manifest, under identical keys), then
   read S3.
3. else R2 still has loose legacy files → **read R2** (one-time legacy import).
4. else (R2 empty, nothing to migrate) → **read S3**.

**All writes always go to S3.** After the workspace is hydrated to local disk,
the first flush commits a checkpoint to S3 and the migration is complete; every
later container reads from S3.

### Why "copy forward" for a committed R2 checkpoint

`worker/src/workspace-snapshot-script.ts`'s capture step fences a stale writer by
asserting the on-disk hydration marker's `checkpoint` equals the flush's
`expected` (the current head generation). An R2 restore writes
`checkpoint=<R2 generation>` into that marker. If the first S3 flush saw an empty
S3 head (`expected=null`), the capture would fail with _"workspace writer is
stale"_ and the computer would be bricked by the switch.

So for the **committed-checkpoint** case the migrating store copies the R2 head
and chunks into S3 **before** the flush, so S3 already holds `<R2 generation>`;
the first flush is then an ordinary compare-and-swap advance. For the
**legacy-loose-files** and **brand-new** cases the marker carries no
`checkpoint`, so the first flush with `expected=null` is accepted and writes a
full fresh snapshot to S3. (This is a deliberate divergence from the original
"the first flush always writes a full snapshot" wording, forced by the fencing
invariant above.)

### One-way — do not switch back after writes

Once any write has gone to S3, **R2 is stale**. Setting `EZIL_WORKSPACE_STORE`
back to `r2` after that would restore an out-of-date workspace. Treat the S3
cutover as one-way; if you must roll back, do it before any S3 flush has
committed, or re-seed R2 from S3 out of band first.

## Object layout and semantics

- Keys mirror the R2 layout exactly: `${prefix}/.ezil-snapshots/latest.json`
  (the CAS commit point), `${prefix}/.ezil-snapshots/<generation>/<i>` (immutable
  chunks), `${prefix}/.ezil-seeded` (seed sentinel), plus legacy loose files.
- `get` sends `Accept-Encoding: identity` and requires `Content-Length`; ETags
  are normalised (no `W/`, no quotes) on read and re-quoted for `If-Match`.
- `put` maps the checkpoint module's `onlyIf` to S3 conditional writes:
  `etagMatches` → `If-Match`, `etagDoesNotMatch:'*'` → `If-None-Match: *`. A
  `412 PreconditionFailed` or `409 ConditionalRequestConflict` returns `null`
  (precondition lost) and is **never retried** — a retried PUT that actually
  landed would itself come back 412 and read as a false conflict. Signing uses
  SigV4 (aws4fetch) via `sign()` + fetch, never `AwsClient.fetch` (which retries).
- `list` is `ListObjectsV2` with `encoding-type=url`, parsed without `DOMParser`
  (Workers has none).

## Operational notes / risks

- **S3 egress to Cloudflare on every hydrate.** Each container boot reads the
  head and (for a migration) the chunks from S3; the migrating store adds one
  extra head probe per prefix. Chunk uploads during flush gate readiness, so
  flush latency tracks S3 PUT latency × chunk count.
- The `+`-vs-space decoding of `encoding-type=url` list keys follows botocore's
  `unquote` semantics (literal `+` stays `+`, `%20` → space). This is covered by
  unit tests against the fake but is **not verified against live S3**.
- The SigV4 canonical URI is asserted to equal the wire path for keys with
  spaces/`+`/unicode, but the signature itself is not verified against live S3.
