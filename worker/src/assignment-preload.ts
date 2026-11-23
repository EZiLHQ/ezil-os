import { OS_PRODUCTION_AI_GATEWAY_ORIGIN, repoOpenRemotesFor, type RepoOpenExec, type RepoOpenRequest } from './repo-open';
import { ASSIGNMENT_PRELOAD_B64 } from './repo-open-runtime.generated';

export const ASSIGNMENT_PRELOAD_PORT = 5679;
export const ASSIGNMENT_PRELOAD_TIMEOUT_MS = 2_000;

const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export interface AssignmentPreloadWitness {
  eventId: string;
  attemptId: string;
  ownerSha256: string;
  canonicalURL: string;
  repositoryId: string;
  ref: 'refs/heads/main';
  manifestSha256: string;
}

export function splitAssignmentPreload(body: Record<string, unknown>): {
  repoBody: Record<string, unknown>;
  preload: unknown;
} {
  if (!Object.hasOwn(body, 'assignmentPreload')) return { repoBody: body, preload: undefined };
  const { assignmentPreload, ...repoBody } = body;
  return { repoBody, preload: assignmentPreload };
}

async function sha256(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Call only after the normal sandbox-bound, signed v2 route authenticates the request bytes. */
export async function authorizeAssignmentPreload(
  input: unknown, request: RepoOpenRequest, env: { EZIL_AI_GATEWAY_URL?: unknown; EZIL_PRODUCTION_ASSIGNMENT_PRELOAD?: string }, controlOrigin: string,
): Promise<{ witness: AssignmentPreloadWitness; nonce: string } | null> {
  const packet = request.privatePacket;
  const enabled = env.EZIL_PRODUCTION_ASSIGNMENT_PRELOAD === '1'
    ? controlOrigin === 'https://api-desktop.ezil.org' &&
      (env.EZIL_AI_GATEWAY_URL === OS_PRODUCTION_AI_GATEWAY_ORIGIN ||
       env.EZIL_AI_GATEWAY_URL === OS_PRODUCTION_AI_GATEWAY_ORIGIN + '/')
    : repoOpenRemotesFor(env).stagingGitQa === true;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'attemptId,eventId,manifestSha256,nonce'
    || !enabled || !packet || packet.git.scope !== 'write'
    || request.refreshOnly || request.ref !== 'refs/heads/main') return null;

  const { eventId, attemptId, nonce, manifestSha256 } = input as Record<string, unknown>;
  if (typeof eventId !== 'string' || !UUID_V4.test(eventId)
    || typeof attemptId !== 'string' || !UUID.test(attemptId)
    || typeof nonce !== 'string' || !HEX.test(nonce)
    || typeof manifestSha256 !== 'string' || !HEX.test(manifestSha256)) return null;

  const ownerSha256 = await sha256(packet.identity.subject);
  const expected = `https://github.ezil.work/default/u-${ownerSha256.slice(0, 16)}-a-${attemptId}.git`;
  if (request.canonicalURL !== expected) return null;

  // Same deterministic checkout identifier as app/src/server/git/repo-url.ts.
  const id = (await sha256(`ezil-os/repo-url/v1|${expected}`)).slice(0, 32).split('');
  id[12] = '8';
  id[16] = '89ab'[parseInt(id[16]!, 16) & 3]!;
  const hex = id.join('');
  const folderId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (request.repositoryId !== folderId) return null;

  return {
    witness: {
      eventId, attemptId, ownerSha256, canonicalURL: expected, repositoryId: request.repositoryId,
      ref: request.ref, manifestSha256,
    },
    nonce,
  };
}

function shq(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** A signed open's optional, one-shot notification in the already-running computer. */
export async function notifyAssignmentPreload(
  exec: RepoOpenExec, checkout: string, witness: AssignmentPreloadWitness,
): Promise<boolean> {
  const loader = `import base64;exec(compile(base64.b64decode('${ASSIGNMENT_PRELOAD_B64}'),'assignment-preload.py','exec'))`;
  const basename = witness.canonicalURL.slice(witness.canonicalURL.lastIndexOf('/') + 1, -4);
  if (!checkout.endsWith('/projects/' + witness.repositoryId + '/' + basename)) return false;
  const command = `python3 -I -c ${shq(loader)} ${shq(checkout)} ${shq(JSON.stringify(witness))}`;
  try {
    const result = await exec(command, { env: {}, timeout: ASSIGNMENT_PRELOAD_TIMEOUT_MS, origin: 'internal' });
    return result.exitCode === 0 && result.stdout?.trim() === 'ezil-assignment-preload:ack';
  } catch {
    return false;
  }
}

/** Never send a reserved preload port host or a code-server path to their proxy. */
export function isAssignmentPreloadForward(url: URL, codeHost: boolean): boolean {
  const port = url.hostname.split('.')[0]?.match(/^(?:aws-)?(\d+)-/);
  if (port && Number(port[1]) === ASSIGNMENT_PRELOAD_PORT) return true;
  if (!codeHost) return false;
  try {
    const path = decodeURIComponent(url.pathname).replace(/\\/g, '/');
    const match = /^\/(?:preview(?:-ws)?\/+)?(?:absproxy|proxy)\/+(\d+)(?:\/|$)/.exec(path);
    return !!match && Number(match[1]) === ASSIGNMENT_PRELOAD_PORT;
  } catch {
    return false;
  }
}
