#!/usr/bin/env bun
/**
 * The EZiL OS invite CLI — the only sanctioned way to write `ezil_os_access`.
 *
 *     bun tools/invite.ts add <email> [--by <who>] [--no-invite]
 *     bun tools/invite.ts revoke <email>
 *     bun tools/invite.ts list
 *
 * `ezil_os_access` is the allow-list `assertOsAccess()`
 * (`app/src/server/api/os-access.ts`) reads on every request while
 * `EZIL_OS_ACCESS_MODE` is `invite` — its default. This script is how a row
 * gets into it, and it exists for the same reason
 * `app/scripts/apply-telemetry-migration.mjs` does: the alternative is a human
 * pasting DDL into the Supabase SQL editor, where a typo in an email is an
 * invite that silently never works and a mistyped `delete` is unrecoverable.
 *
 * ── ORDER OF OPERATIONS, and why it is not the obvious one ────────────────
 * 🔴 `add` writes the allow-list row BEFORE it asks Supabase to send the
 * invite email. The other order has a failure mode with no recovery from the
 * invitee's side: the email goes out, they click it, Supabase creates their
 * account, they sign in — and `assertOsAccess` turns them away, because the
 * row was never written. They now hold a working account that the product
 * refuses, and nothing tells anyone. This order's failure mode is the benign
 * one: a row exists for someone who never got an email, and re-running `add`
 * sends it (the upsert is idempotent).
 *
 * ── `add` on an already-revoked row CLEARS the revocation ─────────────────
 * `email` is the primary key, so a second row is impossible; the choice is
 * between un-revoking and refusing. It un-revokes — "invite this person" has
 * exactly one sensible meaning, and the alternative (silently leaving
 * `revoked_at` set) would print "invited" while the gate kept denying them.
 * `created_at` is preserved, so the audit trail still shows when they were
 * first invited. The output says explicitly that a revocation was lifted.
 *
 * ── Secrets ──────────────────────────────────────────────────────────────
 * `SUPABASE_DATABASE_URL` (which contains a password) and
 * `SUPABASE_SERVICE_ROLE_KEY` are read from the environment BY NAME and never
 * printed — not on success, not in an error, not in a usage message. Every
 * line this script emits goes through `redact()`, which replaces any verbatim
 * occurrence of either value and masks `://user:pass@` in anything that looks
 * like a URL. Missing variables are reported BY NAME with no value.
 *
 * ── Where `postgres` comes from ──────────────────────────────────────────
 * `tools/` has no dependencies of its own and none may be added (no
 * `bun install` runs in a worktree — `tools/node_modules` is a set of
 * symlinks into `sdk/node_modules`). The driver is therefore loaded by PATH
 * from the app's own installed copy — the exact version the server uses —
 * with a dynamic `import()` of a computed specifier, which is also why the
 * narrow `Sql` interface below exists rather than the package's own types
 * (the package is not on this project's module resolution path, so `tsc`
 * cannot see them from here).
 *
 * ── One integration seam this script CANNOT close (hand-off to row A2) ────
 * `redirectTo` is `EZIL_OS_ORIGIN` + `/auth/callback`. Two caveats a reader
 * needs, neither of which this file can fix:
 *
 *   1. Supabase ignores a `redirect_to` that is not in the project's
 *      "Redirect URLs" allow-list — silently, with no error, falling back to
 *      the Site URL. That list is dashboard configuration, not code.
 *   2. Invites do not use PKCE (auth-js says so in
 *      `GoTrueAdminApi.inviteUserByEmail`: the browser that sends an invite is
 *      usually not the browser that accepts it). A non-PKCE verify hands the
 *      session back in the URL FRAGMENT, and
 *      `app/src/app/auth/callback/route.ts` is a server route handler that
 *      reads `?code=` only — a fragment is never sent to the server. Whether
 *      an invited user actually lands signed-in is therefore row A2's
 *      question, not this script's.
 */

// ── Types for the dynamically-loaded `postgres` driver ─────────────────────

type Row = Record<string, unknown>;

