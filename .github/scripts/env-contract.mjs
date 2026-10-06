#!/usr/bin/env node
// EZiL Universe environment contract checker (v1). Byte-identical in ezil-work, ezil-os and
// ezil-ai-gateway; see docs/ENVIRONMENT-CONTRACT.md. No dependencies, never prints a secret value.
//
//   node .github/scripts/env-contract.mjs check --repo <name>
//   node .github/scripts/env-contract.mjs scan --repo <name>
//   node .github/scripts/env-contract.mjs assert-job --repo <name> --environment preview|production
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PHASES = ['pre-cutover', 'post-cutover'];
const REF = /^[a-z]{20}$/;
const ROUTES = { local: 'preview', test: 'preview', pull_request: 'preview', main: 'production', release: 'production' };
const assertCommand = (repo, environment) =>
  `node .github/scripts/env-contract.mjs assert-job --repo ${repo} --environment ${environment}`;

export function loadContract(root = process.cwd()) {
  const raw = readFileSync(resolve(root, '.github/environment-contract.json'));
  return { contract: JSON.parse(raw), sha256: createHash('sha256').update(raw).digest('hex') };
}

export function loadManifestProject(root = process.cwd()) {
  return JSON.parse(readFileSync(resolve(root, '.github/production-migrations.json'), 'utf8')).project;
}

