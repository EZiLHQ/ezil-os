// Build-time only. The bundle enters via a private BuildKit secret, never the source tree.
import { readFile, mkdir, copyFile, chmod, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const [bundle, pinFile, destination] = process.argv.slice(2);
if (!bundle || !pinFile || destination !== '/opt/ezil-cli') throw new Error('Invalid private CLI build inputs');
const pin = JSON.parse(await readFile(pinFile, 'utf8'));
if (!/^0\.2\.[0-9]+-repo-url-open\.20261026\.[0-9]+$/.test(pin.version) || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error('Invalid private CLI pin');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Private CLI requires Node 22 or newer');
if (createHash('sha256').update(await readFile(bundle)).digest('hex') !== pin.sha256) throw new Error('Private CLI checksum mismatch');
await mkdir(destination, { recursive: true });
await copyFile(bundle, `${destination}/ezil`);
await chmod(`${destination}/ezil`, 0o755);
await writeFile(`${destination}/pin.json`, JSON.stringify(pin) + '\n', { mode: 0o644 });
