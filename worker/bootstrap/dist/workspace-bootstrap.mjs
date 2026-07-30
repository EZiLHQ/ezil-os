// @bun
var __require = import.meta.require;

// ../../packages/workspace-engine/src/errors.ts
var WORKSPACE_ERROR_CODES = [
  "conflict",
  "partial",
  "unauthorized",
  "stale_session",
  "integrity",
  "invalid_path",
  "limit",
  "timeout",
  "retryable_provider",
  "unsupported_delete"
];
var CODE_SET = new Set(WORKSPACE_ERROR_CODES);
function isWorkspaceErrorCode(value) {
  return typeof value === "string" && CODE_SET.has(value);
}

class WorkspaceError extends Error {
  code;
  details;
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, WorkspaceError.prototype);
  }
  static is(value) {
    return value instanceof WorkspaceError;
  }
  static conflict(message, currentVersion) {
    return new WorkspaceError("conflict", message, { currentVersion });
  }
  static integrity(message, currentVersion) {
    return new WorkspaceError("integrity", message, { currentVersion });
  }
  static invalidPath(message) {
    return new WorkspaceError("invalid_path", message);
  }
  static limit(message) {
    return new WorkspaceError("limit", message);
  }
  static unsupportedDelete(message) {
    return new WorkspaceError("unsupported_delete", message);
  }
}
// ../../packages/workspace-engine/src/protocol.ts
var PROTOCOL_VERSION = 1;
var EXPECT_ABSENT = "\x00absent";
// ../../packages/workspace-engine/src/validation.ts
var LIMITS = {
  idMaxLength: 256,
  pathMaxLength: 1024,
  versionMaxLength: 1024,
  idempotencyKeyMaxLength: 256,
  attemptMax: 1e6,
  byteLengthMax: 16 * 1024 * 1024 * 1024,
  listLimitMax: 1e4
};
var ID_RE = /^[A-Za-z0-9._:-]+$/;
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertNoUnknownFields(value, allowed, context) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw WorkspaceError.limit(`${context}: unknown field "${key}"`);
    }
  }
}
function assertId(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceError("invalid_path", `${field} must be a non-empty string`);
  }
  if (value.length > LIMITS.idMaxLength) {
    throw WorkspaceError.limit(`${field} exceeds ${LIMITS.idMaxLength} chars`);
  }
  if (!ID_RE.test(value)) {
    throw new WorkspaceError("invalid_path", `${field} contains invalid characters`);
  }
  return value;
}
function assertAttempt(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > LIMITS.attemptMax) {
    throw new WorkspaceError("invalid_path", `attempt must be an integer in [1, ${LIMITS.attemptMax}]`);
  }
  return value;
}
function normalizeRelativePath(input) {
  if (typeof input !== "string" || input.length === 0) {
    throw WorkspaceError.invalidPath("path must be a non-empty string");
  }
  if (input.includes("\x00")) {
    throw WorkspaceError.invalidPath("path contains a null byte");
  }
  if (input.includes("\\")) {
    throw WorkspaceError.invalidPath("path must use POSIX separators");
  }
  if (input.startsWith("/")) {
    throw WorkspaceError.invalidPath("path must be relative");
  }
  if (/^[A-Za-z]:/.test(input)) {
    throw WorkspaceError.invalidPath("path must not include a drive letter");
  }
  const segments = [];
  for (const rawSegment of input.split("/")) {
    if (rawSegment === "" || rawSegment === ".") {
      continue;
    }
    if (rawSegment === "..") {
      throw WorkspaceError.invalidPath('path must not traverse parents ("..")');
    }
    segments.push(rawSegment);
  }
  if (segments.length === 0) {
    throw WorkspaceError.invalidPath("path resolves to empty");
  }
  const normalized = segments.join("/");
  if (normalized.length > LIMITS.pathMaxLength) {
    throw WorkspaceError.limit(`path exceeds ${LIMITS.pathMaxLength} chars`);
  }
  return normalized;
}
var BINDING_FIELDS = [
  "version",
  "sessionId",
  "attempt",
  "projectId",
  "branch",
  "correlationId",
  "operationId"
];
function validateBinding(input) {
  if (!isPlainObject(input)) {
    throw WorkspaceError.invalidPath("binding must be an object");
  }
  assertNoUnknownFields(input, BINDING_FIELDS, "binding");
  if (input.version !== PROTOCOL_VERSION) {
    throw new WorkspaceError("stale_session", `unsupported protocol version (expected ${PROTOCOL_VERSION})`);
  }
  return {
    version: PROTOCOL_VERSION,
    sessionId: assertId(input.sessionId, "sessionId"),
    attempt: assertAttempt(input.attempt),
    projectId: assertId(input.projectId, "projectId"),
    branch: assertId(input.branch, "branch"),
    correlationId: assertId(input.correlationId, "correlationId"),
    operationId: assertId(input.operationId, "operationId")
  };
}
function assertVersionToken(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceError("integrity", "version must be a non-empty string");
  }
  if (value.length > LIMITS.versionMaxLength) {
    throw WorkspaceError.limit(`version exceeds ${LIMITS.versionMaxLength} chars`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new WorkspaceError("integrity", "version contains control characters");
  }
  return value;
}
function validateListPagesRequest(input) {
  if (input === undefined) {
    return {};
  }
  if (!isPlainObject(input)) {
    throw WorkspaceError.limit("listPages request must be an object");
  }
  assertNoUnknownFields(input, ["cursor", "limit"], "listPages");
  const req = {};
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || input.cursor.length === 0) {
      throw WorkspaceError.limit("cursor must be a non-empty string");
    }
    req.cursor = input.cursor;
  }
  if (input.limit !== undefined) {
    if (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > LIMITS.listLimitMax) {
      throw WorkspaceError.limit(`limit must be an integer in [1, ${LIMITS.listLimitMax}]`);
    }
    req.limit = input.limit;
  }
  return req;
}
function validateGetFileRequest(input) {
  if (!isPlainObject(input)) {
    throw WorkspaceError.invalidPath("getFile request must be an object");
  }
  assertNoUnknownFields(input, ["path"], "getFile");
  return { path: normalizeRelativePath(input.path) };
}
function validatePutFileRequest(input) {
  if (!isPlainObject(input)) {
    throw WorkspaceError.invalidPath("putFile request must be an object");
  }
  assertNoUnknownFields(input, ["path", "bytes", "expectedVersion", "idempotencyKey"], "putFile");
  if (!(input.bytes instanceof Uint8Array)) {
    throw new WorkspaceError("integrity", "bytes must be a Uint8Array");
  }
  const req = {
    path: normalizeRelativePath(input.path),
    bytes: input.bytes
  };
  if (input.expectedVersion !== undefined) {
    if (input.expectedVersion === EXPECT_ABSENT) {
      req.expectedVersion = EXPECT_ABSENT;
    } else {
      req.expectedVersion = assertVersionToken(input.expectedVersion);
    }
  }
  if (input.idempotencyKey !== undefined) {
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
      throw WorkspaceError.limit("idempotencyKey must be a non-empty string");
    }
    if (input.idempotencyKey.length > LIMITS.idempotencyKeyMaxLength) {
      throw WorkspaceError.limit(`idempotencyKey exceeds ${LIMITS.idempotencyKeyMaxLength} chars`);
    }
    req.idempotencyKey = input.idempotencyKey;
  }
  return req;
}
// ../../packages/workspace-engine/src/engine.ts
import { createHash } from "crypto";
import { createRequire } from "module";
import * as nodePath from "path";
var EZIL_DIR = ".ezil";
var BASELINE_FILE = "baseline.json";
var require2 = createRequire(import.meta.url);
var fsp = require2("node:fs/promises");
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function resolveWithinRoot(root, relPosix) {
  const abs = nodePath.resolve(root, ...relPosix.split("/"));
  const rootResolved = nodePath.resolve(root);
  const prefix = rootResolved.endsWith(nodePath.sep) ? rootResolved : rootResolved + nodePath.sep;
  if (abs !== rootResolved && !abs.startsWith(prefix)) {
    throw WorkspaceError.invalidPath("resolved path escapes workspace root");
  }
  return abs;
}