// Static invariants of the contract and this repo's production migration manifest.
export function checkContract(contract, manifestProject, repo) {
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
  if (!Array.isArray(contract.forbiddenOutsideProduction) || contract.forbiddenOutsideProduction.length === 0) {
    errors.push('forbiddenOutsideProduction must be a non-empty list');
  }
  const rules = contract.repos?.[repo];
  if (!rules) errors.push(`repo ${repo ?? '(unset)'} is not in the contract`);
  else {
    for (const key of ['previewJobs', 'productionJobs', 'secretInheritance', 'productionRefs']) {
      if (!Array.isArray(rules[key])) errors.push(`repos.${repo}.${key} must be a list`);
    }
    if (!rules.productionJobs?.length) errors.push(`repos.${repo}.productionJobs must not be empty`);
    if (!rules.productionRefs?.includes('refs/heads/main')) errors.push(`repos.${repo}.productionRefs must include refs/heads/main`);
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

const refAllowed = (ref, patterns) =>
  patterns.some((p) => (p.endsWith('*') ? ref.startsWith(p.slice(0, -1)) && ref.length > p.length - 1 : ref === p));

// Runtime invariants of one CI job. `env` is the job's process environment.
export function checkJob(contract, repo, environment, env) {
  const errors = [];
  const rules = contract.repos?.[repo];
  if (!rules) return [`repo ${repo ?? '(unset)'} is not in the contract`];
  const actual = (env.GITHUB_REPOSITORY ?? '').split('/').pop()?.toLowerCase();
  if (actual && actual !== repo) errors.push(`--repo ${repo} does not match GITHUB_REPOSITORY`);
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
    if (!refAllowed(ref, rules.productionRefs ?? [])) {
      errors.push(`production job must run from ${rules.productionRefs.join(' or ')}, not ${ref || '(unset)'}`);
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

// Indentation outline of a YAML block document: enough to find jobs, job keys and steps without
// a YAML dependency. Each node keeps its own line and its whole subtree's text.
export function outline(text) {
  const root = { indent: -1, line: '', children: [] };
  const stack = [root];
  for (const raw of text.split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    while (stack.at(-1).indent >= indent) stack.pop();
    const node = { indent, line: raw.trim(), children: [] };
    stack.at(-1).children.push(node);
    stack.push(node);
  }
  return root;
}
const render = (node) => [node.line, ...node.children.map(render)].join('\n');
const key = (node) => /^(?:- )?([A-Za-z0-9_-]+):/.exec(node.line)?.[1];
const child = (node, name) => node.children.find((c) => key(c) === name && !c.line.startsWith('- '));

export function parseWorkflow(text) {
  const root = outline(text);
  const jobsNode = root.children.find((c) => c.line === 'jobs:');
  const workflowText = root.children.filter((c) => c !== jobsNode).map(render).join('\n');
  const jobs = (jobsNode?.children ?? []).map((node) => {
    const stepsNode = child(node, 'steps');
    const steps = (stepsNode?.children ?? []).map((step) => {
      // A step's own keys: the first key on its "- " line plus its direct children.
      const keys = [key(step), ...step.children.map(key)].filter(Boolean);
      return { text: render(step), keys };
    });
    const env = child(node, 'environment');
    const head = node.children.filter((c) => c !== stepsNode).map(render).join('\n');
    return { name: key(node), text: render(node), head, environment: env ? render(env) : '', steps };
  });
  return { workflowText, jobs };
}

const squash = (s) => s.replace(/\s+/g, ' ');

// Static policy over every workflow file of a repo.
export function scanWorkflows(contract, repo, files) {
  const errors = [];
  const rules = contract.repos?.[repo];
  if (!rules) return [`repo ${repo ?? '(unset)'} is not in the contract`];
  const names = contract.productionCredentialNames ?? [];
  const forbidden = contract.forbiddenOutsideProduction ?? [];
  const designated = new Set([...rules.previewJobs, ...rules.productionJobs, ...rules.secretInheritance]);
  const seen = new Set();
  let scanStep = false;
  const banned = (where, text) => {
    for (const name of names) if (text.includes(name)) errors.push(`${where} names production credential ${name}`);
    for (const pattern of forbidden) if (squash(text).includes(pattern)) errors.push(`${where} contains ${pattern}`);
  };
  for (const [file, text] of Object.entries(files)) {
    const { workflowText, jobs } = parseWorkflow(text);
    banned(`${file} (workflow level)`, workflowText);
    for (const job of jobs) {
      const id = `${file}#${job.name}`;
      seen.add(id);
      const isProduction = rules.productionJobs.includes(id);
      if (squash(job.text).includes(`env-contract.mjs scan --repo ${repo}`) && !isProduction) scanStep = true;
      if (/^secrets: inherit$/m.test(job.text) && !rules.secretInheritance.includes(id)) {
        errors.push(`${id} uses secrets: inherit but is not in repos.${repo}.secretInheritance`);
      }
      if (isProduction) {
        checkAssertedJob(errors, id, job, assertCommand(repo, 'production'), names, true);
        if (!/production/i.test(job.environment)) errors.push(`${id} must use the production environment`);
        continue;
      }
      banned(id, job.text);
      if (/production/i.test(job.environment)) errors.push(`${id} is not a production job but names a production environment`);
      if (rules.previewJobs.includes(id)) checkAssertedJob(errors, id, job, assertCommand(repo, 'preview'), names, false);
    }
  }
  for (const id of designated) if (!seen.has(id)) errors.push(`designated job ${id} does not exist`);
  if (!scanStep) errors.push(`no non-production job runs env-contract.mjs scan --repo ${repo}`);
  return errors;
}

// The assertion is one fail-closed step that runs before any secret reaches a step. For production
// jobs, credential names may not appear in the job head (job-level env) either.
function checkAssertedJob(errors, id, job, command, names, production) {
  const index = job.steps.findIndex((s) => squash(s.text).includes(command));
  if (index < 0) return errors.push(`${id} must run: ${command}`);
  const step = job.steps[index];
  if (step.keys.includes('if') || step.keys.includes('continue-on-error')) {
    errors.push(`${id} contract assertion must not have if: or continue-on-error`);
  }
  if (/secrets\./.test(step.text)) errors.push(`${id} contract assertion step must not bind secrets`);
  const firstSecret = job.steps.findIndex((s) => /secrets\.|secrets\[/.test(s.text));
  if (firstSecret >= 0 && firstSecret < index) errors.push(`${id} uses a secret in a step before its contract assertion`);
  if (production) {
    for (const name of names) if (job.head.includes(name)) errors.push(`${id} binds ${name} at job level, before its contract assertion`);
    const firstWrite = job.steps.findIndex((s) => /production-migrations|supabase /.test(s.text));
    if (firstWrite >= 0 && firstWrite < index) errors.push(`${id} touches the database before its contract assertion`);
  }
}

export function readWorkflows(root = process.cwd()) {
  const dir = resolve(root, '.github/workflows');
  return Object.fromEntries(readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()
    .map((f) => [f, readFileSync(resolve(dir, f), 'utf8')]));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined) return { command, bad: true };
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, flags };
}

function main(argv) {
  const { command, flags = {}, bad } = parseArgs(argv);
  const repo = flags.repo;
  const { contract, sha256 } = loadContract();
  const errors = bad ? ['malformed flags'] : checkContract(contract, loadManifestProject(), repo);
  if (command === 'assert-job') errors.push(...checkJob(contract, repo, flags.environment, process.env));
  else if (command === 'scan') errors.push(...scanWorkflows(contract, repo, readWorkflows()));
  else if (command !== 'check') errors.push(`unknown command ${command}`);
  const report = {
    contract_sha256: sha256,
    repo,
    phase: contract.phase,
    command,
    environment: command === 'assert-job' ? flags.environment : undefined,
    database_writes_target: command === 'assert-job' ? targetProject(contract, flags.environment) : undefined,
    decision: errors.length ? 'refused' : 'ok',
  };
  console.log(`env-contract ${JSON.stringify(report)}`);
  for (const error of errors) console.error(`env-contract: ${error}`);
  return errors.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
