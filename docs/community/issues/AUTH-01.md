---
id: AUTH-01
title: /auth/invited shows invite errors in its own words, never the link's or Supabase's
labels: [app, "help wanted", "size/S"]
prereq:
state: open
github: 50
---

## The problem

This issue used to ask for a forgot-password UI on `/login` and a re-authentication check
before `updateUser({ password })` on `/auth/invited`. Neither applies any more. EZiL ID
(Auth0 at id.ezil.work) is the only sign-in, so passwords and their recovery belong to EZiL
ID, and `/login` offers nothing else. `/auth/invited` no longer sets a password at all: once
the invite session exists it enters `/os`, and the invited person later continues with EZiL ID
using the same address (see the header comment of `app/src/app/auth/invited/page.tsx`). The
part of the old issue that still holds is the error the page shows when an invite fails.

That error is text the page did not write. An error fragment's `error_description` is shown
as-is (`app/src/app/auth/invited/page.tsx:84`), and a failed `setSession` shows Supabase's
`error.message` (`page.tsx:97`). The first comes from the link, so anyone can send a link to
`/auth/invited#error=x&error_description=<any text>` and the page displays that text under
"Welcome to EZiL OS". The second is whatever Supabase happens to return, not a clear "your
invite link expired, ask for a new one". `/login` already refuses to do this: `noticeFor`
(`app/src/app/login/page.tsx:20-32`) matches the `error` value against known codes and never
displays the value itself.

## Acceptance criteria

- `/auth/invited` never renders `error_description`, `error.message`, or any other text taken
  from the URL or from a Supabase response.
- A known expired-link code (`otp_expired`, as GoTrue sends it) shows a specific sentence
  telling the person their invite link expired and to ask for a new one; every other failure
  shows one fixed, generic sentence.
- The mapping is a pure function next to `parseAuthFragment` in
  `app/src/app/auth/invited/fragment.ts`, so it is tested without rendering the page.
- The page still strips the fragment from the address bar and still enters `/os` with a
  document load on success; neither behaviour changes.

## Where to look

- `app/src/app/auth/invited/page.tsx:84` — `fragment.description` shown as the failure message.
- `app/src/app/auth/invited/page.tsx:97` — `setSession`'s `error.message` shown as the failure
  message.
- `app/src/app/auth/invited/fragment.ts` — `parseAuthFragment` already separates `code` from
  `description`; its tests (`fragment.test.ts`) include GoTrue's expired-link fragment.
- `app/src/app/login/page.tsx:20-32` — `noticeFor`, the pattern to follow: known codes map to
  fixed sentences, and the raw value is never displayed.

## How to prove it

```
cd app && bun run test src/app/auth/invited && bun run typecheck
```
Expected: a new test proves an `error_description` carrying arbitrary text and a `setSession`
error message both produce only the page's own sentences, and that `otp_expired` produces the
expired-link sentence.

## Prerequisite

None.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pr).
