/**
 * EZiL Git's staging gateway (`git-qa.ezil.work`) as an OPT-IN remote of
 * `repoOpenAuthFor` / `parseRepoOpenRequest`: refused by default (the personal
 * route never opts in; its route-table proof is in `repo-open-route.test.ts`),
 * accepted as Basic auth only with `{ stagingGitQa: true }` (the literal
 * `true`), and the opt-in widens nothing else: not the host pattern, not the
 * path, ref or token rules, not the other two remotes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

import {
  OS_STAGING_AI_GATEWAY_ORIGIN,
  parseRepoOpenRequest,
  repoOpenAuthFor,
  repoOpenCommand,
  repoOpenRemotesFor,
  REPO_OPEN_EXEC_TIMEOUT_MS,
  REPO_OPEN_SCRIPT,
  STAGING_GIT_QA_REPOSITORY_URL,
  type RepoOpenRemotes,
} from './repo-open';

const REPO = '0b6c3c1e-8f0a-4c5e-9a43-2a1f6d0e7b11';
const GRANT = `egg_${'ab12'.repeat(16)}`;
/** An opaque Cloudflare Artifacts repo token. */
const TOKEN = `art_v1_${'ab12'.repeat(16)}.Zz-9~/+=`;
const ACCOUNT = '0123456789abcdef'.repeat(2);
const ARTIFACTS = `https://${ACCOUNT}.artifacts.cloudflare.net/git/universe-staging/p-${REPO}.git`;
const GITHUB = 'https://github.ezil.work/acme/site.git';
const GIT_QA = 'https://git-qa.ezil.work/acme/site.git';
/** The shape staging Works issues: `<handle>/p-<uuid>.git`. */
const GIT_QA_P = `https://git-qa.ezil.work/acme-qa/p-${REPO}.git`;
const NOW = Date.parse('2026-10-31T12:00:00Z');
const EXPIRES = '2026-10-31T12:04:00.000Z';
const ON: RepoOpenRemotes = { stagingGitQa: true };
const INVALID = { ok: false, error: 'repo_open_invalid_request' } as const;

const body = (patch: Record<string, unknown> = {}, git: Record<string, unknown> = {}) => ({
  repositoryId: REPO,
  canonicalURL: GIT_QA,
  ref: 'refs/heads/main',
  git: { token: GRANT, expiresAt: EXPIRES, ...git },
  ...patch,
});

/** git-qa look-alikes: each must be refused even with the opt-in. */
const LOOKALIKES: Array<[string, string]> = [
  ['a suffix host', 'https://git-qa.ezil.work.evil.com/acme/site.git'],
  ['another suffix host', 'https://git-qa.ezil.work.evil.test/acme/site.git'],
  ['a non-dot before ezil', 'https://git-qaXezil.work/acme/site.git'],
  ['a non-dot before work', 'https://git-qa.ezilXwork/acme/site.git'],
  ['an uppercase host', 'https://GIT-QA.ezil.work/acme/site.git'],
  ['an uppercase domain', 'https://git-qa.EZIL.WORK/acme/site.git'],
  ['a trailing-dot host', 'https://git-qa.ezil.work./acme/site.git'],
  ['a sibling host', 'https://git.ezil.work/acme/site.git'],
  ['a shorter host', 'https://qa.ezil.work/acme/site.git'],
  ['another TLD', 'https://git-qa.ezil.org/acme/site.git'],
  ['plain http', 'http://git-qa.ezil.work/acme/site.git'],
  ['an explicit :443 port', 'https://git-qa.ezil.work:443/acme/site.git'],
  ['another port', 'https://git-qa.ezil.work:8443/acme/site.git'],
  ['userinfo before the host', `https://ezil:${GRANT}@git-qa.ezil.work/acme/site.git`],
  ['userinfo naming the host', 'https://git-qa.ezil.work@evil.test/acme/site.git'],
  ['a trailing slash', `${GIT_QA}/`],
  ['a query', `${GIT_QA}?x=1`],
  ['a fragment', `${GIT_QA}#x`],
  ['a trailing newline', `${GIT_QA}\n`],
  ['a trailing space', `${GIT_QA} `],
  ['a leading space', ` ${GIT_QA}`],
  ['a scheme prefix', `x${GIT_QA}`],
  ['the URL inside another URL', `https://evil.test/${GIT_QA}`],
  ['a backslash after the host', 'https://git-qa.ezil.work\\acme/site.git'],
  ['a double slash after the host', 'https://git-qa.ezil.work//acme/site.git'],
  ['a dot-dot segment', 'https://git-qa.ezil.work/acme/../site.git'],
  ['a leading dot-dot namespace', 'https://git-qa.ezil.work/../acme/site.git'],
  ['a dot-dot name', 'https://git-qa.ezil.work/acme/a..git'],
  ['an encoded dot-dot', 'https://git-qa.ezil.work/acme/%2e%2e/site.git'],
  ['an uppercase owner', 'https://git-qa.ezil.work/Acme/site.git'],
  ['an uppercase name', 'https://git-qa.ezil.work/acme/Site.git'],
  ['an extra path segment', 'https://git-qa.ezil.work/acme/x/site.git'],
  ['no .git suffix', 'https://git-qa.ezil.work/acme/site'],
  ['no owner', 'https://git-qa.ezil.work/site.git'],
];

