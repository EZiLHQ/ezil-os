/**
 * The u2 repo-open protocol module (worker/src/repo-open-u2.ts), contract universe-repo-open-v1 1.0.4:
 *
 *  - constants, regexes, the refusal table and both answer shapes against the vectors;
 *  - the strict §8 body for a ROUTE class: every vectors body mutation (valid under its own class and
 *    refused under the other; invalid under both), the closed class → git-host table in both
 *    directions (no union allow-list), and class values that are not a class;
 *  - the module boundary: it imports nothing and only the AWS relay imports it.
 */
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ASSESSMENT_CLONE_DIR, ASSESSMENT_OPEN_RESULT_KEYS, ASSESSMENT_OPEN_RESULT_STATES, ASSESSMENT_PROJECTS_DIR, BRANCH_RE, GRANT_RE,
  HANDLE_RE, HEAD_RE, NAME_RE, OPEN_RESULT_KEYS, OPEN_RESULT_STATES, REPO_OPEN_CLASSES, REPO_OPEN_CLASS_DEFAULT,
  REPO_OPEN_CLASS_GIT_HOSTS, REPO_OPEN_PROJECT_GIT_HOSTS, REPO_OPEN_PROJECT_GRANT_MAX_MS, REPO_OPEN_STATUS, UUID_RE,
  WORKER_ACCEPT_EXPIRY_MAX_MS, WORKER_DEADLINE_MS, WORKER_REQUEST_MAX_BYTES,
  assessmentEditorRoot, assessmentRemoteUrl, isRepoOpenClass, isWrappedClass, parseRepoOpenBody, refusal, repoOpenResponse, validBranch, validName,
  type RepoOpenClass, type RepoOpenErrorCode,
} from './repo-open-u2';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const VECTORS_BYTES = readFileSync(here('../../docs/contracts/universe-repo-open-v1.vectors.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(VECTORS_BYTES.toString('utf8'));
const C = V.constants, T = V.timeouts, W = V.errorTable.workerResponses;
const NOW = V.fixtures.nowMs as number;
const QA = C.GIT_ASSESSMENT_HOST as string;
const PREVIEW = V.workerRequest.base.gitHost as string;
const expand = (s: string) => String(s).replace(/\$\{repeat:(.):(\d+)\}/g, (_, c: string, n: string) => c.repeat(Number(n)));

/** vectors workerRequest.base with `relativeSeconds` made absolute against `now`. */
function materialise(value: unknown, now: number): unknown {
  if (Array.isArray(value)) return value.map((v) => materialise(v, now));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if ('relativeSeconds' in o) return new Date(now + Number(o.relativeSeconds) * 1000).toISOString();
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, materialise(v, now)]));
  }
  return typeof value === 'string' ? expand(value) : value;
}
/** 1.0.4: a project row names the route's host (projectGitHost); layer 'worker' rows are refused by the Worker only. */
type Mutation = { set?: Record<string, unknown>; setGrant?: Record<string, unknown>; projectGitHost?: string; layer?: string; why?: string };
function mutate(m: Mutation, now: number) {
  const copy = structuredClone(V.workerRequest.base);
  if (m.set) Object.assign(copy, m.set);
  if (m.setGrant) Object.assign(copy.grant, m.setGrant);
  return materialise(copy, now) as Record<string, unknown>;
}
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const baseBody = (now: number, patch: Record<string, unknown> = {}, grant: Record<string, unknown> = {}) => {
  const b = materialise(V.workerRequest.base, now) as Record<string, unknown> & { grant: Record<string, unknown> };
  return { ...b, ...patch, grant: { ...b.grant, ...grant } };
};
/** The class a vectors mutation's body claims (absent = the default). */
const claimed = (m: Mutation): RepoOpenClass => (m.set && 'class' in m.set ? m.set.class : REPO_OPEN_CLASS_DEFAULT) as RepoOpenClass;
const others = (c: RepoOpenClass): RepoOpenClass[] => REPO_OPEN_CLASSES.filter((x) => x !== c);
const parses = (body: unknown, routeClass: RepoOpenClass, projectGitHost?: string) =>
  parseRepoOpenBody(enc(body), NOW, routeClass, { projectGitHost }) !== null;

