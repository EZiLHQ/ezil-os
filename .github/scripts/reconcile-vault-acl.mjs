#!/usr/bin/env node
// One reviewed OS registry transition. Never execute GRANT/REVOKE or replay SQL.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorize, validate, query, catalogSQL, journalShape, eventTriggersSQL, snapshotHash } from './production-migrations.mjs';

const repository = 'EZiLHQ/ezil-os';
const project = 'btgqfmnzycdecmeyqubx';
const oldDigest = '4c1040575121990dbd5ad09e40c0e334be4a291e4e746fc20a08d8c07a036e7f';
const newDigest = 'e63f1fd705c4204eb370d8020182ef423d0a5df9a10c3122e0cc550fdd57f090';
const sourceDigest = 'e884a81df52d591799e97b1ca59685fa7a70449d91de414c777866f5a26438f5';
const objects = 1794;
const serverVersion = '170006';
const registeredAt = '2026-09-29T16:41:32.074836Z';
const oldACL = '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
const newACL = '{postgres=X/postgres,service_role=X/postgres}';
const literal = value => `E'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const assertSQL = (condition, message) => `IF (${condition}) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION ${literal(message)}; END IF;`;

export function pinnedManifest(manifest) {
  check(manifest.version === 1 && manifest.repository === repository && manifest.project === project &&
    JSON.stringify(manifest.schemas) === '["public"]' &&
    JSON.stringify(manifest.trustedWorkflowRuns) === '[343124584]' &&
    manifest.initialCatalog?.digest === newDigest && manifest.initialCatalog.objects === objects &&
    manifest.initialCatalog.sourceDigest === sourceDigest &&
    manifest.initialCatalog.capturedAt === '2026-09-29T15:45:14.939Z' &&
    manifest.migrations.length === 0 && manifest.sources.length === 3 &&
    manifest.sources.every(source => source.kind === 'snapshot') && snapshotHash(manifest) === sourceDigest,
  'Manifest differs from the reviewed vault ACL transition');
}

export function transitionSQL(manifest) {
  pinnedManifest(manifest);
  const repo = literal(repository.toLowerCase());
  const identity = `repository=${repo} AND project=${literal(project)} AND schemas='["public"]'::jsonb AND snapshots=${literal(sourceDigest)} AND registered_at=${literal(registeredAt)}::timestamptz`;
  const events = assertSQL(`(SELECT triggers FROM (${eventTriggersSQL()}) e)=${json([...manifest.reviewedEventTriggers].sort((a,b) => a.name < b.name ? -1 : 1))}`, 'Active event triggers differ from reviewed inventory');
  const body = `DECLARE catalog record; routine_identity text; reconstructed text; registered text; changed integer := 0; BEGIN
    PERFORM pg_advisory_xact_lock(1702521196, 1835624306);
    ${assertSQL("current_user='postgres' AND current_setting('server_version_num')=" + literal(serverVersion), 'Vault ACL transition requires reviewed postgres identity/version')}
    ${events}
    ${assertSQL("(SELECT nspowner='postgres'::regrole FROM pg_namespace WHERE nspname='ezil_ci') AND to_regclass('ezil_ci.baselines') IS NOT NULL AND to_regclass('ezil_ci.journal') IS NOT NULL", 'Existing registry/owner required')}
    LOCK TABLE ezil_ci.baselines, ezil_ci.journal IN SHARE ROW EXCLUSIVE MODE;
    ${assertSQL("NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ezil_ci' AND (c.relowner<>'postgres'::regrole OR c.relname NOT IN ('baselines','baselines_pkey','journal','journal_pkey','journal_repository_ordinal_key')))", 'Unknown journal object/owner')}
    ${assertSQL("NOT EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE n.nspname='ezil_ci' AND a.grantee<>n.nspowner)", 'Journal schema must be private')}
    ${assertSQL("NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ezil_ci' AND NOT t.tgisinternal)", 'Unexpected journal trigger')}
    ${journalShape()}
    ${assertSQL(`(SELECT count(*) FROM ezil_ci.baselines WHERE ${identity} AND initial_catalog IN (${literal(oldDigest)},${literal(newDigest)}))=1`, 'Vault ACL baseline identity drift')}
    ${assertSQL(`NOT EXISTS (SELECT 1 FROM ezil_ci.baselines WHERE repository<>${repo} AND schemas ? 'public')`, 'Owned schemas overlap another repository')}
    ${assertSQL(`NOT EXISTS (SELECT 1 FROM ezil_ci.journal WHERE repository=${repo})`, 'Vault ACL transition requires zero OS journal rows')}
    ${assertSQL(`(SELECT prokind='f' AND proowner='postgres'::regrole AND proacl::text=${literal(newACL)} FROM pg_proc WHERE oid=to_regprocedure('public.get_vault_secret(text)'))`, 'Vault routine signature/owner/ACL differs from security fix')}
    ${assertSQL("NOT has_function_privilege('anon','public.get_vault_secret(text)','EXECUTE') AND NOT has_function_privilege('authenticated','public.get_vault_secret(text)','EXECUTE') AND NOT EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid='public.get_vault_secret(text)'::regprocedure AND a.grantee=0)", 'Vault routine must deny anon/authenticated/PUBLIC access')}
    SELECT 'public.get_vault_secret('||pg_get_function_identity_arguments('public.get_vault_secret(text)'::regprocedure)||')' INTO routine_identity;
    SELECT * INTO catalog FROM (${catalogSQL(['public'], true)}) c;
    ${assertSQL(`catalog.digest=${literal(newDigest)} AND catalog.objects=${objects} AND catalog.schemas=1`, 'Current catalog differs from reviewed vault ACL digest/count')}
    ${assertSQL(`(SELECT count(*) FROM jsonb_array_elements(catalog.body) entry WHERE entry->>0='routine' AND entry->>1=routine_identity AND entry->2->>2=${literal(newACL)})=1`, 'Expected exactly one vault routine catalog entry')}
    -- Only the local JSON value changes. The live routine is never modified.
    SELECT encode(sha256(convert_to(jsonb_agg(
      CASE WHEN entry->>0='routine' AND entry->>1=routine_identity
        THEN jsonb_set(entry,'{2,2}',to_jsonb(${literal(oldACL)}::text),false) ELSE entry END
      ORDER BY position)::text,'UTF8')),'hex') INTO reconstructed
      FROM jsonb_array_elements(catalog.body) WITH ORDINALITY entries(entry,position);
    ${assertSQL(`reconstructed=${literal(oldDigest)}`, 'Old catalog reconstruction differs; ACL is not the sole change')}
    SELECT initial_catalog INTO registered FROM ezil_ci.baselines WHERE ${identity};
    IF registered=${literal(oldDigest)} THEN
      UPDATE ezil_ci.baselines SET initial_catalog=${literal(newDigest)} WHERE ${identity} AND initial_catalog=${literal(oldDigest)};
      GET DIAGNOSTICS changed = ROW_COUNT;
      ${assertSQL('changed=1', 'Vault ACL transition must update exactly one baseline')}
    END IF;
    ${assertSQL(`(SELECT count(*) FROM ezil_ci.baselines WHERE ${identity} AND initial_catalog=${literal(newDigest)})=1`, 'Vault ACL baseline update failed')}
    ${assertSQL(`(SELECT digest FROM (${catalogSQL(['public'])}) c)=${literal(newDigest)}`, 'Catalog changed during vault ACL transition')}
    ${events}
    PERFORM set_config('ezil_ci.vault_acl_transition_changed',changed::text,true);
  END`;
  return `BEGIN; SET LOCAL search_path=pg_catalog; SET LOCAL standard_conforming_strings=on; SET LOCAL lock_timeout='30s'; SET LOCAL statement_timeout='120s'; DO ${literal(body)}; SELECT current_setting('ezil_ci.vault_acl_transition_changed')::integer changed; COMMIT;`;
}

export async function run(argv, options = {}) {
  check(argv.length === 1 && argv[0] === 'reconcile', 'Usage: reconcile-vault-acl.mjs reconcile');
  const root = options.root ?? fileURLToPath(new URL('../../', import.meta.url));
  const { manifest } = await validate(root);
  const sql = transitionSQL(manifest);
  const env = options.env ?? process.env;
  check(env.EZIL_DEPLOY_TARGET === 'production' && env.EZIL_TRANSITION_TRUSTED === 'true' &&
    env.EZIL_TRANSITION_STAGING === 'success' && env.EZIL_TRANSITION_IMAGES === 'success' &&
    env.EZIL_TRANSITION_LEASE === 'success', 'Vault ACL transition requires trusted production gates and acquired lease');
  const sha = await authorize(manifest, { ...options, root });
  check(sha === env.EZIL_DEPLOY_SHA, 'Vault ACL transition source differs from admitted release');
  const rows = await query(project, sql, options);
  check(rows.length === 1 && [0, 1].includes(rows[0].changed), 'Missing vault ACL transition receipt; reconcile by rerun');
  (options.log ?? console.log)(JSON.stringify({ repository, project, sha, vaultACLTransition: rows[0].changed === 1 ? 'reconciled' : 'already reconciled', digest: newDigest }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
