import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const files = [['stage.py', 'REPO_OPEN_STAGE'], ['supervise.py', 'REPO_OPEN_SUPERVISOR']];
const lines = ['/** Generated from worker/repo-open/*.py; run `node worker/repo-open/generate.mjs`. */'];
for (const [name, label] of files) {
  const bytes = fs.readFileSync(join(directory, name));
  lines.push(`export const ${label}_B64 = ${JSON.stringify(bytes.toString('base64'))};`);
  lines.push(`export const ${label}_SHA256 = ${JSON.stringify(createHash('sha256').update(bytes).digest('hex'))};`);
}
fs.writeFileSync(join(directory, '../src/repo-open-runtime.generated.ts'), lines.join('\n') + '\n');
