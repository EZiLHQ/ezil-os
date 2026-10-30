EZiL Models is licensed under AGPL-3.0-only (see LICENSE).

The Anthropic converter in `src/anthropic.ts` mirrors and derives conversion
behavior from Microsoft's [VS Code Copilot Chat](https://github.com/microsoft/vscode-copilot-chat),
including its `anthropicMessageConverter.ts`. Copyright (c) Microsoft Corporation.
The MIT license notice is preserved in that file and in the bundled JavaScript.
The rest of this extension retains the repository's AGPL-3.0-only license.

The gateway transport adapts EZiL-OS PR #164's session polling, idempotency,
model cache and credit-state helpers. The gateway conversation repair adapts
EZiL-OS PR #160's tool pairing, with the stricter Bedrock Converse contract.
