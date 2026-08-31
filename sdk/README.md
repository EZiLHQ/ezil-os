# `@ezil-os/sdk`

A typed client for the EZiL-OS computer API: list, create and delete a user's
computers, and mint URLs for their desktop, their dev server and their editor.

It is a thin, honest wrapper over the same tRPC endpoint the product's own web
app calls. It adds no capability the API does not already grant, and it is not
a security boundary — ownership is enforced server-side by scoped queries, not
by anything here.

## Install

Not published to npm yet. Depend on it from within this repository:

```bash
cd sdk && bun install
```

## Authenticate

Every call acts as a **user**, carrying a Supabase access token for that user.

There is no API-key or service-account credential in EZiL-OS. In particular the
Worker's `SANDBOX_HMAC_SECRET` is **not** a credential for this client and must
never be handed to a third party: it is a shared server-to-server secret that
authorises every signed Worker route, including `restart` and `DELETE`.

```ts
import { createClient } from '@supabase/supabase-js';
import { createEzilClient } from '@ezil-os/sdk';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const { data } = await supabase.auth.signInWithPassword({ email, password });

const ezil = createEzilClient({
    baseUrl: 'https://your-ezil-os-deployment.example',
    // A function, not a string, so a long-lived process survives expiry:
    token: async () => (await supabase.auth.getSession()).data.session!.access_token,
});
```

The server accepts this as `Authorization: Bearer <jwt>`, validated against the
Supabase auth server on every request — never decoded locally, because an
unverified JWT payload is user input, not an identity.

## Use

```ts
const computers = await ezil.computers.list();

const computer = computers[0] ?? (await ezil.computers.create({ name: 'Studio' }));

const { url } = await ezil.desktop.open(computer.id);
// Navigate to `url` NOW — see the warning below.
```

| Method | What it does |
| --- | --- |
| `computers.list()` | Every live computer the user owns. Never the soft-deleted ones. |
| `computers.get(id)` | One computer. `NOT_FOUND` if missing, deleted, or someone else's. |
| `computers.create({ name })` | Creates in the lowest free slot. Throws if the user already holds two. |
| `computers.getOrCreateDefault()` | The default computer, made on first call. Idempotent. |
| `computers.rename(id, name)` | |
| `computers.delete(id)` | Soft-deletes and terminates the container. The row survives. |
| `desktop.status(id)` | Cheap poll. Boots nothing. |
| `desktop.open(id)` | Starts or attaches the desktop and mints its URL. **Cold boot ~22s.** |
| `desktop.appPreviewUrl(id)` | URL for the dev server running inside the container. |
| `desktop.codeUrl(id)` | URL for code-server inside the container. |
| `desktop.restart(id)` | Re-runs the boot script in the *same* container. |
| `desktop.terminate(id)` | Destroys the container. Workspace is persisted to R2 first. |
| `isConfigured()` | Whether this deployment has a desktop provider wired up at all. |

## Three things that will bite you

**Minted URLs die in minutes.** The token embedded in a `desktop.*` URL is a
single-purpose bootstrap token with roughly a five-minute life; navigating to
the URL exchanges it for a session cookie. Mint one when you are about to open
a window — never at startup, and never cached across an idle. A stale one gives
a 401 and a blank window with no visible cause.

**`desktop.open()` is a cold boot.** Roughly 22 seconds when the container is
not already up, occasionally far longer. The client's default timeout is 300s
for exactly this reason. Do not race it with a shorter one.

**`restart` does not pick up a new container image.** It re-runs the boot script
inside the container that already exists, and a container keeps the image it was
created with until it actually stops. If you are verifying an image change, this
will quietly measure the old one.

## Errors

Everything throws `EzilError`, with `code` (the tRPC code), `status` and `path`,
plus two shortcuts worth branching on:

```ts
import { EzilError } from '@ezil-os/sdk';

try {
    await ezil.computers.get(id);
} catch (err) {
    if (err instanceof EzilError && err.isUnauthorized) {
        // Usually an expired access token — refresh it; retrying as-is won't help.
    }
}
```

## How this stays true

The types here are hand-written rather than imported from the app, so the
package stands alone. `src/surface.test.ts` is the other half of that trade: it
reads the real routers in `app/src/server/api/routers/` and fails if this client
calls a procedure the server doesn't have, or if the server grows one nobody
decided about. Run `bun test` to check it.

## License

AGPL-3.0-only, like the rest of EZiL-OS. See [`../LICENSE`](../LICENSE).