// ── constants ───────────────────────────────────────────────────────────────

describe('u2 protocol constants equal the vectors (1.0.4)', () => {
  it('vectors are the pinned 1.0.4 file', () => {
    expect(createHash('sha256').update(VECTORS_BYTES).digest('hex')).toBe('092d76d10018156d585424caee993ad6cac3ce56c52f5fee74f56917e60e92ff');
    expect(V.contractVersion).toBe('1.0.4');
  });

  it('timeouts, limits and regexes', () => {
    expect([WORKER_DEADLINE_MS, WORKER_ACCEPT_EXPIRY_MAX_MS]).toEqual([T.WORKER_DEADLINE_MS, T.WORKER_ACCEPT_EXPIRY_MAX_MS]);
    expect(WORKER_REQUEST_MAX_BYTES).toBe(C.BODY_LIMITS_BYTES.workerRequest);
    for (const [name, re] of Object.entries({ UUID_RE, HANDLE_RE, NAME_RE, BRANCH_RE, GRANT_RE })) expect(re.source).toBe(V.regex[name].source);
  });

  it('the class table is the vectors closed table, frozen; its personal entry is the class-absent gitHostAllowList', () => {
    expect([...REPO_OPEN_CLASSES]).toEqual(C.REPO_OPEN_CLASSES);
    expect(REPO_OPEN_CLASS_DEFAULT).toBe(C.REPO_OPEN_CLASS_DEFAULT);
    expect({ ...REPO_OPEN_CLASS_GIT_HOSTS }).toEqual(C.REPO_OPEN_CLASS_GIT_HOSTS);
    expect(REPO_OPEN_CLASS_GIT_HOSTS.assessment).toBe(QA);
    expect([REPO_OPEN_CLASS_GIT_HOSTS.personal]).toEqual(V.workerRequest.gitHostAllowList);
    expect(V.workerRequest.optionalKeys).toEqual(['class']);
    expect(Object.isFrozen(REPO_OPEN_CLASS_GIT_HOSTS) && Object.isFrozen(REPO_OPEN_CLASSES)).toBe(true);
    // One host per single-host class, and no host serves two of them; project is the one class without an entry (1.0.4).
    expect(Object.keys(REPO_OPEN_CLASS_GIT_HOSTS)).toEqual(REPO_OPEN_CLASSES.filter((c) => c !== 'project'));
    expect(new Set(Object.values(REPO_OPEN_CLASS_GIT_HOSTS)).size).toBe(Object.keys(REPO_OPEN_CLASS_GIT_HOSTS).length);
  });

  it('isRepoOpenClass is the closed list: inherited names, case variants and non-strings are not classes', () => {
    for (const c of REPO_OPEN_CLASSES) expect(isRepoOpenClass(c)).toBe(true);
    for (const v of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'Assessment', 'PERSONAL', 'exam', '', ' personal',
      null, undefined, 0, 1, true, ['assessment'], { personal: true }]) {
      expect(isRepoOpenClass(v)).toBe(false);
    }
  });

  it('the refusal table equals the vectors table, and refusal bodies carry only the code', () => {
    const fromVectors: Record<string, number> = {};
    for (const r of W.refusals) for (const e of r.error) fromVectors[e] = r.status;
    expect({ ...REPO_OPEN_STATUS }).toEqual(fromVectors);
    for (const code of Object.keys(REPO_OPEN_STATUS) as RepoOpenErrorCode[]) {
      expect(refusal(code)).toEqual({ status: REPO_OPEN_STATUS[code], body: { ok: false, error: code } });
    }
  });

  it('answer shapes equal okOpen and okOpenAssessment (and the kernel result keys); a head is 40 lowercase hex', () => {
    expect([...OPEN_RESULT_KEYS]).toEqual(W.okOpen.keys);
    expect([...OPEN_RESULT_KEYS]).toEqual(V.kernel.resultOpenKeys);
    expect([...OPEN_RESULT_STATES]).toEqual(W.okOpen.states);
    expect([...ASSESSMENT_OPEN_RESULT_KEYS]).toEqual(W.okOpenAssessment.keys);
    expect([...ASSESSMENT_OPEN_RESULT_KEYS]).toEqual(V.kernel.assessment.resultOpenKeys);
    expect([...ASSESSMENT_OPEN_RESULT_STATES]).toEqual(W.okOpenAssessment.states);
    expect([...ASSESSMENT_OPEN_RESULT_STATES]).toEqual(V.kernel.assessment.states);
    expect(ASSESSMENT_OPEN_RESULT_STATES).not.toContain('existing' as never);
    expect(HEAD_RE.test('a'.repeat(40)) && HEAD_RE.test('0123456789abcdef0123456789abcdef01234567')).toBe(true);
    for (const bad of ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(64), `${'a'.repeat(40)}\n`, `g${'a'.repeat(39)}`]) {
      expect(HEAD_RE.test(bad)).toBe(false);
    }
  });

  it('repoOpenResponse answers the body only, as JSON, never cached', async () => {
    const res = repoOpenResponse(refusal('folder_conflict'));
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: false, error: 'folder_conflict' });
  });
});

