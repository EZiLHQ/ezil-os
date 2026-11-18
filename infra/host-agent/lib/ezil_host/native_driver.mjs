// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Thin public driver for one native runtime. Runs as the dedicated native service UID, inside the
 * runtime's own network namespace and cgroup (started by native_session.py, never by a request).
 *
 * It contains no private logic: it imports the operator-installed, hash-verified private Core
 * (`createSupervisor` from gatewayNativeSupervisor.mjs, `openJournal` from gatewayNativeJournal.mjs,
 * the exact exports of the parent package) from the directory named in the bootstrap frame, and
 * adapts Core's injected interfaces to the root manager over ONE inherited descriptor:
 *
 *   FD 3: a SOCK_STREAM socketpair to the root manager. Newline-delimited JSON frames, each at most
 *         FRAME_LIMIT (131072) bytes including the newline, both directions; the first frame is the
 *         root's `bootstrap`.
 *   FDs 0-2: /dev/null. No other descriptor is inherited; nothing is read from argv or env.
 *
 * Driver -> root:  {"id":n,"rpc":<name>,...}   (authority.check, permits.acquire, permits.release,
 *                                               isolation.prepare, isolation.verify,
 *                                               isolation.terminate, isolation.reap)
 *                  {"event":<name>,...}        (started, accepted, failed, closed)
 * Root -> driver:  {"type":"bootstrap",...} once, then {"id":n,"result":{...}}.
 *
 * Isolation.spawn: Core calls it synchronously and needs a child with a pid and stdio at once, but
 * the CLI container can only be created by the root manager after Core's durable spawn gate.
 * Until the parent's asynchronous spawn seam exists it is a typed refusal
 * (`isolation_spawn_pending_parent`): Core records the attempt and the root fences the runtime.
 * The CLI is never started during prepare.
 */
import net from 'node:net';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Root freeze: the total native request AND reply wrapper is at most 131072 bytes on every hop.
export const FRAME_LIMIT = 131072;
export const RPC_REQUEST_LIMIT = FRAME_LIMIT;
const RPC_TIMEOUT_MS = 35_000;
const ACCEPT_TIMEOUT_MS = 60_000;
const RPCS = new Set(['authority.check', 'permits.acquire', 'permits.release', 'isolation.prepare', 'isolation.verify',
  'isolation.terminate', 'isolation.reap', 'isolation.spawn', 'isolation.captureIdentity', 'authority.verifyRuntimeIdentity', 'authority.checkRead', 'authority.checkControl', 'authority.verifyFence']);
const BOOT_KEYS = ['type', 'coreDir', 'stateRoot', 'hostEpoch', 'principal', 'sessionRef', 'binding', 'cli', 'requestId', 'instruction'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const blocked = code => Object.assign(new Error(code), { code, blocked: true });

/** Frame codec over a duplex stream. Oversize frames end the channel; nothing is clipped. */
export function channel(stream, onFrame, onClose) {
  let buffer = Buffer.alloc(0), closed = false;
  const close = why => { if (!closed) { closed = true; stream.destroy(); onClose(why); } };
  stream.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let at = buffer.indexOf(10); at >= 0; at = buffer.indexOf(10)) {
      if (at + 1 > FRAME_LIMIT) return close('frame_too_large');
      const line = buffer.subarray(0, at);
      buffer = buffer.subarray(at + 1);
      let frame;
      try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { return close('frame_invalid'); }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return close('frame_invalid');
      onFrame(frame);
    }
    if (buffer.length >= FRAME_LIMIT) close('frame_too_large');
  });
  stream.on('close', () => close('eof'));
  stream.on('error', () => close('error'));
  return {
    send(frame, limit = FRAME_LIMIT) {
      const data = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
      if (data.length > limit) throw blocked('frame_too_large');
      if (!closed) stream.write(data);
    },
    close,
  };
}

