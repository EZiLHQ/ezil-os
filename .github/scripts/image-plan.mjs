import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function imagePlan(sha, tree) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Full source SHA required');
  const hash = (...parts) => createHash('sha256').update(parts.join('\0')).digest('hex');
  // Tree objects include paths, modes and content; overlay also includes its base inputs.
  const base = hash('base-v1', tree('docker/neko'), tree('.github/scripts/image-plan.mjs'), tree('.github/scripts/build-images.sh'));
  const continuity = hash('continuity-v1', tree('worker/neko'));
  const overlay = hash('overlay-v2', base, continuity, tree('worker/assets/neko-branding'));
  return { source: sha, continuity: `ghcr.io/ezilhq/ezil-neko-continuity:sha-${continuity}`, base: `ghcr.io/ezilhq/ezil-neko-vscode:base-${base}`,
    overlay: `ghcr.io/ezilhq/ezil-neko-vscode:overlay-${overlay}`,
    desktop: `ghcr.io/ezilhq/ezil-os-desktop:sha-${sha}` };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = process.env.EZIL_DEPLOY_SHA;
  const plan = imagePlan(sha, p => execFileSync('git', ['rev-parse', `${sha}:${p}`], { encoding: 'utf8' }).trim());
  fs.writeFileSync('image-plan.json', JSON.stringify(plan, null, 2));
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(plan).map(([k,v]) => `${k}=${v}\n`).join(''));
}