// ── body ────────────────────────────────────────────────────────────────────

describe('strict §8 body for a route class (vectors workerRequest, classRule)', () => {
  it('the base parses for the personal route and is refused for the assessment route', () => {
    const base = materialise(V.workerRequest.base, NOW);
    expect(parses(base, 'personal')).toBe(true);
    expect(parses(base, 'assessment')).toBe(false);
  });

  it('every valid mutation parses for the class it claims and is refused for the other class', () => {
    const claimedClasses = new Set<RepoOpenClass>();
    for (const m of V.workerRequest.validMutations as Mutation[]) {
      const c = claimed(m);
      claimedClasses.add(c);
      expect([JSON.stringify(m), parses(mutate(m, NOW), c, m.projectGitHost)]).toEqual([JSON.stringify(m), true]);
      for (const o of others(c)) expect([JSON.stringify(m), o, parses(mutate(m, NOW), o, m.projectGitHost)]).toEqual([JSON.stringify(m), o, false]);
    }
    expect([...claimedClasses].sort()).toEqual([...REPO_OPEN_CLASSES].sort());
  });

  it('every invalid mutation is refused for every route class', () => {
    for (const m of V.workerRequest.invalidMutations as Mutation[]) {
      for (const routeClass of REPO_OPEN_CLASSES) {
        expect([m.why, routeClass, parses(mutate(m, NOW), routeClass, m.projectGitHost)]).toEqual([m.why, routeClass, false]);
      }
    }
  });

  it('the class → git host table is closed in both directions: no union allow-list', () => {
    const hosts = [...Object.values(REPO_OPEN_CLASS_GIT_HOSTS), 'github.ezil.work', 'git.ezil.work', 'GIT-QA.EZIL.WORK'];
    for (const routeClass of REPO_OPEN_CLASSES) {
      for (const bodyClass of [undefined, ...REPO_OPEN_CLASSES]) {
        for (const gitHost of hosts) {
          const body = baseBody(NOW, { gitHost, ...(bodyClass === undefined ? {} : { class: bodyClass }) });
          const effective = bodyClass ?? REPO_OPEN_CLASS_DEFAULT;
          // class project has no single-host entry (1.0.4): the project route without projectGitHost refuses every body
          const want = effective === routeClass && gitHost === (REPO_OPEN_CLASS_GIT_HOSTS as Readonly<Record<string, string>>)[routeClass];
          expect([routeClass, bodyClass ?? null, gitHost, parses(body, routeClass)]).toEqual([routeClass, bodyClass ?? null, gitHost, want]);
        }
      }
    }
    // The cases the lead named, explicitly.
    expect(parses(baseBody(NOW, { gitHost: QA }), 'personal')).toBe(false);
    expect(parses(baseBody(NOW, { class: 'assessment', gitHost: PREVIEW }), 'assessment')).toBe(false);
    // An assessment body must carry its class (so the host and the kernel see it): class-less git-qa is refused.
    expect(parses(baseBody(NOW, { gitHost: QA }), 'assessment')).toBe(false);
    expect(parses(baseBody(NOW, { class: 'assessment', gitHost: QA }), 'assessment')).toBe(true);
  });

  it('an unknown route class is refused, whatever the body says', () => {
    for (const routeClass of ['exam', 'Assessment', 'constructor', '__proto__', 'toString', '', undefined, null, 1]) {
      for (const body of [baseBody(NOW), baseBody(NOW, { class: 'assessment', gitHost: QA }), baseBody(NOW, { class: routeClass, gitHost: QA })]) {
        expect(parseRepoOpenBody(enc(body), NOW, routeClass as RepoOpenClass)).toBeNull();
      }
    }
  });

  it('a class value that is not a class is refused on both routes: inherited names, null, empty, numbers, arrays, objects', () => {
    for (const value of ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf', null, '', 0, 1, true,
      ['assessment'], { assessment: true }, 'assessment ', 'Personal']) {
      for (const gitHost of [PREVIEW, QA]) {
        for (const routeClass of REPO_OPEN_CLASSES) expect(parses(baseBody(NOW, { class: value, gitHost }), routeClass)).toBe(false);
      }
    }
  });

  it('1.0.4 class project: the constants are the vectors\'; only the wrapped classes use the wrapper', () => {
    expect([...REPO_OPEN_PROJECT_GIT_HOSTS]).toEqual(C.REPO_OPEN_PROJECT_GIT_HOSTS);
    expect(REPO_OPEN_PROJECT_GRANT_MAX_MS).toBe(V.workerRequest.projectGrantMaxMs);
    expect(Object.isFrozen(REPO_OPEN_PROJECT_GIT_HOSTS)).toBe(true);
    expect(REPO_OPEN_CLASSES.map((c) => [c, isWrappedClass(c)])).toEqual([['personal', false], ['assessment', true], ['project', true]]);
  });

  it('1.0.4 class project: the body names exactly the route\'s host, which must be a project host, in both directions', () => {
    const grant = { expiresAt: new Date(NOW + 300_000).toISOString() };
    const hosts = [...REPO_OPEN_PROJECT_GIT_HOSTS, PREVIEW, 'git.ezil.work', 'GIT-QA.EZIL.WORK', ''];
    for (const route of [...hosts, undefined]) {
      for (const gitHost of hosts) {
        const body = baseBody(NOW, { class: 'project', gitHost }, grant);
        const want = gitHost === route && (REPO_OPEN_PROJECT_GIT_HOSTS as readonly string[]).includes(gitHost);
        expect([route ?? null, gitHost, parses(body, 'project', route)]).toEqual([route ?? null, gitHost, want]);
      }
    }
    // The project route never takes a personal or assessment body, and they never take a project body.
    for (const gitHost of REPO_OPEN_PROJECT_GIT_HOSTS) {
      expect(parses(baseBody(NOW, { gitHost }, grant), 'project', gitHost)).toBe(false);
      expect(parses(baseBody(NOW, { class: 'assessment', gitHost }, grant), 'project', gitHost)).toBe(false);
      for (const routeClass of ['personal', 'assessment'] as const) {
        expect(parses(baseBody(NOW, { class: 'project', gitHost }, grant), routeClass, gitHost)).toBe(false);
      }
    }
    // projectGitHost means nothing to the single-host routes.
    expect(parses(baseBody(NOW, {}, grant), 'personal', 'github.ezil.work')).toBe(true);
    expect(parses(baseBody(NOW, { class: 'assessment', gitHost: QA }, grant), 'assessment', 'github.ezil.work')).toBe(true);
  });

  it('1.0.4 class project: an OS-scoped grant of at most 330 s, path null, open and refresh', () => {
    const at = (ms: number) => ({ expiresAt: new Date(NOW + ms).toISOString() });
    const p = (patch: Record<string, unknown>, grantMs: number) => parses(baseBody(NOW, { class: 'project', gitHost: QA, ...patch }, at(grantMs)), 'project', QA);
    expect([p({}, 1), p({}, 300_000), p({}, REPO_OPEN_PROJECT_GRANT_MAX_MS), p({ op: 'refresh' }, 300_000)]).toEqual([true, true, true, true]);
    expect([p({}, 0), p({}, -1), p({}, REPO_OPEN_PROJECT_GRANT_MAX_MS + 1), p({}, 3_600_000), p({}, WORKER_ACCEPT_EXPIRY_MAX_MS)]).toEqual([false, false, false, false, false]);
    for (const path of ['src', 'src/main.ts', '', '../x', '/abs']) expect([path, p({ path }, 300_000)]).toEqual([path, false]);
    expect(p({ op: 'refresh', path: 'src' }, 300_000)).toBe(false);
    // the personal ceiling is unchanged
    expect(parses(baseBody(NOW, {}, at(WORKER_ACCEPT_EXPIRY_MAX_MS)), 'personal')).toBe(true);
  });

  it('an own "__proto__" key, or any key outside the body keys and class, is refused', () => {
    const text = JSON.stringify(baseBody(NOW, { class: 'assessment', gitHost: QA }));
    for (const extra of ['"__proto__":{"class":"assessment"}', '"constructor":"x"', '"jobId":"x"', '"classes":"assessment"']) {
      const raw = new TextEncoder().encode(`{${extra},${text.slice(1)}`);
      for (const routeClass of REPO_OPEN_CLASSES) expect(parseRepoOpenBody(raw, NOW, routeClass)).toBeNull();
    }
    expect(parseRepoOpenBody(new TextEncoder().encode(text), NOW, 'assessment')).not.toBeNull();
  });

  it('size, JSON shape, grant key strictness and the expiry window (as at 2ca90211)', () => {
    const b = baseBody(NOW);
    expect(parses({ ...b, path: `src/${'a'.repeat(240)}` }, 'personal')).toBe(true);
    const big = new TextEncoder().encode(JSON.stringify(b).padEnd(WORKER_REQUEST_MAX_BYTES + 1, ' '));
    expect(parseRepoOpenBody(big, NOW, 'personal')).toBeNull();
    expect(parseRepoOpenBody(new TextEncoder().encode(JSON.stringify(b).padEnd(WORKER_REQUEST_MAX_BYTES, ' ')), NOW, 'personal')).not.toBeNull();
    for (const bad of [[], null, 'x', { ...b, grant: { ...b.grant, extra: 1 } }, { ...b, grant: [] }, { ...b, path: 7 }, { ...b, v: '1' }]) {
      expect(parses(bad, 'personal')).toBe(false);
    }
    expect(parseRepoOpenBody(new TextEncoder().encode('{"v":1'), NOW, 'personal')).toBeNull();
    expect(parseRepoOpenBody(new Uint8Array([0xff, 0xfe]), NOW, 'personal')).toBeNull();
    expect(parses(baseBody(NOW, {}, { expiresAt: '2026-10-31 12:15:00' }), 'personal')).toBe(false);
    expect(parses(baseBody(NOW, {}, { expiresAt: new Date(NOW + WORKER_ACCEPT_EXPIRY_MAX_MS).toISOString() }), 'personal')).toBe(true);
    expect(parses(baseBody(NOW, {}, { expiresAt: new Date(NOW + WORKER_ACCEPT_EXPIRY_MAX_MS + 1).toISOString() }), 'personal')).toBe(false);
    expect(parses(baseBody(NOW, {}, { expiresAt: new Date(NOW).toISOString() }), 'personal')).toBe(false);
  });

  it('link.path vectors: every valid path parses on open, every decoded invalid path is refused, and refresh takes no path', () => {
    for (const v of V.link.path.valid) expect(parses(baseBody(NOW, { path: expand(v) }), 'personal')).toBe(true);
    for (const [value, raw] of V.link.path.invalid) {
      if (expand(value) === expand(raw)) expect(parses(baseBody(NOW, { path: expand(value) }), 'personal')).toBe(false);
    }
    expect(parses(baseBody(NOW, { op: 'refresh', path: 'src' }), 'personal')).toBe(false);
    expect(parses(baseBody(NOW, { op: 'refresh', class: 'assessment', gitHost: QA }), 'assessment')).toBe(true);
  });

  it('validName and validBranch keep the u2 predicates', () => {
    expect([validName('site'), validName('a..b'), validName('site.git'), validName('.site')]).toEqual([true, false, false, false]);
    for (const ok of ['main', 'feature/x', 'v1.2']) expect(validBranch(ok)).toBe(true);
    for (const bad of ['a..b', 'a//b', 'a/', 'x.lock', 'a/.b', 'a.', '-x']) expect(validBranch(bad)).toBe(false);
  });
});

