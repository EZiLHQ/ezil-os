# App preview

`ezil.preview.open` restores the auxiliary bar and opens an editor webview without moving focus. The extension uses only `_ezil.previewMint` and `_ezil.chatAddContext`; the renderer, bridge, inspector and shell implementations belong to the lead.

`contract.ts` contains the pure v1 validators. `messages.ts` gates inspector messages by source, pinned origin, current hello and Select mode. `context.ts` serializes attachment updates so a slow add cannot overwrite a stale update. `state.ts` constructs the only persisted record: `{open:true,path,viewport}`. Minted URLs stay in memory and are never displayed, copied, opened externally, or persisted.

`webview.ts` is the browser source. `bun run build` regenerates `script.generated.ts` before bundling the extension. Keep the generated file committed: the existing offline VSIX builder bundles `src/extension.ts` directly and has an explicit package file list. The browser script is therefore embedded in `extension.js`, with a nonce, rather than shipped as an additional media file. A test checks the generated source fingerprint and executes the shipped browser payload. No runtime dependencies are needed.

Run `bun test`, `bun run typecheck`, and `bun run build` from `extensions/ezil-models`.

## Frozen contract gaps and integration follow-up

- The AWS app host pattern is referenced but not specified in the frozen contract or vectors. The validator follows `worker/src/aws-origin.ts`: `aws-3002-guac-<user>-<computer>-aws.<zone>` (each identifier part is 1–16 lowercase alphanumeric characters).
- The selection schema omits contenteditable and autocomplete indicators. Downstream validators can reject input/textarea/select text, password-type text, placeholders and unknown attributes, but cannot independently identify contenteditable or autocomplete credential text. The inspector must perform those exclusions.
- `source.eid` has no specified length bound. The validator accepts a control-free string and the renderer caps the entire Markdown attachment at 4000 characters. The contract should specify an eid bound in a future revision.
- The actual nested VS Code webview parent origin has not been observed in a running workbench here. Verify it against the inspector's frozen parent allow-list during integration. No origin check has been broadened. An unaccepted parent leaves the panel waiting for the app and offers Retry.

Unit and browser-bundle tests cover layout API calls and the inspector handshake, but they cannot establish the real browser origin, cookie behavior, composer focus, or renderer hook integration. The VSIX packaging command requires Bun 1.3.14; this workspace provides Bun 1.3.1. No VSIX or worker files are changed by this lane.
