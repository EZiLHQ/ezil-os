import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = resolve(root, 'extensions/ezil-models/src/trace-validator.js');
const target = resolve(root, 'app/src/server/ai-traces/contract.js');
const { validateInferenceTrace } = await import(pathToFileURL(source).href);
const body = validateInferenceTrace.toString();
const output = '/** Generated build-local canonical validator. Run app/scripts/sync-ai-trace-contract.mjs.\n * No imports outside the allowlisted app Docker context. Source parity is tested. */\n'
    + 'export ' + body + '\nexport const INFERENCE_VALIDATOR_SOURCE = ' + JSON.stringify(body) + ';\n';
if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== output) throw new Error('AI trace contract copy differs from the canonical publisher validator');
} else await writeFile(target, output);