// ── E1-6: the assessment layout ─────────────────────────────────────────────

const X_ID = V.fixtures.repositoryId as string;

describe('E1-6: an assessment opens the wrapper projects/<repositoryId> (vectors kernel.assessment.layoutRule)', () => {
  it('the layout helpers equal the vectors constants and the okAssessmentContext', () => {
    const X = W.okAssessmentContext;
    expect(`${ASSESSMENT_PROJECTS_DIR}/<repositoryId>`).toBe(C.ASSESSMENT_DIR_TEMPLATE);
    expect(ASSESSMENT_CLONE_DIR).toBe(C.ASSESSMENT_CLONE_DIR_NAME);
    expect(assessmentEditorRoot(X.root, X.repositoryId)).toBe(X.folder);
    expect(assessmentRemoteUrl(X.handle, X.name)).toBe(X.remote);
    expect(assessmentRemoteUrl('<handle>', '<name>')).toBe(C.ASSESSMENT_REMOTE_TEMPLATE);
  });

  it('the clone directory is the live open-project module\'s REPO_OPEN_NESTED_DIR (read as text, never imported)', () => {
    const live = readFileSync(here('./repo-open.ts'), 'utf8');
    expect(/^export const REPO_OPEN_NESTED_DIR = '([^']+)';$/m.exec(live)?.[1]).toBe(ASSESSMENT_CLONE_DIR);
  });

  it('an assessment body takes no path (refused on the assessment route), a personal one still does', () => {
    const assess = (patch: Record<string, unknown> = {}) => baseBody(NOW, { class: 'assessment', gitHost: QA, ...patch });
    expect(parses(assess(), 'assessment')).toBe(true);
    for (const path of ['src', 'src/main.ts', 'repository', '']) expect([path, parses(assess({ path }), 'assessment')]).toEqual([path, false]);
    for (const v of V.link.path.valid) expect(parses(assess({ path: expand(v) }), 'assessment')).toBe(false);
    expect(parses(baseBody(NOW, { path: 'src' }), 'personal')).toBe(true);
    // repositoryId names the wrapper: only a lowercase UUID
    for (const repositoryId of [X_ID.toUpperCase(), X_ID.replaceAll('-', ''), '../x', `${X_ID}/..`, '', null]) {
      expect([repositoryId, parses(assess({ repositoryId }), 'assessment')]).toEqual([repositoryId, false]);
    }
  });
});

// ── module boundary ─────────────────────────────────────────────────────────

describe('module boundary', () => {
  it('imports nothing, and among Worker modules only the AWS relay imports it', () => {
    const source = readFileSync(here('./repo-open-u2.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
    const importers = readdirSync(here('.')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'repo-open-u2.ts')
      .filter((f) => /from '\.\/repo-open-u2'/.test(readFileSync(here(`./${f}`), 'utf8')));
    expect(importers).toEqual(['aws-repo-open.ts']);
  });
});
