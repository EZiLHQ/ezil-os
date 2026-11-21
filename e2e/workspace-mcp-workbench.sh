#!/usr/bin/env bash
# PLAYWRIGHT_REQUIRE_DIR=/path/to/node_modules e2e/workspace-mcp-workbench.sh <existing-staging-desktop-image>
set -euo pipefail
: "${PLAYWRIGHT_REQUIRE_DIR:?Set to a node_modules directory with Playwright installed}"
image="${1:?Pass the local staging desktop image}"
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
name="ezil-workspace-mcp-$(basename "$tmp" | tr '.' '-')"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
unzip -q "$here/../worker/ezil-models/dist/ezil-models-0.1.0.vsix" 'extension/*' -d "$tmp"
mkdir "$tmp/probe"
cat > "$tmp/probe/package.json" <<'MANIFEST'
{"name":"workspace-mcp-probe","publisher":"ezil-test","version":"1.0.0","engines":{"vscode":"^1.141.0"},"main":"./probe.cjs","extensionKind":["workspace"],"contributes":{"commands":[{"command":"ezil-test.probe","title":"QA: Invoke workspace_info"}]}}
MANIFEST
cat > "$tmp/probe/probe.cjs" <<'PROBE'
const vscode = require('vscode');
const fs = require('node:fs');
exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand('ezil-test.probe', async () => {
  let receipt = { available: false };
  const tool = vscode.lm.tools.find(entry => entry.name.startsWith('mcp_') && entry.name.endsWith('_workspace_info'));
  if (tool) {
    const response = await vscode.lm.invokeTool(tool.name, { input: {} });
    receipt = { available: true, tool: tool.name, text: response.content[0]?.value };
  }
  fs.writeFileSync('/tmp/workspace-info-probe.json', JSON.stringify(receipt));
}));
PROBE
docker network create --internal "$name" >/dev/null
docker create --name "$name" --pull never --network "$name" --cap-drop ALL --security-opt no-new-privileges \
  --user 65534:65534 -e HOME=/tmp/test-home -e XDG_DATA_HOME=/tmp/test-home/share -e XDG_CONFIG_HOME=/tmp/test-home/config \
  --entrypoint /bin/sh "$image" -ec '
    mkdir -p /tmp/test-home/config /tmp/user-data/User /tmp/owned-workspace
    echo fixture > /tmp/owned-workspace/Owner.txt
    cat > /tmp/user-data/User/settings.json <<EOF_SETTINGS
{"security.workspace.trust.enabled":false,"chat.allowAnonymousAccess":true,"workbench.startupEditor":"none","terminal.integrated.profiles.linux":{"bash":{"path":"/bin/bash"}},"terminal.integrated.defaultProfile.linux":"bash"}
EOF_SETTINGS
    exec code-server --auth none --bind-addr 0.0.0.0:8443 --disable-telemetry --disable-update-check --user-data-dir /tmp/user-data /tmp/owned-workspace
  ' >/dev/null
extensions=/usr/lib/code-server/lib/vscode/extensions
docker cp "$tmp/extension/." "$name:$extensions/ezil.ezil-models"
docker cp "$tmp/probe/." "$name:$extensions/ezil-test.workspace-mcp-probe"
docker start "$name" >/dev/null
ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$name\").IPAddress}}" "$name")"
curl --retry 30 --retry-connrefused --retry-delay 1 --max-time 10 -fsS "http://$ip:8443/healthz" -o /dev/null
node "$here/workspace-mcp-workbench.mjs" "$name" "$ip"
