/** Check actual producer output against the built supervisor in Node. This is
 * cross-package contract acceptance, not file transfer or cloud readiness. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

const root = process.env.EZIL_TEST_SUPERVISOR_ROOT;
const snapshots = process.env.EZIL_TEST_CONFIGURATION_OUTPUT;
assert.ok(root && isAbsolute(root), 'Absolute supervisor checkout is required');
assert.ok(snapshots && isAbsolute(snapshots), 'Absolute producer output path is required');
const script = `
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {parseHostConfig}=await import(pathToFileURL(process.argv[1]+'/supervisor/dist/host-config.js'));
const {canonicalJson}=await import(pathToFileURL(process.argv[1]+'/supervisor/dist/control-protocol.js'));
const snapshots=JSON.parse(readFileSync(process.argv[2],'utf8'));
assert.ok(snapshots.length>0);
let prepared=false, approved=false, suspended=false, replacement=false;
for(const row of snapshots){
 const value=parseHostConfig(JSON.parse(row.configuration));
 assert.equal(canonicalJson(value),row.configuration);
 assert.equal(createHash('sha256').update(canonicalJson(value)).digest('hex'),row.digest);
 prepared ||= value.preparedInstallations.length>0 && value.approvedInstallations.length===0;
 approved ||= value.approvedInstallations.length>0;
 suspended ||= value.suspended && value.preparedInstallations.length===0;
 replacement ||= value.computerGeneration>1;
}
assert.ok(prepared&&approved&&suspended&&replacement);
console.log('PASS '+snapshots.length+' actual producer snapshots: host production schema, defaults and canonical digest; prepared, executable, suspended and replacement records');
`;
const result = spawnSync('node', ['--input-type=module', '-e', script, root, snapshots], { stdio: 'inherit' });
assert.equal(result.status, 0, 'actual supervisor contract check failed');