/** Every body rule besides the URL, applied to a git-qa body: the opt-in must not relax any. */
const BODY_RULES: Array<[string, unknown]> = [
  ['an unknown top-level key', body({ folder: '/etc' })],
  ['a missing key', (({ ref: _r, ...rest }) => rest)(body())],
  ['an uppercase UUID', body({ repositoryId: REPO.toUpperCase() })],
  ['a non-UUID id', body({ repositoryId: '../../etc' })],
  ['a tag ref', body({ ref: 'refs/tags/v1' })],
  ['a bare branch', body({ ref: 'main' })],
  ['a dot-dot ref', body({ ref: 'refs/heads/a..b' })],
  ['an option-looking branch', body({ ref: 'refs/heads/-x' })],
  ['a .lock ref', body({ ref: 'refs/heads/main.lock' })],
  ['a timeoutMs below the floor', body({ timeoutMs: 19_999 })],
  ['a timeoutMs above the cap', body({ timeoutMs: REPO_OPEN_EXEC_TIMEOUT_MS + 1 })],
  ['an unknown git key', body({}, { password: 'x' })],
  ['another username', body({}, { username: 'root' })],
  ['an admin scope', body({}, { scope: 'admin' })],
  ['an empty token', body({}, { token: '' })],
  ['a token with a newline', body({}, { token: `${GRANT}\nhost=evil.test` })],
  ['a token with a space', body({}, { token: 'Basic x' })],
  ['a 4097-character token', body({}, { token: 'a'.repeat(4097) })],
  ['a non-ISO expiry', body({}, { expiresAt: 'tomorrow' })],
];

describe('git-qa.ezil.work is refused by default', () => {
  it('repoOpenAuthFor with no remotes argument gives it no scheme', () => {
    expect(STAGING_GIT_QA_REPOSITORY_URL.test(GIT_QA)).toBe(true);
    expect(repoOpenAuthFor(GIT_QA)).toBeNull();
    expect(repoOpenAuthFor(GIT_QA_P)).toBeNull();
  });

  it('repoOpenAuthFor with an empty or switched-off remotes gives it no scheme', () => {
    expect(repoOpenAuthFor(GIT_QA, {})).toBeNull();
    expect(repoOpenAuthFor(GIT_QA, undefined)).toBeNull();
    expect(repoOpenAuthFor(GIT_QA, { stagingGitQa: false })).toBeNull();
  });

  it('parseRepoOpenRequest with no remotes argument refuses it as repo_open_invalid_request', () => {
    expect(parseRepoOpenRequest(body(), NOW)).toEqual(INVALID);
    expect(parseRepoOpenRequest(body({ canonicalURL: GIT_QA_P }), NOW)).toEqual(INVALID);
  });

  it('parseRepoOpenRequest with an empty or switched-off remotes refuses it too', () => {
    expect(parseRepoOpenRequest(body(), NOW, {})).toEqual(INVALID);
    expect(parseRepoOpenRequest(body(), NOW, undefined)).toEqual(INVALID);
    expect(parseRepoOpenRequest(body(), NOW, { stagingGitQa: false })).toEqual(INVALID);
  });
});

