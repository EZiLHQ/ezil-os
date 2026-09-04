---
id: AUTH-01
title: Forgot-password UI and re-auth before updateUser on /auth/invited
labels: [app, "help wanted", "size/M"]
prereq:
state: open
---

## The problem

Two gaps in the auth surface. First: there is no forgot-password path anywhere in the app —
`app/src/app/login/` (`login-form.tsx`, `actions.ts`, `page.tsx`) has no
`resetPasswordForEmail` call and no "forgot password" link (verified by grep across the whole
`login/` directory: zero matches for "forgot" or "reset"). A user who is invited, sets a
password once at `/auth/invited`, and later forgets it has no way back in. Second: on
`/auth/invited` itself, the page calls `supabase.auth.setSession()` from the invite link's
implicit-grant fragment (`app/src/app/auth/invited/page.tsx:90`), then later — after the user
types a password and submits — calls `supabase.auth.updateUser({ password })`
(`page.tsx:134`) with no re-authentication or session-freshness check in between. If the tab
sits open between those two moments (the fragment is parsed once, on page load, per the
component's structural guarantee described in its own header comment), the session backing the
second call may no longer be fresh, and the failure mode a user sees is just whatever error
message Supabase happens to return — not a clear "your invite link expired, ask for a new one."

## Acceptance criteria

- A forgot-password UI exists on (or reachable from) the login page, calling Supabase's
  `resetPasswordForEmail` and landing the user on a page that sets a new password the same way
  `/auth/invited` does today.
- Before calling `updateUser({ password })` on `/auth/invited`, the code confirms the session
  is still valid (e.g. re-checks `getSession()`/`getUser()` immediately before the call) and
  surfaces a specific, actionable error ("your invite link expired — ask a maintainer for a new
  one") rather than passing through whatever Supabase returns.
- A test proves the stale-session case: a session that has expired or been revoked between
  `setSession` and the `updateUser` call is caught and reported clearly, not silently retried
  or shown a generic error.
- The forgot-password flow does not create a new account and does not bypass the invite-only
  gate (`app/src/server/api/trpc.ts`'s `protectedProcedure`) — it only lets an already-invited,
  already-registered user reset a password they forgot.

## Where to look

- `app/src/app/auth/invited/page.tsx:90` — the `setSession` call from the invite fragment.
- `app/src/app/auth/invited/page.tsx:134` — the `updateUser({ password })` call this issue adds
  a re-auth check before.
- `app/src/app/login/login-form.tsx`, `app/src/app/login/actions.ts` — no forgot-password UI or
  action exists in either file today (verified by grep).
- `app/src/app/auth/invited/fragment.ts` — the implicit-grant fragment parser; its own doc
  comment explains why Supabase invites are not PKCE and why `setSession` must be called
  explicitly (the same reasoning a forgot-password reset link will need to reuse or diverge
  from, since a password-reset link uses a different Supabase flow than an invite).

## How to prove it

```
cd app && bun run test src/app/auth && bun run typecheck
```
Expected: a new test proves the stale-session case on `/auth/invited` is caught with a specific
message, and the forgot-password flow's own test proves `resetPasswordForEmail` is called with
no account created.

## Prerequisite

None.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pull-request).
