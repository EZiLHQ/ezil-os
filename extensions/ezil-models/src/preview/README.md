# App preview

`ezil.preview.open` restores the auxiliary bar and opens an editor webview without moving focus. The extension uses only `_ezil.previewMint` and `_ezil.chatAddContext`; the renderer, bridge, inspector and shell implementations belong to the lead.

`contract.ts` contains the pure v1 validators. `messages.ts` gates inspector messages by source, pinned origin, current hello and Select mode. `context.ts` serializes attachment updates so a slow add cannot overwrite a stale update. `state.ts` constructs the only persisted record: `{open:true,path,viewport}`. Minted URLs stay in memory and are never displayed, copied, opened externally, or persisted.

The displayed address is origin plus the sanitized in-app path. Frame Reload, Back/Forward, Copy and Open use `transportUrl`: Cloudflare adds `/preview`, AWS serves the app at the root. Query and fragment credentials and URL userinfo are stripped from these safe URLs. Initial mint/bootstrap navigation still carries its authorization in memory.

The amended contract caps `source.eid` at 1..200 characters and selection JSON at 12000 UTF-16 code units, checked before schema validation. Markdown fields are bounded before escaping and retain whole escapes within output budgets totaling 3144 characters; labels and validated numeric metadata keep the complete attachment below 4000. A change in document generation, mutation counter or path queues exactly one stale update and immediately stops tracking that attachment ID.

`webview.ts` is the browser source. Both `bun run build` and `worker/ezil-models/build-vsix.sh` regenerate `script.generated.ts` before bundling the extension. Keep the generated file committed. The browser script is embedded in `extension.js`, with a nonce; no additional runtime media file is needed. The generator fixes its working directory so source comments are reproducible across entry points. `bun run src/preview/build-script.ts --check` refuses stale output without rewriting it, and the VSIX builder's `--check` runs that check before bundling.

Tests verify the generated source fingerprint, execute the browser payload, exercise stale-output detection, and extract the embedded script from a real extension build for an exact comparison. They package that build and check all nine archive entries, bundle bytes and the `ezil.preview.open` contribution. The packager also refuses bundles lacking the `ezil.preview` serializer or any inspector message type. No new dependencies are needed.

Run `bun test`, `bun run typecheck`, and `bun run build` from `extensions/ezil-models`.

## Integration follow-up

- The AWS validator retains the existing pattern: `aws-3002-guac-<user>-<computer>-aws.<zone>` (each identifier part is 1–16 lowercase alphanumeric characters).
- The selection schema omits contenteditable and autocomplete indicators. Downstream validators can reject input/textarea/select text, password-type text, placeholders and unknown attributes, but cannot independently identify contenteditable or autocomplete credential text. The inspector must perform those exclusions.
- The actual nested VS Code webview parent origin has not been observed in a running workbench here. Verify it against the inspector's parent allow-list during integration. No origin check has been broadened. An unaccepted parent leaves the panel waiting for the app and offers Retry.

Unit and browser-bundle tests cover layout API calls and the inspector handshake, but they cannot establish the real browser origin, cookie behavior, composer focus, or renderer hook integration. The deterministic VSIX command requires Bun 1.3.14. A local archive made with another Bun version can validate contents but cannot replace the pinned committed artifact or establish byte reproducibility against CI.