describe('opted in ({ stagingGitQa: true }), git-qa.ezil.work opens as Basic auth', () => {
  it('accepts the contract body with auth basic and the derived branch', () => {
    expect(repoOpenAuthFor(GIT_QA, ON)).toBe('basic');
    expect(parseRepoOpenRequest(body(), NOW, ON)).toEqual({
      ok: true,
      request: {
        repositoryId: REPO, canonicalURL: GIT_QA, ref: 'refs/heads/main', branch: 'main',
        token: GRANT, expiresAt: EXPIRES, auth: 'basic', timeoutMs: REPO_OPEN_EXEC_TIMEOUT_MS,
      },
    });
  });

  it("accepts staging Works' p-<uuid> name, a nested branch, the passed-through git object and a timeoutMs", () => {
    const r = parseRepoOpenRequest(
      body({ canonicalURL: GIT_QA_P, ref: 'refs/heads/feature/x-1', timeoutMs: 45_000 }, { username: 'ezil', scope: 'write' }),
      NOW, ON,
    );
    expect(r).toEqual({
      ok: true,
      request: {
        repositoryId: REPO, canonicalURL: GIT_QA_P, ref: 'refs/heads/feature/x-1', branch: 'feature/x-1',
        // the scope is kept since repo-grant: an EZiL Git open with one installs push access
        token: GRANT, expiresAt: EXPIRES, scope: 'write', auth: 'basic', timeoutMs: 45_000,
      },
    });
  });

  for (const [name, b] of BODY_RULES) {
    it(`still refuses ${name} as repo_open_invalid_request`, () => {
      expect(parseRepoOpenRequest(b, NOW, ON)).toEqual(INVALID);
      expect(parseRepoOpenRequest(b, NOW)).toEqual(INVALID);
    });
  }

  it('still refuses an expired or nearly expired grant with repo_open_token_expired', () => {
    for (const expiresAt of ['2026-10-31T11:59:00Z', '2026-10-31T12:00:02Z']) {
      expect(parseRepoOpenRequest(body({}, { expiresAt }), NOW, ON)).toEqual({ ok: false, error: 'repo_open_token_expired' });
    }
    expect(parseRepoOpenRequest(body({}, { expiresAt: '2026-10-31T12:00:10Z' }), NOW, ON).ok).toBe(true);
  });
});

describe('the opt-in never widens the host pattern', () => {
  for (const [name, url] of LOOKALIKES) {
    it(`refuses ${name} with or without the opt-in`, () => {
      expect(repoOpenAuthFor(url, ON)).toBeNull();
      expect(repoOpenAuthFor(url)).toBeNull();
      expect(parseRepoOpenRequest(body({ canonicalURL: url }), NOW, ON)).toEqual(INVALID);
    });
  }
});

describe('github.ezil.work and Cloudflare Artifacts are identical with and without the opt-in', () => {
  const urls = [
    ARTIFACTS, GITHUB,
    'https://github.ezil.work.evil.test/acme/site.git', 'http://github.ezil.work/acme/site.git', `${GITHUB}?x=1`, `${GITHUB}/`,
    `https://ezil:${GRANT}@github.ezil.work/acme/site.git`, 'https://github.ezil.work/acme/a..git', 'https://github.com/acme/site.git',
    `${ARTIFACTS}/`, `${ARTIFACTS}#x`, ARTIFACTS.replace('https:', 'http:'),
    `https://${ACCOUNT}.artifacts.cloudflare.net:8443/git/universe-staging/site.git`,
    `https://${ACCOUNT.toUpperCase()}.artifacts.cloudflare.net/git/universe-staging/site.git`,
    'https://127.0.0.1/acme/site.git', '', 7, null, undefined, {},
  ];

  it('repoOpenAuthFor answers the same for every non-git-qa URL', () => {
    expect(repoOpenAuthFor(ARTIFACTS, ON)).toBe('bearer');
    expect(repoOpenAuthFor(GITHUB, ON)).toBe('basic');
    for (const url of urls) expect(repoOpenAuthFor(url, ON)).toEqual(repoOpenAuthFor(url));
  });

  it('parseRepoOpenRequest answers the same for their bodies, valid or not', () => {
    const bodies: unknown[] = [
      ...urls.map((canonicalURL) => body({ canonicalURL }, { token: TOKEN })),
      ...BODY_RULES.map(([, b]) => ({ ...(b as object), canonicalURL: ARTIFACTS })),
      ...BODY_RULES.map(([, b]) => ({ ...(b as object), canonicalURL: GITHUB })),
      body({ canonicalURL: ARTIFACTS }, { expiresAt: '2026-10-31T11:59:00Z' }),
      body({ canonicalURL: GITHUB }, { expiresAt: '2026-10-31T12:00:02Z' }),
      'x', [body({ canonicalURL: GITHUB })], null,
    ];
    let accepted = 0;
    for (const b of bodies) {
      const off = parseRepoOpenRequest(b, NOW);
      expect(parseRepoOpenRequest(b, NOW, ON)).toEqual(off);
      if (off.ok) accepted++;
    }
    // Not vacuous: the two valid remotes are among them, with their own schemes.
    expect(accepted).toBe(2);
    expect(parseRepoOpenRequest(body({ canonicalURL: ARTIFACTS }), NOW, ON)).toMatchObject({ ok: true, request: { auth: 'bearer' } });
    expect(parseRepoOpenRequest(body({ canonicalURL: GITHUB }), NOW, ON)).toMatchObject({ ok: true, request: { auth: 'basic' } });
  });
});