class WorkspaceEngine {
  root;
  bridge;
  hooks;
  constructor(options) {
    if (!options || typeof options.root !== "string" || options.root.length === 0) {
      throw WorkspaceError.invalidPath("WorkspaceEngine requires an absolute root");
    }
    if (!nodePath.isAbsolute(options.root)) {
      throw WorkspaceError.invalidPath("WorkspaceEngine root must be absolute");
    }
    if (!options.bridge) {
      throw new WorkspaceError("unauthorized", "WorkspaceEngine requires a BridgeClient");
    }
    this.root = options.root;
    this.bridge = options.bridge;
    this.hooks = options.publishHooks ?? {};
  }
  async listPages(binding, request) {
    const b = validateBinding(binding);
    const req = validateListPagesRequest(request);
    return this.bridge.listPages(b, req);
  }
  async pullFile(binding, request) {
    const b = validateBinding(binding);
    const req = validateGetFileRequest(request);
    const result = await this.bridge.getFile(b, req);
    const metadata = this.assertResultPath(result.metadata, req.path);
    this.verifyIntegrity(result.bytes, metadata);
    await this.atomicWrite(metadata.path, result.bytes);
    return metadata;
  }
  async putFile(binding, request, options) {
    const b = validateBinding(binding);
    const merged = options && typeof request === "object" && request !== null ? { ...request, ...options } : request;
    const req = validatePutFileRequest(merged);
    const result = await this.bridge.putFile(b, req);
    const metadata = this.assertResultPath(result.metadata, req.path);
    this.verifyPutAck(req.bytes, metadata);
    await this.atomicWrite(metadata.path, req.bytes);
    return { metadata, idempotentReplay: result.idempotentReplay };
  }
  async deleteFile() {
    throw WorkspaceError.unsupportedDelete("delete is not supported in protocol v1");
  }
  async hydrateBranch(binding, options = {}) {
    const b = validateBinding(binding);
    const maxPages = options.maxPages ?? 1e4;
    const maxFiles = options.maxFiles ?? 200000;
    const maxTotalBytes = options.maxTotalBytes ?? 16 * 1024 * 1024 * 1024;
    const maxFileBytes = options.maxFileBytes ?? Number.POSITIVE_INFINITY;
    const maxDurationMs = options.maxDurationMs ?? 10 * 60 * 1000;
    const startedAt = Date.now();
    const allMeta = [];
    let cursor;
    let pages = 0;
    do {
      if (pages >= maxPages) {
        throw WorkspaceError.limit("hydrateBranch: page limit exceeded");
      }
      if (Date.now() - startedAt > maxDurationMs) {
        throw new WorkspaceError("timeout", "hydrateBranch: time budget exceeded while listing");
      }
      const page = await this.bridge.listPages(b, cursor ? { cursor } : {});
      pages += 1;
      for (const meta of page.files) {
        allMeta.push(meta);
        if (allMeta.length > maxFiles) {
          throw WorkspaceError.limit("hydrateBranch: file count limit exceeded");
        }
      }
      cursor = page.cursor;
    } while (cursor);
    const seenExact = new Set;
    const seenLower = new Map;
    let totalBytes = 0;
    for (const meta of allMeta) {
      if (seenExact.has(meta.path)) {
        throw WorkspaceError.conflict(`hydrateBranch: duplicate path "${meta.path}"`);
      }
      seenExact.add(meta.path);
      const lower = meta.path.toLowerCase();
      const priorCasing = seenLower.get(lower);
      if (priorCasing !== undefined && priorCasing !== meta.path) {
        throw WorkspaceError.conflict(`hydrateBranch: case-collision between "${priorCasing}" and "${meta.path}"`);
      }
      seenLower.set(lower, meta.path);
      if (meta.byteLength > maxFileBytes) {
        throw WorkspaceError.limit(`hydrateBranch: file "${meta.path}" exceeds per-file byte limit`);
      }
      totalBytes += meta.byteLength;
      if (totalBytes > maxTotalBytes) {
        throw WorkspaceError.limit("hydrateBranch: total byte budget exceeded");
      }
    }
    const parent = nodePath.dirname(this.root);
    const base = nodePath.basename(this.root);
    const generationsDir = nodePath.join(parent, `.${base}.generations`);
    await fsp.mkdir(generationsDir, { recursive: true });
    const staging = nodePath.join(generationsDir, `gen-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(staging, { recursive: true });
    try {
      for (const meta of allMeta) {
        if (Date.now() - startedAt > maxDurationMs) {
          throw new WorkspaceError("timeout", "hydrateBranch: time budget exceeded while downloading");
        }
        const result = await this.bridge.getFile(b, { path: meta.path });
        const confirmed = this.assertResultPath(result.metadata, meta.path);
        this.verifyIntegrity(result.bytes, confirmed);
        await this.atomicWriteInto(staging, confirmed.path, result.bytes);
      }
      const baseline = allMeta.map((m) => ({
        path: m.path,
        version: m.version,
        sha256: m.sha256,
        byteLength: m.byteLength
      })).sort((x, y) => x.path.localeCompare(y.path));
      await this.hooks.beforeBaselineWrite?.();
      await this.writeBaselineInto(staging, baseline);
      await this.hooks.afterStagingComplete?.();
      await this.publishGeneration(staging);
      return { fileCount: allMeta.length, totalBytes, baseline };
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {
        return;
      });
      throw err;
    }
  }
  async syncBranch(binding, options = {}) {
    const b = validateBinding(binding);
    const maxFiles = options.maxFiles ?? 200000;
    const maxDurationMs = options.maxDurationMs ?? 10 * 60 * 1000;
    const startedAt = Date.now();
    const baseline = await this.readBaseline();
    const baselineByPath = new Map(baseline.map((e) => [e.path, e]));
    const { files: localPaths, rejected: rejectedPaths } = await this.walkLocal(maxFiles);
    const localPathSet = new Set(localPaths);
    const rejectedPathSet = new Set(rejectedPaths);
    const results = [];
    const newBaseline = [];
    let puts = 0;
    for (const relPath of rejectedPaths) {
      results.push({ path: relPath, status: "failed", error: "invalid_path" });
      const existing = baselineByPath.get(relPath);
      if (existing)
        newBaseline.push(existing);
    }
    for (const relPath of localPaths) {
      if (Date.now() - startedAt > maxDurationMs) {
        results.push({ path: relPath, status: "failed", error: "timeout" });
        const existing2 = baselineByPath.get(relPath);
        if (existing2)
          newBaseline.push(existing2);
        continue;
      }
      const abs = resolveWithinRoot(this.root, relPath);
      const bytes = new Uint8Array(await fsp.readFile(abs));
      const sha = sha256Hex(bytes);
      const existing = baselineByPath.get(relPath);
      if (existing?.sha256 === sha && existing.byteLength === bytes.byteLength) {
        results.push({ path: relPath, status: "unchanged", version: existing.version });
        newBaseline.push(existing);
        continue;
      }
      try {
        const putResult = await this.bridge.putFile(b, {
          path: relPath,
          bytes,
          expectedVersion: existing ? existing.version : EXPECT_ABSENT
        });
        const meta = this.assertResultPath(putResult.metadata, relPath);
        this.verifyPutAck(bytes, meta);
        puts += 1;
        results.push({ path: relPath, status: "uploaded", version: meta.version });
        newBaseline.push({
          path: relPath,
          version: meta.version,
          sha256: meta.sha256,
          byteLength: meta.byteLength
        });
      } catch (err) {
        const code = WorkspaceError.is(err) ? err.code : "retryable_provider";
        results.push({ path: relPath, status: "failed", error: code });
        if (existing)
          newBaseline.push(existing);
      }
    }
    for (const entry of baseline) {
      if (localPathSet.has(entry.path) || rejectedPathSet.has(entry.path)) {
        continue;
      }
      results.push({ path: entry.path, status: "failed", error: "unsupported_delete" });
      newBaseline.push(entry);
    }
    newBaseline.sort((x, y) => x.path.localeCompare(y.path));
    await this.writeBaselineInto(this.root, newBaseline);
    return { results, puts };
  }
  assertResultPath(metadata, requestedPath) {
    if (metadata.path !== requestedPath) {
      throw WorkspaceError.integrity("bridge returned metadata for a different path", metadata.version);
    }
    return metadata;
  }
  verifyPutAck(bytes, metadata) {
    if (metadata.byteLength !== bytes.byteLength) {
      throw WorkspaceError.integrity("acknowledged metadata does not match written bytes");
    }
    if (metadata.sha256 !== sha256Hex(bytes)) {
      throw WorkspaceError.integrity("acknowledged metadata does not match written bytes");
    }
    if (typeof metadata.version !== "string" || metadata.version.length === 0) {
      throw WorkspaceError.integrity("acknowledged version is malformed or empty");
    }
  }
  verifyIntegrity(bytes, metadata) {
    if (bytes.byteLength !== metadata.byteLength) {
      throw WorkspaceError.integrity("byte length mismatch against provider-confirmed metadata", metadata.version);
    }
    if (sha256Hex(bytes) !== metadata.sha256) {
      throw WorkspaceError.integrity("sha-256 mismatch against provider-confirmed metadata", metadata.version);
    }
  }
  async atomicWrite(relPosix, bytes) {
    return this.atomicWriteInto(this.root, relPosix, bytes);
  }
  async atomicWriteInto(targetRoot, relPosix, bytes) {
    const abs = resolveWithinRoot(targetRoot, relPosix);
    const dir = nodePath.dirname(abs);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = nodePath.join(dir, `.${nodePath.basename(abs)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    try {
      await fsp.writeFile(tmp, bytes, { flag: "wx" });
      await fsp.rename(tmp, abs);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {
        return;
      });
      throw err;
    }
  }
  async writeBaselineInto(targetRoot, baseline) {
    const bytes = new TextEncoder().encode(JSON.stringify(baseline));
    await this.atomicWriteInto(targetRoot, `${EZIL_DIR}/${BASELINE_FILE}`, bytes);
  }
  async readBaseline() {
    const abs = nodePath.join(this.root, EZIL_DIR, BASELINE_FILE);
    try {
      const raw = await fsp.readFile(abs, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed;
    } catch {
      return [];
    }
  }
  async publishGeneration(staging) {
    let existing = null;
    try {
      existing = await fsp.lstat(this.root);
    } catch {
      existing = null;
    }
    if (!existing) {
      await fsp.symlink(staging, this.root, "dir");
      return;
    }
    if (existing.isSymbolicLink()) {
      const oldTarget = await fsp.readlink(this.root);
      const tmpLink = `${this.root}.next-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await fsp.symlink(staging, tmpLink, "dir");
      try {
        await this.hooks.afterPointerPrepared?.();
        await this.hooks.beforePointerActivate?.();
        await fsp.rename(tmpLink, this.root);
      } catch (err) {
        await fsp.rm(tmpLink, { recursive: true, force: true }).catch(() => {
          return;
        });
        throw err;
      }
      const oldAbs = nodePath.isAbsolute(oldTarget) ? oldTarget : nodePath.resolve(nodePath.dirname(this.root), oldTarget);
      await fsp.rm(oldAbs, { recursive: true, force: true }).catch(() => {
        return;
      });
      return;
    }
    const legacyBackup = `${this.root}.legacy-${Date.now()}`;
    await fsp.rename(this.root, legacyBackup);
    try {
      await fsp.symlink(staging, this.root, "dir");
    } catch (err) {
      await fsp.rename(legacyBackup, this.root).catch(() => {
        return;
      });
      throw err;
    }
    await fsp.rm(legacyBackup, { recursive: true, force: true }).catch(() => {
      return;
    });
  }
  async walkLocal(maxFiles) {
    const out = [];
    const rejected = [];
    const stack = [""];
    while (stack.length > 0) {
      const relDir = stack.pop();
      const absDir = relDir ? resolveWithinRoot(this.root, relDir) : this.root;
      let entries;
      try {
        entries = await fsp.readdir(absDir, { withFileTypes: true });
      } catch (err) {
        if (err.code === "ENOENT" && relDir === "") {
          return { files: out, rejected };
        }
        throw err;
      }
      for (const entry of entries) {
        if (relDir === "" && entry.name === EZIL_DIR) {
          continue;
        }
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink() || entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket()) {
          rejected.push(relPath);
          continue;
        }
        if (entry.isDirectory()) {
          stack.push(relPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        out.push(relPath);
        if (out.length > maxFiles) {
          throw WorkspaceError.limit("syncBranch: file count limit exceeded");
        }
      }
    }
    return { files: out, rejected };
  }
}
// ../../packages/workspace-engine/src/http-bridge-client.ts
import { createHash as createHash2, createHmac, randomBytes } from "crypto";
var HTTP_BRIDGE_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
var HTTP_BRIDGE_REQUEST_TIMEOUT_MS = 30000;
function sha256Hex2(data) {
  return createHash2("sha256").update(data).digest("hex");
}
function bridgeAuthPayload(binding, operation, bodyHash) {
  return [
    String(binding.version),
    binding.sessionId,
    String(binding.attempt),
    binding.projectId,
    binding.branch,
    binding.operationId,
    operation,
    bodyHash
  ].join(".");
}
function defaultNonce() {
  return randomBytes(16).toString("hex");
}
function isHandlerResponse(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const v = value;
  if (typeof v.ok !== "boolean")
    return false;
  if (v.ok === false) {
    return typeof v.code === "string" && typeof v.message === "string";
  }
  return "result" in v;
}

class HttpBridgeClient {
  opts;
  fetchImpl;
  constructor(opts) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }
  async listPages(binding, req) {
    const bodyHash = sha256Hex2(JSON.stringify(req));
    return this.call("listPages", binding, req, bodyHash);
  }
  async getFile(binding, req) {
    const bodyHash = sha256Hex2(JSON.stringify(req));
    const result = await this.call("getFile", binding, req, bodyHash);
    return { metadata: result.metadata, bytes: new Uint8Array(result.bytes) };
  }
  async putFile(binding, req) {
    const bodyHash = sha256Hex2(Buffer.from(req.bytes));
    const wirePayload = { ...req, bytes: Array.from(req.bytes) };
    return this.call("putFile", binding, wirePayload, bodyHash);
  }
  async call(operation, binding, payload, bodyHash) {
    if (binding.version !== PROTOCOL_VERSION) {
      throw new WorkspaceError("stale_session", `unsupported protocol version (expected ${PROTOCOL_VERSION})`);
    }
    const now = this.opts.now?.() ?? Date.now();
    const nonce = this.opts.nonce?.() ?? defaultNonce();
    const signedPayload = `${now}.${nonce}.${bridgeAuthPayload(binding, operation, bodyHash)}`;
    const signature = createHmac("sha256", this.opts.hmacSecret).update(signedPayload).digest("hex");
    const authHeader = `t=${now},n=${nonce},v1=${signature}`;
    const body = JSON.stringify({ operation, binding, payload });
    const controller = new AbortController;
    const timeoutMs = this.opts.timeoutMs ?? HTTP_BRIDGE_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.opts.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader
        },
        body,
        redirect: "manual",
        signal: controller.signal
      });
    } catch (error) {
      const isAbort = error instanceof Error && error.name === "AbortError";
      throw new WorkspaceError(isAbort ? "timeout" : "retryable_provider", isAbort ? `${operation}: exceeded ${timeoutMs}ms client-side request budget` : `${operation}: transport request failed`);
    } finally {
      clearTimeout(timer);
    }
    if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) {
      throw new WorkspaceError("retryable_provider", `${operation}: unexpected redirect`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new WorkspaceError("retryable_provider", `${operation}: unexpected response content type`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > HTTP_BRIDGE_MAX_RESPONSE_BYTES) {
      throw new WorkspaceError("limit", `${operation}: response body exceeds the maximum allowed size`);
    }
    const rawText = await response.text();
    if (Buffer.byteLength(rawText, "utf8") > HTTP_BRIDGE_MAX_RESPONSE_BYTES) {
      throw new WorkspaceError("limit", `${operation}: response body exceeds the maximum allowed size`);
    }
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new WorkspaceError("retryable_provider", `${operation}: invalid response body`);
    }
    if (!isHandlerResponse(parsed)) {
      throw new WorkspaceError("retryable_provider", `${operation}: response did not match the expected protocol shape`);
    }
    if (!parsed.ok) {
      throw new WorkspaceError(toWorkspaceErrorCode(parsed.code), parsed.message);
    }
    return parsed.result;
  }
}
var STABLE_CODES = new Set([
  "unauthorized",
  "stale_session",
  "invalid_path",
  "conflict",
  "integrity",
  "limit",
  "timeout",
  "partial",
  "retryable_provider"
]);
function toWorkspaceErrorCode(code) {
  return isWorkspaceErrorCode(code) ? code : "retryable_provider";
}
// ../../apps/web/client/src/server/lib/workspace-bridge/workspace-startup-delivery.ts
import { randomUUID as randomUUID2 } from "crypto";

// ../../apps/web/client/src/server/lib/workspace-bridge/authorization.ts
import { AsyncLocalStorage } from "async_hooks";
var BRIDGE_AUTH_MAX_AGE_MS = 5 * 60 * 1000;
var bridgeAuthHeaderStore = new AsyncLocalStorage;

// ../../apps/web/client/src/server/lib/workspace-bridge/workspace-startup-config.ts
import { createHash as createHash3, createHmac as createHmac2, randomUUID, timingSafeEqual } from "crypto";
var CAPABILITY_KEY_DOMAIN = "ezil.workspace-startup-config.v1.capability-key";
var WORKSPACE_STARTUP_CONFIG_TTL_MS = 5 * 60 * 1000;
function deriveStartupCapabilityKey(sessionHmacSecret) {
  return createHmac2("sha256", sessionHmacSecret).update(CAPABILITY_KEY_DOMAIN).digest();
}
function canonicalCapabilityPayload(binding, configId, nonce, expiresAt) {
  return [
    String(PROTOCOL_VERSION),
    configId,
    binding.sessionId,
    String(binding.attempt),
    binding.projectId,
    binding.branch,
    binding.brokerOrigin,
    binding.brokerPath,
    nonce,
    String(expiresAt)
  ].join("\x00");
}
function signCapability(key, payload) {
  return createHmac2("sha256", key).update(payload).digest("hex");
}
function timingSafeEqualHex(a, b) {
  if (a.length !== b.length)
    return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}
function verifyWorkspaceStartupConfig(config, expected, sessionHmacSecret, now = Date.now()) {
  if (!isWorkspaceStartupConfigV1(config)) {
    return { ok: false, reason: "malformed" };
  }
  if (config.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, reason: "unsupported_version" };
  }
  if (now >= config.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  if (config.sessionId !== expected.sessionId) {
    return { ok: false, reason: "session_mismatch" };
  }
  if (config.attempt !== expected.attempt) {
    return { ok: false, reason: "attempt_mismatch" };
  }
  if (config.projectId !== expected.projectId) {
    return { ok: false, reason: "project_mismatch" };
  }
  if (config.branch !== expected.branch) {
    return { ok: false, reason: "branch_mismatch" };
  }
  if (config.brokerOrigin !== expected.brokerOrigin) {
    return { ok: false, reason: "origin_mismatch" };
  }
  if (config.brokerPath !== expected.brokerPath) {
    return { ok: false, reason: "path_mismatch" };
  }
  const key = deriveStartupCapabilityKey(sessionHmacSecret);
  const payload = canonicalCapabilityPayload(expected, config.configId, config.nonce, config.expiresAt);
  const expectedCapability = signCapability(key, payload);
  if (!timingSafeEqualHex(expectedCapability, config.capability)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true };
}
function isWorkspaceStartupConfigV1(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const v = value;
  return typeof v.protocolVersion === "number" && typeof v.configId === "string" && v.configId.length > 0 && typeof v.sessionId === "string" && v.sessionId.length > 0 && typeof v.attempt === "number" && Number.isInteger(v.attempt) && v.attempt >= 1 && typeof v.projectId === "string" && v.projectId.length > 0 && typeof v.branch === "string" && v.branch.length > 0 && typeof v.brokerOrigin === "string" && v.brokerOrigin.length > 0 && typeof v.brokerPath === "string" && v.brokerPath.length > 0 && typeof v.expiresAt === "number" && Number.isFinite(v.expiresAt) && typeof v.nonce === "string" && v.nonce.length > 0 && typeof v.capability === "string" && v.capability.length > 0;
}

// ../../apps/web/client/src/server/lib/workspace-bridge/workspace-startup-delivery.ts
function loadBridgeClientFromStartupDelivery(delivery, options = {}) {
  if (!isSealedWorkspaceStartupDelivery(delivery)) {
    return { ok: false, reason: "malformed_envelope" };
  }
  const { config, requestCapability } = delivery;
  const expected = {
    sessionId: config.sessionId,
    attempt: config.attempt,
    projectId: config.projectId,
    branch: config.branch,
    brokerOrigin: config.brokerOrigin,
    brokerPath: config.brokerPath
  };
  const now = options.now?.() ?? Date.now();
  const verified = verifyWorkspaceStartupConfig(config, expected, requestCapability, now);
  if (!verified.ok) {
    return { ok: false, reason: verified.reason };
  }
  const baseUrl = joinBrokerBaseUrl(config.brokerOrigin, config.brokerPath);
  const bridge = new HttpBridgeClient({
    baseUrl,
    hmacSecret: requestCapability,
    fetchImpl: options.fetchImpl,
    now: options.clientNow,
    nonce: options.clientNonce
  });
  const bindingContext = {
    newBinding(ids) {
      return {
        version: PROTOCOL_VERSION,
        sessionId: config.sessionId,
        attempt: config.attempt,
        projectId: config.projectId,
        branch: config.branch,
        correlationId: ids?.correlationId ?? randomUUID2(),
        operationId: ids?.operationId ?? randomUUID2()
      };
    }
  };
  return { ok: true, bridge, bindingContext };
}
function joinBrokerBaseUrl(brokerOrigin, brokerPath) {
  const origin = brokerOrigin.replace(/\/+$/, "");
  const path = brokerPath.startsWith("/") ? brokerPath : `/${brokerPath}`;
  return `${origin}${path}`;
}
function isSealedWorkspaceStartupDelivery(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const v = value;
  return typeof v.requestCapability === "string" && v.requestCapability.length > 0 && isWorkspaceStartupConfigV1(v.config);
}

// ../../apps/web/client/src/server/lib/workspace-bridge/workspace-startup-path.ts
var DEFAULT_WORKSPACE_ROOT = "/home/neko/project";
async function runWorkspaceStartup(delivery, options = {}) {
  const loaded = loadBridgeClientFromStartupDelivery(delivery, options);
  if (!loaded.ok) {
    return { ok: false, reason: loaded.reason };
  }
  const root = options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const engine2 = options.engineFactory ? options.engineFactory({ root, bridge: loaded.bridge }) : new WorkspaceEngine({ root, bridge: loaded.bridge });
  const binding = loaded.bindingContext.newBinding();
  let hydrate;
  try {
    hydrate = await engine2.hydrateBranch(binding, options.hydrateOptions);
  } catch {
    return { ok: false, reason: "hydrate_failed" };
  }
  const handle = {
    engine: engine2,
    bridge: loaded.bridge,
    bindingContext: loaded.bindingContext,
    workspaceRoot: root,
    vscodeTargetRoot: root,
    hydrate,
    triggerSync(syncOptions) {
      return engine2.syncBranch(binding, syncOptions ?? options.syncOptions);
    }
  };
  await options.signalReady?.({
    workspaceRoot: root,
    vscodeTargetRoot: root,
    hydrate
  });
  return { ok: true, handle };
}
function parseStartupDeliveryEnvelope(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isSealedWorkspaceStartupDelivery(parsed)) {
    return null;
  }
  return parsed;
}

// ../../apps/web/client/src/server/lib/workspace-bridge/workspace-bootstrap.ts
var WORKSPACE_STARTUP_DELIVERY_ENV = "EZIL_WORKSPACE_STARTUP_DELIVERY";
var WORKSPACE_ROOT_ENV = "EZIL_WORKSPACE_ROOT";
var WORKSPACE_READY_MARKER_ENV = "EZIL_WORKSPACE_READY_MARKER";
var DEFAULT_WORKSPACE_READY_MARKER = "/run/ezil/workspace-ready.json";
async function runWorkspaceBootstrap(deps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const runStartup = deps.runStartup ?? defaultRunStartup;
  const writeReadyMarker = deps.writeReadyMarker ?? defaultWriteReadyMarker;
  const workspaceRoot = env[WORKSPACE_ROOT_ENV]?.trim() || DEFAULT_WORKSPACE_ROOT;
  const markerPath = env[WORKSPACE_READY_MARKER_ENV]?.trim() || DEFAULT_WORKSPACE_READY_MARKER;
  const raw = env[WORKSPACE_STARTUP_DELIVERY_ENV];
  if (typeof raw !== "string" || raw.length === 0) {
    log("workspace.bootstrap.delivery", { stage: "read_env", outcome: "missing_delivery" });
    return { ok: false, reason: "missing_delivery" };
  }
  const delivery = parseStartupDeliveryEnvelope(raw);
  if (!delivery) {
    log("workspace.bootstrap.delivery", { stage: "parse_envelope", outcome: "malformed_envelope" });
    return { ok: false, reason: "malformed_envelope" };
  }
  let startup;
  try {
    startup = await runStartup(delivery, {
      workspaceRoot,
      fetchImpl: deps.fetchImpl,
      signalReady: async (info) => {
        const marker2 = {
          ready: true,
          workspaceRoot: info.workspaceRoot,
          vscodeTargetRoot: info.vscodeTargetRoot,
          hydratedAt: new Date(now()).toISOString()
        };
        await writeReadyMarker(markerPath, marker2);
      }
    });
  } catch {
    log("workspace.bootstrap.delivery", { stage: "startup", outcome: "startup_failed" });
    return { ok: false, reason: "startup_failed" };
  }
  if (!startup.ok) {
    log("workspace.bootstrap.delivery", {
      stage: "startup",
      outcome: "startup_failed",
      reason: startup.reason
    });
    return { ok: false, reason: "startup_failed", startupReason: startup.reason };
  }
  const marker = {
    ready: true,
    workspaceRoot: startup.handle.workspaceRoot,
    vscodeTargetRoot: startup.handle.vscodeTargetRoot,
    hydratedAt: new Date(now()).toISOString()
  };
  log("workspace.bootstrap.delivery", {
    stage: "ready",
    outcome: "ok",
    workspaceRoot: startup.handle.workspaceRoot
  });
  return {
    ok: true,
    workspaceRoot: startup.handle.workspaceRoot,
    vscodeTargetRoot: startup.handle.vscodeTargetRoot,
    marker
  };
}
function defaultRunStartup(delivery, options) {
  return runWorkspaceStartup(delivery, {
    workspaceRoot: options.workspaceRoot,
    fetchImpl: options.fetchImpl,
    signalReady: options.signalReady
  });
}
async function defaultWriteReadyMarker(path, marker) {
  const { mkdir, writeFile, rename } = await import("fs/promises");
  const { dirname: dirname2 } = await import("path");
  await mkdir(dirname2(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(marker)}
`, { encoding: "utf8", mode: 384 });
  await rename(tmp, path);
}

// bootstrap/workspace-bootstrap-entry.ts
async function main() {
  const result = await runWorkspaceBootstrap({
    log: (event, fields) => {
      process.stderr.write(`[workspace-bootstrap] ${event} ${JSON.stringify(fields)}
`);
    }
  });
  if (!result.ok) {
    process.stderr.write(`[workspace-bootstrap] fail-closed reason=${result.reason}` + (result.startupReason ? ` startupReason=${result.startupReason}` : "") + `
`);
    process.exit(1);
    return;
  }
  process.stderr.write(`[workspace-bootstrap] ready workspaceRoot=${result.workspaceRoot} ` + `vscodeTargetRoot=${result.vscodeTargetRoot}
`);
  process.stdout.write(`${result.vscodeTargetRoot}
`);
  process.exit(0);
}
main().catch((err) => {
  process.stderr.write(`[workspace-bootstrap] fail-closed unexpected_error=${err instanceof Error ? err.name : "unknown"}
`);
  process.exit(1);
});