interface Sql {
	(strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
	end(options?: { timeout?: number }): Promise<void>;
}

type PostgresFactory = (url: string, options?: Record<string, unknown>) => Sql;

/**
 * The app's installed `postgres` (see the header). The specifier is held in a
 * variable on purpose: a literal would make `tsc` try to resolve a package
 * that is deliberately not on `tools/`'s resolution path.
 */
const loadPostgres = async (): Promise<PostgresFactory> => {
	const specifier = new URL('../app/node_modules/postgres/src/index.js', import.meta.url).href;
	const mod = (await import(specifier)) as { default: PostgresFactory };
	return mod.default;
};

// ── Secret hygiene ─────────────────────────────────────────────────────────

/** Collected once, at the point each command reads its environment. */
const secrets: string[] = [];

const rememberSecret = (value: string | undefined): void => {
	if (value && value.length >= 8 && !secrets.includes(value)) secrets.push(value);
};

/**
 * Everything printed goes through here. Two independent passes, because
 * either alone has a hole: the verbatim pass misses a driver that reformats
 * the URL it was given, and the pattern pass misses a bare API key.
 */
export const redact = (text: string, values: readonly string[] = secrets): string => {
	let out = text;
	for (const value of values) out = out.split(value).join('[redacted]');
	// `scheme://user:password@host` -> `scheme://[redacted]@host`
	out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@');
	return out;
};

const out = (text: string): void => {
	console.log(redact(text));
};

const fail = (text: string): never => {
	console.error(redact(text));
	process.exit(1);
};

/**
 * Reads a variable by NAME and refuses by NAME. The value never reaches the
 * message — that is the whole point of taking the name as a string.
 */
const requireEnv = (name: string, why: string): string => {
	const value = process.env[name];
	if (!value) {
		fail(`[invite] ${name} is not set — refusing to run.\n         ${why}`);
	}
	rememberSecret(value);
	return value as string;
};

// ── Email normalisation — the same rule the gate applies ───────────────────

/**
 * MUST match `normalizeAccessEmail()` in `app/src/server/api/os-access.ts`.
 * If these two ever disagree, an invite is written under one spelling and
 * looked up under another, and the person is denied with a row in the table.
 * `ezil_os_access_email_lower_chk` is the database's own backstop against the
 * half of that this function could get wrong.
 */
const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

/**
 * Deliberately permissive: one `@`, something either side, no whitespace. It
 * is a typo guard, not an address validator — a stricter regex would reject
 * real addresses, and the cost of a wrong-but-well-formed address here is the
 * same as the cost of a wrong-but-valid one (an invite nobody receives).
 */
const looksLikeEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// ── Argument parsing ───────────────────────────────────────────────────────

const USAGE = `EZiL OS invite allow-list (table: ezil_os_access)

  bun tools/invite.ts add <email> [--by <who>] [--no-invite]
  bun tools/invite.ts revoke <email>
  bun tools/invite.ts list
  bun tools/invite.ts --help

Commands
  add       Allow-list the email (upsert; clears an existing revocation),
            then send a Supabase invite email to it.
  revoke    Soft-revoke: sets revoked_at. The row is never deleted.
  list      Print every row: email, invited_by, created_at, revoked_at.

Options
  --by <who>    Recorded in invited_by. Defaults to $EZIL_INVITED_BY, then
                $USER, then "unknown".
  --no-invite   Write the allow-list row and send NO email. Use this for an
                account that ALREADY exists (Supabase rejects an invite to a
                registered address), or to pre-authorise someone who will
                sign in with Google.

Environment (read by name; never printed)
  SUPABASE_DATABASE_URL       required by every command.
  SUPABASE_SERVICE_ROLE_KEY   required by "add" unless --no-invite.
  SUPABASE_URL                the project's API origin, required by "add"
                              unless --no-invite. NEXT_PUBLIC_SUPABASE_URL is
                              accepted as a fallback.
  EZIL_OS_ORIGIN              invite redirect target; default
                              https://os.ezil.work
                              (the link lands on <origin>/auth/callback).

Notes
  Access is only enforced while EZIL_OS_ACCESS_MODE is "invite" — its default.
  In "open" mode this table is not consulted at all.
  The allow-list row is written BEFORE the email is sent, on purpose: see the
  comment at the top of this file.`;

interface ParsedArgs {
	command: string;
	email?: string;
	by?: string;
	noInvite: boolean;
}

export const parseArgs = (argv: readonly string[]): ParsedArgs => {
	const positional: string[] = [];
	let by: string | undefined;
	let noInvite = false;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]!;
		if (arg === '--by') {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) fail('[invite] --by needs a value.');
			by = value;
			i += 1;
		} else if (arg.startsWith('--by=')) {
			by = arg.slice('--by='.length);
		} else if (arg === '--no-invite') {
			noInvite = true;
		} else if (arg === '--help' || arg === '-h' || arg === 'help') {
			positional.unshift('--help');
		} else if (arg.startsWith('-')) {
			fail(`[invite] unknown option: ${arg}\n\n${USAGE}`);
		} else {
			positional.push(arg);
		}
	}

	return { command: positional[0] ?? '', email: positional[1], by, noInvite };
};