describe('only the literal true enables it', () => {
  const truthy: Array<[string, unknown]> = [
    ['1', 1], ["'true'", 'true'], ['{}', {}], ['[]', []], ["'yes'", 'yes'],
    ['a Boolean object', new Boolean(true)], ['a function', () => true],
  ];
  for (const [name, value] of truthy) {
    it(`stagingGitQa: ${name} leaves git-qa refused`, () => {
      const remotes = { stagingGitQa: value } as unknown as RepoOpenRemotes;
      expect(repoOpenAuthFor(GIT_QA, remotes)).toBeNull();
      expect(parseRepoOpenRequest(body(), NOW, remotes)).toEqual(INVALID);
    });
  }

  it('a remotes argument that is not an options object (null, true) enables nothing and does not throw', () => {
    for (const remotes of [null, true, 'stagingGitQa', 1] as unknown as RepoOpenRemotes[]) {
      expect(repoOpenAuthFor(GIT_QA, remotes)).toBeNull();
      expect(parseRepoOpenRequest(body(), NOW, remotes)).toEqual(INVALID);
      expect(repoOpenAuthFor(GITHUB, remotes)).toBe('basic');
    }
  });

  it('an inherited stagingGitQa (a polluted Object.prototype or a prototype object) never opts in', () => {
    const inherited = Object.create({ stagingGitQa: true }) as RepoOpenRemotes;
    expect(repoOpenAuthFor(GIT_QA, inherited)).toBeNull();
    expect(parseRepoOpenRequest(body(), NOW, inherited)).toEqual(INVALID);
    const proto = Object.prototype as Record<string, unknown>;
    proto.stagingGitQa = true;
    try {
      expect(repoOpenAuthFor(GIT_QA)).toBeNull();
      expect(repoOpenAuthFor(GIT_QA, {})).toBeNull();
      expect(parseRepoOpenRequest(body(), NOW)).toEqual(INVALID);
    } finally {
      delete proto.stagingGitQa;
    }
    expect(repoOpenAuthFor(GIT_QA, { stagingGitQa: true })).toBe('basic');
  });
});

describe('the in-computer flow is host-agnostic (URL + auth kind only)', () => {
  it('the container script names no EZiL Git host', () => {
    for (const host of ['github.ezil.work', 'git-qa.ezil.work', 'ezil.work', 'git-qa']) {
      expect(REPO_OPEN_SCRIPT).not.toContain(host);
    }
    // The Basic credential helper is scoped to the host taken from the URL itself.
    expect(REPO_OPEN_SCRIPT).toContain(`host=$(printf '%s' "$url" | cut -d/ -f3)`);
    expect(REPO_OPEN_SCRIPT).toContain('GIT_CONFIG_KEY_9="credential.https://$host.helper"');
  });

  it('a git-qa open is the github.ezil.work command with only the URL changed', () => {
    const params = { root: '/workspace', repositoryId: REPO, branch: 'main', requireHydrated: true, auth: 'basic' as const, timeoutMs: 90_000 };
    const qa = repoOpenCommand({ ...params, url: GIT_QA });
    const gh = repoOpenCommand({ ...params, url: GITHUB });
    expect(qa).toContain(`'${GIT_QA}'`);
    expect(qa).not.toContain(GRANT);
    expect(qa.replace(GIT_QA, GITHUB)).toBe(gh);
  });
});

