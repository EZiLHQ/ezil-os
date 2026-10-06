/** Stop only the designated test computer after rollout, before cold acceptance. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cleanupHostedComputer } from './cleanup-hosted-computer.mjs';

const evidence = await cleanupHostedComputer();
mkdirSync('hosted-continuity-evidence', { recursive: true });
writeFileSync('hosted-continuity-evidence/initial-stop.json', JSON.stringify(evidence, null, 2));
console.log(evidence.ok ? 'PASS isolated computer prepared for cold acceptance' : 'FAIL isolated computer preparation');
if (!evidence.ok) process.exitCode = 1;
