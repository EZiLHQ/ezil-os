#!/usr/bin/env node
// EZiL Universe environment contract checker (v1). Byte-identical in ezil-work, ezil-os and
// ezil-ai-gateway; see docs/ENVIRONMENT-CONTRACT.md. No dependencies, never prints a secret value.
//
//   node .github/scripts/env-contract.mjs check
//   node .github/scripts/env-contract.mjs assert-job --environment preview|production
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PHASES = ['pre-cutover', 'post-cutover'];
const REF = /^[a-z]{20}$/;
const ROUTES = { local: 'preview', test: 'preview', pull_request: 'preview', main: 'production', release: 'production' };

export function loadContract(root = process.cwd()) {
  const raw = readFileSync(resolve(root, '.github/environment-contract.json'));
  return { contract: JSON.parse(raw), sha256: createHash('sha256').update(raw).digest('hex') };
}

export function loadManifestProject(root = process.cwd()) {
  return JSON.parse(readFileSync(resolve(root, '.github/production-migrations.json'), 'utf8')).project;
}

// Static invariants of the contract and this repo's production migration manifest.
export function checkContract(contract, manifestProject) {
  const errors = [];
  if (contract.version !== 1) errors.push(`unsupported contract version ${contract.version}`);
  if (!PHASES.includes(contract.phase)) errors.push(`unknown phase ${contract.phase}`);
  const { preview, production } = contract.projects ?? {};
  if (!REF.test(preview ?? '')) errors.push('projects.preview is not a Supabase project ref');
  if (!REF.test(production ?? '')) errors.push('projects.production is not a Supabase project ref');
  if (preview === production) errors.push('projects.preview and projects.production must differ');
  for (const [trigger, env] of Object.entries(ROUTES)) {
    if (contract.routing?.[trigger] !== env) errors.push(`routing.${trigger} must be ${env}`);
  }
  const names = contract.productionCredentialNames;
  if (!Array.isArray(names) || !names.includes('SUPABASE_ACCESS_TOKEN')) {
    errors.push('productionCredentialNames must include SUPABASE_ACCESS_TOKEN');
  }
  if (contract.phase === 'pre-cutover') {
    if (!REF.test(contract.legacyProduction ?? '')) errors.push('pre-cutover requires legacyProduction');
    if (manifestProject !== contract.legacyProduction) {
      errors.push(`pre-cutover: production-migrations.json project ${manifestProject} must equal legacyProduction ${contract.legacyProduction}`);
    }
  }
  if (contract.phase === 'post-cutover' && manifestProject !== production) {
    errors.push(`post-cutover: production-migrations.json project ${manifestProject} must equal projects.production ${production}`);
  }
  return errors;
}

// Runtime invariants of one CI job. `env` is the job's process environment.
export function checkJob(contract, environment, env) {
  const errors = [];
  if (environment === 'preview') {
    for (const name of contract.productionCredentialNames ?? []) {
      if ((env[name] ?? '') !== '') errors.push(`production credential ${name} is present in a preview job`);
    }
    for (const [name, value] of Object.entries(env)) {
      if (contract.phase === 'post-cutover' && String(value).includes(contract.projects.production)) {
        errors.push(`preview job variable ${name} names the production project`);
      }
    }
  } else if (environment === 'production') {
    const ref = env.GITHUB_REF ?? '';
    if (env.GITHUB_EVENT_NAME === 'pull_request' || env.GITHUB_EVENT_NAME === 'pull_request_target') {
      errors.push('production job must not run for a pull request');
    }
    if (ref !== 'refs/heads/main' && !/^refs\/tags\/v[0-9]/.test(ref)) {
      errors.push(`production job must run from refs/heads/main or a v* tag, not ${ref || '(unset)'}`);
    }
  } else {
    errors.push(`unknown environment ${environment}`);
  }
  return errors;
}

export function targetProject(contract, environment) {
  if (environment === 'production') {
    return contract.phase === 'pre-cutover' ? contract.legacyProduction : contract.projects.production;
  }
  return contract.phase === 'pre-cutover' ? null : contract.projects.preview;
}

function main(argv) {
  const [command, flag, environment] = argv;
  const { contract, sha256 } = loadContract();
  const errors = checkContract(contract, loadManifestProject());
  if (command === 'assert-job') {
    if (flag !== '--environment') errors.push('usage: assert-job --environment preview|production');
    else errors.push(...checkJob(contract, environment, process.env));
  } else if (command !== 'check') {
    errors.push(`unknown command ${command}`);
  }
  const report = {
    contract_sha256: sha256,
    phase: contract.phase,
    environment: command === 'assert-job' ? environment : undefined,
    database_writes_target: command === 'assert-job' ? targetProject(contract, environment) : undefined,
    decision: errors.length ? 'refused' : 'ok',
  };
  console.log(`env-contract ${JSON.stringify(report)}`);
  for (const error of errors) console.error(`env-contract: ${error}`);
  return errors.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