const invitedBy = (explicit: string | undefined): string =>
	explicit ?? process.env.EZIL_INVITED_BY ?? process.env.USER ?? 'unknown';

// ── Database ───────────────────────────────────────────────────────────────

/**
 * Opens the pool. `max: 1` and `onnotice` silenced, same as
 * `app/scripts/apply-telemetry-migration.mjs` — this is a one-shot CLI, not a
 * server.
 */
const connect = async (): Promise<Sql> => {
	const url = requireEnv(
		'SUPABASE_DATABASE_URL',
		'It is the connection string for the Supabase Postgres that holds ezil_os_access.',
	);
	const postgres = await loadPostgres();
	return postgres(url, { max: 1, onnotice: () => {} });
};

/** ISO-8601 for every timestamp, everywhere. A `Date`'s default `toString()`
 * ("Fri Sep 04 2026 ... (Coordinated Universal Time)") is unsortable, locale-
 * shaped, and not what the database holds. */
const stamp = (raw: unknown): string => {
	if (raw === null || raw === undefined) return '-';
	if (raw instanceof Date) return raw.toISOString();
	return String(raw);
};

const formatRow = (row: Row): string => {
	const value = (key: string): string => stamp(row[key]);
	const status = row.revoked_at === null || row.revoked_at === undefined ? 'ACTIVE ' : 'REVOKED';
	return `${status}  ${value('email').padEnd(34)}  by=${value('invited_by').padEnd(16)}  created=${value('created_at')}  revoked=${value('revoked_at')}`;
};

// ── Supabase Admin invite ──────────────────────────────────────────────────

/**
 * `POST <SUPABASE_URL>/auth/v1/invite?redirect_to=<...>` with `{ email }`.
 *
 * This is exactly what `@supabase/supabase-js`'s
 * `auth.admin.inviteUserByEmail()` issues — read out of the installed
 * `@supabase/auth-js` rather than from memory: `GoTrueAdminApi.js` calls
 * `_request(fetch, 'POST', `${url}/invite`, { body: { email, data }, headers,
 * redirectTo })`, and `lib/fetch.js` turns `redirectTo` into the
 * `redirect_to` QUERY parameter (not a body field). Called with plain `fetch`
 * here so that `tools/` needs no dependency and the request on the wire is
 * the one written in this file.
 */
