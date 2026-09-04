/**
 * Who the local shell thinks it is.
 *
 * ── There is exactly one user and exactly one computer, and neither is a row ─
 * The hosted product resolves `user` from Supabase Auth and `computer` from an
 * ownership-scoped Postgres row, because on a shared server "whose desktop is
 * this?" is the only question that matters. On a user's own machine, behind a
 * loopback-only listener, there is no second party to be confused with: the
 * process is running as the user, the workspace is a directory they own, and
 * an identity provider would be authentication with nothing to authorize.
 *
 * So the identity here is SYNTHETIC and says so. `LOCAL_USER_ID` is a constant,
 * not a UUID that looks like a Supabase one — a fake UUID would be the same
 * value shape as a real account id and would eventually be read as one. The
 * computer id is derived from the workspace path, so the same directory is the
 * same computer across restarts and two workspaces are two computers, which is
 * the only distinction local mode actually has.
 *
 * 🔴 NOTHING HERE IS A CREDENTIAL. These values are printed in the page source
 * (`window.__EZIL_BOOT__`) and must stay things it is fine to print.
 */

import { createHash } from 'node:crypto';

import type { ShellBootComputer, ShellBootUser } from '../contract/shell-api.ts';

/**
 * The one local identity.
 *
 * `shell/ezil/session.js`'s `payload()` rejects any payload whose
 * `user.id` is not a string — that is the ONE field every consumer
 * dereferences — so this must be present and stable. Nothing else in `shell/`
 * reads `user`: `telemetry.js:50` states outright that it sends neither
 * `payload().user.id` nor `payload().user.email`.
 */
export const LOCAL_USER_ID = 'local-user';

/**
 * A display name for the one local user.
 *
 * 🔴 IT HAS NOWHERE TO GO, AND THAT IS A FINDING RATHER THAN AN OMISSION.
 * `ShellBootUser` is `{ id, email }` — there is no display-name field in the
 * boot payload at all, and the row brief's "a stable synthetic id + display
 * name" has no slot to fill. Exported so the host can put it in its own startup
 * line and a later row that adds a name field has one definition to point at.
 */
export const LOCAL_USER_DISPLAY_NAME = 'You';

/**
 * `email: null`, never a synthesised address.
 *
 * `boot-payload.ts` says it outright for the hosted case — "Supabase can return
 * a user with no email (other identity providers). Never faked." A local host
 * genuinely has no email address for its user, and inventing one
 * (`you@localhost`) would put a string that looks like an account into a field
 * whose whole contract is that it is either real or `null`.
 */
export const LOCAL_USER: ShellBootUser = { id: LOCAL_USER_ID, email: null };

/** Prefix on every local computer id. Nothing derives meaning from it; it exists so a value in a log is obviously not a Supabase uuid. */
export const LOCAL_COMPUTER_ID_PREFIX = 'local-';

/**
 * The computer id for a workspace directory.
 *
 * Deterministic and path-derived: the same directory is the same computer
 * across restarts, and a user who points `EZIL_LOCAL_WORKSPACE` somewhere else
 * gets a different computer rather than the same one with different files.
 *
 * SHA-256 truncated to 16 hex characters. Not a cryptographic claim — nothing
 * is authorized by this value and the host validates every inbound
 * `computerId` by comparing it to the one it built (`../server/routes.ts`).
 * A hash rather than the path itself because the path is in the page source and
 * a home directory carries the user's login name.
 */
export function localComputerId(workspacePath: string): string {
    const digest = createHash('sha256').update(workspacePath, 'utf8').digest('hex');
    return `${LOCAL_COMPUTER_ID_PREFIX}${digest.slice(0, 16)}`;
}

/**
 * The default computer name, matching what the hosted schema defaults to —
 * `text('name').notNull().default('Computer')` in
 * `app/src/server/db/schema/computers.ts:57`. Same word, so a screenshot of
 * local mode and a screenshot of the hosted product say the same thing.
 */
export const LOCAL_COMPUTER_NAME = 'Computer';

/**
 * `slot: 1`. The hosted schema constrains it to `in (1, 2)`
 * (`computers.ts:76`), and local mode has exactly one computer, so `1` is the
 * only value that is both true and legal. `0` would be neither.
 */
export const LOCAL_COMPUTER_SLOT = 1;

export interface LocalComputerFacts {
    readonly workspacePath: string;
    /** When the workspace directory came into existence. ISO 8601. */
    readonly createdAt: string;
    /** ISO 8601, or `null` if this host has not opened the desktop yet. */
    readonly lastOpenedAt: string | null;
    /** True ONLY when this process created the workspace directory. */
    readonly isNew: boolean;
}

/**
 * Build the `computer` half of the boot payload.
 *
 * `isNew` keeps the hosted meaning exactly: "THIS boot created it", so the
 * shell can tell an expected-empty workspace from a lost one. The local
 * equivalent of creating the row is creating the workspace DIRECTORY, which is
 * the thing that is empty.
 */
export function buildLocalComputer(facts: LocalComputerFacts): ShellBootComputer {
    return {
        id: localComputerId(facts.workspacePath),
        name: LOCAL_COMPUTER_NAME,
        slot: LOCAL_COMPUTER_SLOT,
        createdAt: facts.createdAt,
        lastOpenedAt: facts.lastOpenedAt,
        isNew: facts.isNew,
    };
}
