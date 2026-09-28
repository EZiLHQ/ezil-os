// @bun
// checkpoint-ready.mjs
import { open, mkdir, writeFile, rename, rm, realpath } from "fs/promises";
import { constants } from "fs";
import { dirname, isAbsolute } from "path";
async function checkpointReady(env) {
  const path = env.EZIL_WORKSPACE_READY_MARKER || "/run/ezil/workspace-ready.json";
  let tmp;
  try {
    await rm(path, { force: true });
    const root = env.EZIL_WORKSPACE_ROOT;
    if (!root || !isAbsolute(root) || root === "/" || await realpath(root) !== root) {
      throw new Error;
    }
    const file = await open(`${root}/.ezil-hydrated.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let marker;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 64 * 1024)
        throw new Error;
      marker = JSON.parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
    if (marker?.version !== 1 || marker.mountPath !== root || typeof marker.prefix !== "string" || !marker.prefix || typeof marker.hydratedAt !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(marker.checkpoint ?? "")) {
      throw new Error;
    }
    await mkdir(dirname(path), { recursive: true });
    tmp = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify({
      ready: true,
      workspaceRoot: root,
      vscodeTargetRoot: root,
      hydratedAt: marker.hydratedAt,
      checkpoint: marker.checkpoint
    }), { mode: 384, flag: "wx" });
    await rename(tmp, path);
    return root;
  } catch {
    throw new Error("workspace checkpoint is not confirmed");
  } finally {
    if (tmp)
      await rm(tmp, { force: true }).catch(() => {});
  }
}

// workspace-bootstrap-entry.ts
async function main() {
  const root = await checkpointReady(process.env);
  process.stdout.write(`${root}
`);
}
main().catch(() => {
  process.stderr.write(`[workspace-bootstrap] fail-closed workspace_checkpoint_unconfirmed
`);
  process.exit(1);
});