describe('repoOpenRemotesFor: the personal route opts in on os-staging only (its exact Gateway origin; no env var added)', () => {
  it('os-staging: exactly the staging Gateway origin, with or without a bare /', () => {
    expect(OS_STAGING_AI_GATEWAY_ORIGIN).toBe('https://ai-staging.ezil.work');
    for (const v of ['https://ai-staging.ezil.work', 'https://ai-staging.ezil.work/']) {
      expect(repoOpenRemotesFor({ EZIL_AI_GATEWAY_URL: v })).toEqual({ stagingGitQa: true });
      expect(repoOpenAuthFor(GIT_QA_P, repoOpenRemotesFor({ EZIL_AI_GATEWAY_URL: v }))).toBe('basic');
    }
  });
  it('anything else fails closed: production, absent, empty, a path, a query, a fragment, http, userinfo, case, padding, look-alikes, non-strings', () => {
    for (const v of [undefined, null, '', 'https://ai.ezil.work', 'https://ai.ezil.work/', 'https://ai-staging.ezil.work/v1', 'https://ai-staging.ezil.work//',
      'https://ai-staging.ezil.work?x', 'https://ai-staging.ezil.work#x', 'http://ai-staging.ezil.work', 'https://a@ai-staging.ezil.work',
      'https://AI-STAGING.EZIL.WORK', ' https://ai-staging.ezil.work', 'https://ai-staging.ezil.work ', 'https://ai-staging.ezil.work:443',
      'https://ai-staging.ezil.work.evil.com', 'https://evil.com/https://ai-staging.ezil.work', 'not a url', 42, ['https://ai-staging.ezil.work'],
      { toString: () => 'https://ai-staging.ezil.work' }]) {
      expect({ v, got: repoOpenRemotesFor({ EZIL_AI_GATEWAY_URL: v }) }).toEqual({ v, got: {} });
      expect(repoOpenAuthFor(GIT_QA, repoOpenRemotesFor({ EZIL_AI_GATEWAY_URL: v }))).toBeNull();
    }
    expect(repoOpenRemotesFor({})).toEqual({});
  });
  it('on os-staging the parser accepts a Builder project\'s git-qa remote and keeps every other rule', () => {
    const remotes = repoOpenRemotesFor({ EZIL_AI_GATEWAY_URL: 'https://ai-staging.ezil.work' });
    const body = (canonicalURL: string, extra: Record<string, unknown> = {}) => ({
      repositoryId: REPO, canonicalURL, ref: 'refs/heads/main', git: { token: GRANT, expiresAt: new Date(Date.now() + 60_000).toISOString() }, ...extra,
    });
    const ok = parseRepoOpenRequest(body(GIT_QA_P), Date.now(), remotes);
    expect(ok.ok && ok.request.auth).toBe('basic');
    expect(parseRepoOpenRequest(body(GIT_QA_P, { repositoryId: REPO.toUpperCase() }), Date.now(), remotes)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    expect(parseRepoOpenRequest(body(GIT_QA_P, { ref: 'refs/heads/../x' }), Date.now(), remotes)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    expect(parseRepoOpenRequest(body(GIT_QA_P, { extra: 1 }), Date.now(), remotes)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    expect(parseRepoOpenRequest(body(GIT_QA_P, { git: { token: GRANT, expiresAt: new Date(Date.now() + 1_000).toISOString() } }), Date.now(), remotes))
      .toEqual({ ok: false, error: 'repo_open_token_expired' });
  });
});

describe('docs/contracts/os-builder-project-open-v1.vectors.json osWorker: the code answers every listed case', () => {
  const C = JSON.parse(readFileSync(new URL('../../docs/contracts/os-builder-project-open-v1.vectors.json', import.meta.url), 'utf8')) as {
    contract: string;
    osWorker: { routeGate: { accept: string[]; refuse: Array<string | null> }; remotes: { stagingAccept: string[]; alwaysRefuse: string[] } };
    negativeCases: Array<{ case: string; where: string; expect: string }>;
  };
  it('names its contract and covers every negative case the request lists', () => {
    expect(C.contract).toBe('ezil.os-builder-project-open.v1');
    expect(C.negativeCases.map((c) => c.case)).toEqual(['wrong user', 'stale binding (folder exists with another origin)', 'foreign origin remote', 'unknown repo',
      'deleted or missing folder', 'duplicate / retry', 'unicode', 'nested repository', 'git 2.34.1', 'ordinary non-assignment Builder project']);
  });
  it('routeGate: accept opts in, refuse does not', () => {
    for (const v of C.osWorker.routeGate.accept) expect(repoOpenRemotesFor({ EZIL_AI_GATEWAY_URL: v })).toEqual({ stagingGitQa: true });
    for (const v of C.osWorker.routeGate.refuse) expect({ v, got: repoOpenRemotesFor({ EZIL_AI_GATEWAY_URL: v ?? undefined }) }).toEqual({ v, got: {} });
  });
  it('remotes: staging accepts as Basic only with the gate; the refused list is refused with and without it', () => {
    const staging = repoOpenRemotesFor({ EZIL_AI_GATEWAY_URL: C.osWorker.routeGate.accept[0] });
    for (const url of C.osWorker.remotes.stagingAccept) {
      expect(repoOpenAuthFor(url, staging)).toBe('basic');
      expect(repoOpenAuthFor(url, {})).toBeNull();
    }
    for (const url of C.osWorker.remotes.alwaysRefuse) {
      expect({ url, got: repoOpenAuthFor(url, staging) }).toEqual({ url, got: null });
      expect(repoOpenAuthFor(url, {})).toBeNull();
    }
  });
});