/** The adapters Core is constructed with. Every decision is the root manager's. */
export function adapters(rpc, boot) {
  let runtimeId = null, child = null;
  const ask = async (name, body) => {
    const result = await rpc(name, body);
    if (!result || typeof result !== 'object') throw blocked('root_reply_invalid');
    return result;
  };
  return {
    authority: {
      // The binding comes only from the root's bootstrap, for exactly its principal/session.
      async resolve({ principal, sessionRef }) {
        if (principal !== boot.principal || sessionRef !== boot.sessionRef) return null;
        return boot.binding;
      },
      async check(binding, options) { return ask('authority.check', { runtimeId: options?.runtimeId ?? null }); },
      async checkRead(input) { return ask('authority.checkRead', { runtimeId: input.runtimeId, requestScope: input.requestScope ?? null }); },
      async checkControl(input) { return ask('authority.checkControl', { runtimeId: input.runtimeId, requestScope: input.requestScope, action: input.action }); },
      async verifyRuntimeIdentity({ runtimeId: id, receipt }) { return ask('authority.verifyRuntimeIdentity', { runtimeId: id, receipt }); },
      async verifyFence({ runtime, receipt }) { return ask('authority.verifyFence', { runtimeId, runtime, receipt }); },
      async verifyIsolation({ runtimeId: id, receipt }) { return ask('isolation.verify', { runtimeId: id, receipt }); },
    },
    permits: {
      async acquire({ runtimeId: id }) { return ask('permits.acquire', { runtimeId: id }); },
      async release({ permitId, runtimeId: id }) { return ask('permits.release', { permitId, runtimeId: id }); },
    },
    isolation: {
      // Core mints the runtime UUID before prepare; the root adopts exactly that UUID here.
      async prepare({ runtimeId: id }) {
        if (typeof id !== 'string' || !UUID.test(id) || (runtimeId && runtimeId !== id)) throw blocked('runtime_id_invalid');
        const result = await ask('isolation.prepare', { runtimeId: id });
        if (result.ok !== true || !result.receipt) throw blocked(typeof result.code === 'string' ? result.code : 'isolation_unverified');
        runtimeId = id;
        return result.receipt;
      },
      async spawn(receipt, options) {
        const result = await ask('isolation.spawn', { runtimeId, receipt, options });
        if (result.ok !== true || !Number.isSafeInteger(result.pid)) throw blocked(result.code ?? 'spawn_unconfirmed');
        child = new EventEmitter();
        Object.assign(child, { pid: result.pid, exitCode: null, signalCode: null,
          stdin: fs.createWriteStream(null, { fd: 4, autoClose: false }),
          stdout: fs.createReadStream(null, { fd: 5, autoClose: false }), stderr: fs.createReadStream(null, { fd: 6, autoClose: false }) });
        return { child };
      },
      async captureIdentity() {
        const result = await ask('isolation.captureIdentity', { runtimeId });
        if (!result.ok) throw blocked(result.code ?? 'runtime_identity_unverified');
        return result.identity;
      },
      terminate(handle, signal) { rpc('isolation.terminate', { runtimeId, signal: signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM' }).catch(() => {}); },
      async reap(handle, context) {
        const result = await ask('isolation.reap', { runtimeId, runtime: context?.runtime ?? null }).catch(() => ({ fenced: false }));
        return result;
      },
    },
    exited(code, signal) { if (child && child.exitCode === null && child.signalCode === null) {
      child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal);
    } },
    get runtimeId() { return runtimeId; },
  };
}

export function validBootstrap(boot) {
  return Boolean(boot) && Object.keys(boot).length === BOOT_KEYS.length && BOOT_KEYS.every(k => Object.hasOwn(boot, k))
    && boot.type === 'bootstrap' && typeof boot.coreDir === 'string' && path.isAbsolute(boot.coreDir)
    && typeof boot.stateRoot === 'string' && path.isAbsolute(boot.stateRoot) && typeof boot.hostEpoch === 'string'
    && typeof boot.principal === 'string' && typeof boot.sessionRef === 'string' && UUID.test(boot.requestId)
    && typeof boot.instruction === 'string' && boot.binding && typeof boot.binding === 'object' && boot.cli && typeof boot.cli === 'object';
}

export async function run({ stream, importCore = dir => Promise.all([
  import(pathToFileURL(path.join(dir, 'gatewayNativeSupervisor.mjs')).href),
  import(pathToFileURL(path.join(dir, 'gatewayNativeJournal.mjs')).href),
  import(pathToFileURL(path.join(dir, 'gatewayNativeContract.mjs')).href)]), now = () => new Date() }) {
  const pending = new Map();
  let next = 1, boot = null, bootResolve, adapter = null, runtimeAbi = null;
  const booted = new Promise(resolve => { bootResolve = resolve; });
  const ch = channel(stream, frame => {
    if (!boot && frame.type === 'bootstrap') { boot = frame; return bootResolve(frame); }
    if (frame.event === 'cli_exit') { adapter?.exited(frame.code ?? null, frame.signal ?? null); return; }
    if (frame.type === 'runtime_rpc') {
      (async () => {
        try {
          const q = frame.request, input = { principal: boot.principal, requestScope: q.scope };
          let result;
          if (!runtimeAbi) throw blocked('core_api_unavailable');
          if (q.action === 'read') result = await runtimeAbi.read({ ...input, cursor: q.payload.cursor, limit: q.payload.limit });
          else if (q.action === 'prompt_get') result = await runtimeAbi.getPrompt({ ...input, promptId: q.payload.promptId });
          else if (q.action === 'request_get') result = await runtimeAbi.getRequest({ ...input, requestId: q.rootRequestId });
          else if (q.action === 'send') result = await runtimeAbi.submit({ ...input, requestId: q.rootRequestId, requestDigest: q.requestDigest, instruction: q.payload.instruction });
          else if (q.action === 'answer') result = await runtimeAbi.decide({ ...input, requestId: q.rootRequestId, ...q.payload });
          else if (q.action === 'cancel') result = await runtimeAbi.cancel({ ...input, requestId: q.rootRequestId, targetRequestId: q.payload.targetRequestId });
          else throw blocked('runtime_action_invalid');
          ch.send({ event: 'runtime_result', id: frame.id, ok: true, result });
        } catch (e) { ch.send({ event: 'runtime_result', id: frame.id, ok: false, code: /^[a-z][a-z0-9_]{0,63}$/.test(e?.code ?? '') ? e.code : 'runtime_unavailable' }); }
      })(); return;
    }
    const waiter = pending.get(frame.id);
    if (waiter && frame.result && typeof frame.result === 'object') { pending.delete(frame.id); waiter.resolve(frame.result); }
  }, why => { for (const w of pending.values()) w.reject(blocked(`root_channel_${why}`)); pending.clear(); bootResolve(null); });
  const rpc = (name, body) => new Promise((resolve, reject) => {
    if (!RPCS.has(name)) return reject(blocked('rpc_unknown'));
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(blocked('rpc_timeout')); }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    try { ch.send({ id, rpc: name, ...body }, RPC_REQUEST_LIMIT); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
  const event = frame => { try { ch.send(frame); } catch { /* the root fences on silence */ } };

  const frame = await booted;
  if (!validBootstrap(frame)) { event({ event: 'failed', code: 'bootstrap_invalid' }); return ch.close('bootstrap_invalid'); }
  const instruction = frame.instruction;
  frame.instruction = '';
  let supervisor;
  try {
    const [{ createSupervisor, createRuntimeCoreAbi, createInstalledCliWire }, { openJournal }, { privateDirectory }] = await importCore(frame.coreDir);
    if (typeof createSupervisor !== 'function' || typeof openJournal !== 'function' || typeof privateDirectory !== 'function') throw blocked('core_api_unavailable');
    const a = adapter = adapters(rpc, frame);
    const journalRoot = await privateDirectory(path.join(frame.stateRoot, 'journal'), { create: true });
    const journal = openJournal(journalRoot, { now });
    supervisor = createSupervisor({ journal, authority: a.authority, permits: a.permits, cli: frame.cli, stateRoot: frame.stateRoot,
      hostEpoch: frame.hostEpoch, isolation: a.isolation, wire: createInstalledCliWire({ cli: frame.cli }), now });
    if (typeof createRuntimeCoreAbi !== 'function') throw blocked('core_api_unavailable');
    runtimeAbi = createRuntimeCoreAbi({ supervisor, journal, authority: a.authority, now });
    await supervisor.start({ principal: frame.principal, sessionRef: frame.sessionRef });
    event({ event: 'started', runtimeId: a.runtimeId, policyDigest: journal.runtime(a.runtimeId)?.policyDigest ?? null });
    const op = await supervisor.submit({ principal: frame.principal, sessionRef: frame.sessionRef, requestId: frame.requestId, instruction });
    // ACK only on Core's own record of the exact SDK echo: the private operation's userUuid and acceptedAt.
    const deadline = Date.now() + ACCEPT_TIMEOUT_MS;
    for (;;) {
      const record = journal.operation(op.operationId);
      if (record?.acceptedAt && UUID.test(record.userUuid ?? '')) {
        event({ event: 'accepted', runtimeId: a.runtimeId, sessionId: frame.binding.sessionId, userUuid: record.userUuid,
          acceptedAt: record.acceptedAt });
        break;
      }
      if (Date.now() > deadline || ['blocked', 'failed', 'unknown', 'cancelled'].includes(record?.state)) throw blocked('accept_unconfirmed');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) {
    event({ event: 'failed', code: typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : 'driver_failed' });
    await supervisor?.close().catch(() => {});
    return ch.close('failed');
  }
  return { supervisor, close: () => ch.close('closed') };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run({ stream: new net.Socket({ fd: 3, readable: true, writable: true }) }).catch(() => process.exit(70));
}
