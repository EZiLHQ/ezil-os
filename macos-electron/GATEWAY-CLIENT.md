Gateway client configuration
============================

The trusted Electron host accepts `EZIL_WORKS_ORIGIN` and `EZIL_GATEWAY_ORIGIN`
at startup (or equivalent WorksSession constructor options). Defaults remain
`https://ezil-works-api.vercel.app` and `https://ai.ezil.work`. Values must be exact
HTTPS origins without paths, credentials, queries or fragments. These options
are not IPC, browser, workspace descriptor or per-request fields. Redirects fail.

Every new vault session records both origins. Legacy sessions belong to the two
production origins. A mismatch refuses all authenticated network activity,
including refresh, until a fresh sign-in on the selected services. Rotated tokens
retain the bindings and are persisted before subsequent requests.

Catalogs require `object: "list"`, a boolean killswitch and at most 100 validated
rows within 64 KiB. IDs are 1–128 ASCII letters/digits/dots/underscores/hyphens,
starting with a letter or digit. Duplicate IDs and malformed disabled rows fail
closed. Models supporting only chat_completions are hidden: this broker consumes
Responses and translates text only. Public capabilities remain false for tools,
structured output and reasoning controls; VS Code advertises toolCalling:false.

Native limits remain 32,768 input and 8,192 output tokens, with conservative
byte/framing input validation. VS Code retains its 8,192 input limit. Server
minimum and default output allowances are distinct from maximum output; omitted
minimum defaults to 16 and omitted default to 4,096, bounded by the model range.
Models whose minimum exceeds the client ceiling are hidden. Each logical chat
invocation has one Idempotency-Key; no inference is automatically retried.

Scope note: native Settings' preload.cjs status sanitizer still filters its
model-name summary to the original aliases; the broker and VS Code model catalog
use the dynamic registry. That separate UI file is outside this worker's ownership.
