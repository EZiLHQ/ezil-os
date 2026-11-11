# R1: legacy workbench/extension handshake correction

Source-only correction following independent review of 1e7b4e11. No image/VSIX rebuild, activation or release approval.

New workbench hello returns `protocol:2, supportedProtocols:[1,2,3]`. The pinned old extension checks protocol===1||2, so it now reaches sync. New extension recognizes the additive workbench support list, intersects with backend support, and tags non-hello workbench requests `protocol:3` only when both peers support 3. Initial OS sync remains protocol 1 with no effort/capability fields.

Untagged workbench requests retain protocol-2 response shapes: no effort/selectedEffort/efforts/defaultEffort fields in snapshots, picker rows or control results. Explicit effort requests from legacy callers refuse. Protocol-3 responses carry observed effort only after explicit selection of that protocol. No broad transformation of user response text occurs. Existing owner/epoch, after-await, pending-approval and idempotency guards remain.

Regression `extensions/ezil-models/tests/chat-bridge-mixed-version.test.ts` evaluates actual client/workbench source from immutable old revision 92cdb3d412fb13c3a7a4b0bbc6885542b564b022, rather than substituting fake old hello responses. It tests old-client/new-workbench, new-client/old-workbench and new/new, initial sync, snapshot shapes, model-only NEW create and report shapes. HTTP/model services are synthetic; this is source integration, not native reload acceptance.

Commands/results:

- `bun test extensions/ezil-models/tests/chat-bridge-mixed-version.test.ts extensions/ezil-models/tests/chat-bridge-client.test.ts`: 24 pass / 0 fail. After adding model-only-create assertions, the mixed-version subset passed 3/3 with 29 assertions.
- `node --test worker/copilot-chat/chat-bridge.test.cjs`: 43 pass / 0 fail.
- `bun run --cwd extensions/ezil-models typecheck`: passed.

The real-bundle patch-test hello assertion was updated to this explicit wire contract, but no bundle/VSIX rebuild or patch build was run in this correction. Root's native persistence/fixture work remains separate.