const sendInvite = async (email: string): Promise<void> => {
	const key = requireEnv(
		'SUPABASE_SERVICE_ROLE_KEY',
		'The admin invite endpoint requires it. Pass --no-invite to write the allow-list row without sending an email.',
	);
	const apiOrigin = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
	if (!apiOrigin) {
		fail(
			'[invite] SUPABASE_URL is not set (NEXT_PUBLIC_SUPABASE_URL is accepted too) — refusing to run.\n' +
				'         It is the project API origin, e.g. https://<ref>.supabase.co.\n' +
				'         The allow-list row was already written; re-run with the variable set, or use --no-invite.',
		);
	}

	const origin = (process.env.EZIL_OS_ORIGIN ?? 'https://os.ezil.work').replace(/\/+$/, '');
	const redirectTo = `${origin}/auth/callback`;
	const url = `${apiOrigin!.replace(/\/+$/, '')}/auth/v1/invite?redirect_to=${encodeURIComponent(redirectTo)}`;

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			apikey: key,
			Authorization: `Bearer ${key}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ email }),
	});

	if (!response.ok) {
		// The body is echoed because GoTrue's reason ("email address already
		// registered", an unlisted redirect, rate limiting) is the whole
		// diagnosis — through `redact`, since an error body is not trusted to
		// be free of what was sent to it.
		const body = await response.text().catch(() => '<unreadable>');
		fail(
			`[invite] the allow-list row IS written, but Supabase refused to send the email ` +
				`(HTTP ${response.status}).\n         ${body}\n` +
				`         If the account already exists, that is expected — re-run with --no-invite.`,
		);
	}

	out(`[invite] invite email sent; its link returns to ${redirectTo}`);
};

// ── Commands ───────────────────────────────────────────────────────────────

const cmdAdd = async (rawEmail: string, by: string, noInvite: boolean): Promise<void> => {
	const email = normalizeEmail(rawEmail);
	if (!looksLikeEmail(email)) fail(`[invite] "${rawEmail}" does not look like an email address — refusing.`);

	const sql = await connect();
	try {
		const before = await sql`SELECT revoked_at FROM ezil_os_access WHERE email = ${email}`;
		const existing = before[0];

		// 🔴 The row lands BEFORE the email goes out. See the header.
		const rows = await sql`
			INSERT INTO ezil_os_access (email, invited_by)
			VALUES (${email}, ${by})
			ON CONFLICT (email) DO UPDATE
				SET revoked_at = NULL,
					invited_by = EXCLUDED.invited_by
			RETURNING email, invited_by, created_at, revoked_at`;

		const row = rows[0];
		if (!row) throw new Error('the upsert returned no row — nothing was written');

		if (!existing) out(`[invite] allow-listed ${email} (invited_by=${by})`);
		else if (existing.revoked_at !== null && existing.revoked_at !== undefined) {
			out(`[invite] allow-listed ${email} (invited_by=${by}) — a previous REVOCATION was lifted`);
		} else out(`[invite] ${email} was already allow-listed and active; invited_by updated to ${by}`);

		if (noInvite) {
			out('[invite] --no-invite: no email sent.');
		} else {
			await sendInvite(email);
		}
	} finally {
		await sql.end();
	}
};

const cmdRevoke = async (rawEmail: string): Promise<void> => {
	const email = normalizeEmail(rawEmail);
	const sql = await connect();
	try {
		// SOFT revoke — an UPDATE, never a DELETE. The row is the record that
		// this address was invited and then withdrawn; deleting it destroys
		// the only trace that either ever happened.
		const rows = await sql`
			UPDATE ezil_os_access
			   SET revoked_at = now()
			 WHERE email = ${email}
			   AND revoked_at IS NULL
			RETURNING email, revoked_at`;

		const row = rows[0];
		if (row) {
			out(`[invite] revoked ${email} at ${stamp(row.revoked_at)} — the row is kept, revoked_at is set.`);
			return;
		}

		// Nothing updated. Say WHICH of the two reasons, rather than "done".
		const existing = await sql`SELECT revoked_at FROM ezil_os_access WHERE email = ${email}`;
		if (existing[0]) out(`[invite] ${email} was already revoked at ${stamp(existing[0].revoked_at)} — no change.`);
		else fail(`[invite] ${email} is not on the allow-list — nothing to revoke.`);
	} finally {
		await sql.end();
	}
};

const cmdList = async (): Promise<void> => {
	const sql = await connect();
	try {
		const rows = await sql`
			SELECT email, invited_by, created_at, revoked_at
			  FROM ezil_os_access
			 ORDER BY created_at DESC`;

		if (rows.length === 0) {
			out('[invite] ezil_os_access is empty.');
			out('         With EZIL_OS_ACCESS_MODE unset or "invite", NOBODY can use EZiL OS.');
			return;
		}

		const active = rows.filter((r) => r.revoked_at === null || r.revoked_at === undefined).length;
		for (const row of rows) out(formatRow(row));
		out(`[invite] ${rows.length} row(s): ${active} active, ${rows.length - active} revoked.`);
	} finally {
		await sql.end();
	}
};

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * 🔴 Every environment read happens INSIDE a command, never at module scope,
 * so `--help` works on a machine with none of it configured — which is the
 * machine whose owner most needs to read the usage.
 */
const main = async (argv: readonly string[]): Promise<void> => {
	const { command, email, by, noInvite } = parseArgs(argv);

	if (command === '--help' || command === '') {
		out(USAGE);
		process.exit(command === '' ? 1 : 0);
	}

	switch (command) {
		case 'add':
			if (!email) fail(`[invite] add needs an email.\n\n${USAGE}`);
			await cmdAdd(email!, invitedBy(by), noInvite);
			return;
		case 'revoke':
			if (!email) fail(`[invite] revoke needs an email.\n\n${USAGE}`);
			await cmdRevoke(email!);
			return;
		case 'list':
			await cmdList();
			return;
		default:
			fail(`[invite] unknown command: ${command}\n\n${USAGE}`);
	}
};

// `import.meta.main` is false when this file is imported (by a test), true
// when it is run — so importing it for `parseArgs`/`redact` does not execute
// a command.
if (import.meta.main) {
	try {
		await main(process.argv.slice(2));
	} catch (error) {
		// `err.message` only, and redacted: a driver error can carry the
		// connection string it was constructed from. Same discipline as
		// `app/scripts/apply-telemetry-migration.mjs`.
		const message = error instanceof Error ? error.message : String(error);
		console.error(redact(`[invite] FAILED: ${message}`));
		process.exit(1);
	}
}
