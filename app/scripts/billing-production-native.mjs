// Opt-in production extension of billing-staging-schema.mjs.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const ROOT = new URL('../../', import.meta.url);
export const NATIVE_SQL_PINS = Object.freeze({
    "docs/aws-computers/sql/0001_compute_placement.sql.txt": "1cc5cf166326d58ed52714f0ba238e826f14b874661326596118318f58e6a09b",
    "docs/aws-computers/sql/0002_image_rebase.sql.txt": "cf986a4f75f5d815b48261a1f7b263717912b80d689b552ce5e8a2e7ddcd0034",
    "app/drizzle/0029_native_session_operations.sql": "8b1b6295a753aee5097a6d181dd25c698d6a5c85a9e6a245c46a5409b08daf3c",
    "app/drizzle/0030_delegation_replay.sql": "50ff0b0a441ee539ca5d72302443315be1f1812e6b11e4afb2e1af3f575692a7",
    "app/drizzle/0031_native_auth_intents.sql": "0f98fe7c4eb3aff87fb0be8a145973590915d7fa49663c24df83305e7ca3534e",
    "app/drizzle/0032_runtime_control.sql": "dc34110dc1fb6e005bd9a9abba99eac081a1b7fa3017b76bf50ce88358ac7e06",
    "app/drizzle/0033_native_grant_outbox.sql": "8e2f6e97726d647903b284bd35856f8829ee3661d48d75e55c1645aa3226ad1e"
});
const literal = value => "E'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";

// Existing release custody installs placement/image-rebase before native tables.
// Validate its actual catalog before any native schema or receipt mutation.
export function nativePreflight(expectRole, expectDatabase) {
    const columns = {
        ezil_computers: { id: 'uuid', user_id: 'uuid', slot: 'smallint', deleted_at: 'timestamp with time zone' },
        ezil_computer_placements: { computer_id: 'uuid', owner_user_id: 'uuid', provider: 'text', workspace_store: 'text',
            generation: 'bigint', lease_epoch: 'bigint', state: 'text', instance_id: 'text', fence_token: 'uuid',
            lease_until: 'timestamp with time zone', lower_image_digest: 'text', image_upgrade_job_id: 'uuid' },
        ezil_computer_image_jobs: { job_id: 'uuid', computer_id: 'uuid', owner_user_id: 'uuid', phase: 'text' },
    };
    const required = {
        ezil_computers: ['id','user_id','slot'],
        ezil_computer_placements: ['computer_id','owner_user_id','provider','generation','lease_epoch','state'],
        ezil_computer_image_jobs: ['job_id','computer_id','owner_user_id','phase'],
    };
    const checks = Object.entries(columns).flatMap(([table, fields]) => [
        "IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=" + literal(table) +
            " AND c.relkind='r' AND c.relrowsecurity AND pg_has_role(current_user,c.relowner,'USAGE')) THEN RAISE EXCEPTION 'Native placement prerequisite ownership/RLS mismatch'; END IF;",
        ...Object.entries(fields).map(([column, type]) => "IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(" + literal('public.' + table) +
            ") AND a.attname=" + literal(column) + (required[table].includes(column) ? " AND a.attnotnull" : "") + " AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)=" + literal(type) +
            ") THEN RAISE EXCEPTION 'Native placement prerequisite column mismatch'; END IF;"),
    ]);
    return "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'; DO $native_preflight$ BEGIN " +
        "IF current_user IS DISTINCT FROM " + literal(expectRole) + " OR session_user IS DISTINCT FROM " + literal(expectRole) +
        " OR current_database() IS DISTINCT FROM " + literal(expectDatabase) +
        " OR NOT has_schema_privilege(current_user,'public','USAGE,CREATE')" +
        " OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated')" +
        " THEN RAISE EXCEPTION 'Native production role/database/schema mismatch'; END IF; " + checks.join('\n') + " END $native_preflight$;";
}


const REPLAY_FILE = 'app/drizzle/0030_delegation_replay.sql';
export const NATIVE_PRODUCTION_FILES = Object.freeze(Object.keys(NATIVE_SQL_PINS).slice(2).filter(file => file !== REPLAY_FILE));
export const PRODUCTION_RECEIPT_ONLY_PINS = Object.freeze({
    // Already applied through the production operator path and absent from EXPLICIT_FILES.
    'app/drizzle/0023_operator_issued_by.sql': '7bae267c2e9a281c60d9e1e96cf8a64788e43dbfd51c65e44214182b6ead5c92',
    ...Object.fromEntries(NATIVE_PRODUCTION_FILES.map(file => [file, NATIVE_SQL_PINS[file]])),
});

const RELATION = 'public.ezil_staging_schema_log';
const guard = (label, sql) => 'DO $' + label + '$ BEGIN ' + sql + ' END $' + label + '$;';
const refuseIf = (expr, message) => 'IF ' + expr + ' THEN RAISE EXCEPTION ' + literal(message) + '; END IF;';
const values = entries => entries.map(({ file, sha256 }) => '(' + literal(file) + ',' + literal(sha256) + ')').join(',');
const exactReceipt = ({ file, sha256 }) => '(file=' + literal(file) + ' AND sha256=' + literal(sha256) + " AND mode='apply')";
const clientPrivilege = (relation, privilege) => ['anon', 'authenticated'].map(role =>
    'has_table_privilege(' + literal(role) + ',' + relation + ',' + literal(privilege) + ')'
).join(' OR ');

const receiptColumns = { file: 'text', sha256: 'text', mode: 'text', applied_at: 'timestamp with time zone' };
const logShape = guard('native_log_shape', [
    refuseIf("NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass(" + literal(RELATION) +
        ") AND relkind='r' AND relpersistence='p' AND pg_has_role(current_user,relowner,'USAGE'))", 'Untrusted native receipt relation'),
    refuseIf('(SELECT count(*) FROM pg_attribute WHERE attrelid=' + literal(RELATION) +
        '::regclass AND attnum>0 AND NOT attisdropped) <> 4', 'Native receipt columns mismatch'),
    ...Object.entries(receiptColumns).map(([column, type]) => refuseIf(
        'NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=' + literal(RELATION) + '::regclass AND attname=' + literal(column) +
        ' AND format_type(atttypid,atttypmod)=' + literal(type) +
        " AND attnotnull AND NOT attisdropped AND attgenerated='' AND attidentity='')", 'Native receipt column mismatch')),
    refuseIf('NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=' +
        literal(RELATION) + "::regclass AND a.attname='applied_at' AND pg_get_expr(d.adbin,d.adrelid)='now()')", 'Native receipt timestamp default mismatch'),
    refuseIf('NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_index i ON i.indexrelid=k.conindid ' +
        "JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attname='file' WHERE k.conrelid=" + literal(RELATION) +
        "::regclass AND k.contype='p' AND NOT k.condeferrable AND k.convalidated AND k.conkey=ARRAY[a.attnum]::smallint[] " +
        'AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate AND i.indpred IS NULL AND i.indexprs IS NULL ' +
        'AND i.indnkeyatts=1 AND i.indnatts=1)', 'Native receipts require an immediate primary key on file'),
    refuseIf(clientPrivilege(literal(RELATION), 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER'), 'Native receipts must not be client-writable'),
    refuseIf("EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=" + literal(RELATION) + '::regclass AND NOT tgisinternal)',
        'Native receipt relation has an unexpected trigger'),
].join('\n'));

// Bind enabled triggers and their functions, using stable names and definitions instead of OIDs.
const eventTriggerDigest = "SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_array(e.evtname,e.evtevent,e.evtenabled,e.evttags," +
    "r.rolname,n.nspname,p.proname,pg_get_userbyid(p.proowner),pg_get_functiondef(p.oid)) ORDER BY e.evtname)::text,'[]'),'UTF8')),'hex')" +
    " FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid JOIN pg_namespace n ON n.oid=p.pronamespace" +
    " JOIN pg_roles r ON r.oid=e.evtowner WHERE e.evtenabled <> 'D'";

function receiptGuard(legacy, native) {
    const names = native.map(({ file }) => literal(file)).join(',');
    const receiptOnly = Object.entries(PRODUCTION_RECEIPT_ONLY_PINS).map(([file, sha256]) => ({ file, sha256 }));
    const reviewed = new Map([...legacy, ...receiptOnly].map(entry => [entry.file, entry]));
    const replay = reviewed.get(REPLAY_FILE);
    const filesThatMustApply = [...receiptOnly, replay];
    const prerequisites = Object.keys(NATIVE_SQL_PINS).slice(0, 2);
    return guard('native_receipts', [
        refuseIf('EXISTS (SELECT 1 FROM ' + RELATION + ' AS logged LEFT JOIN (VALUES ' + values([...reviewed.values()]) +
            ') AS expected(file,sha256) ON expected.file=logged.file WHERE expected.file IS NULL OR logged.sha256<>expected.sha256' +
            " OR logged.mode NOT IN ('apply','baseline'))", 'Production receipt outside reviewed source or checksum mismatch'),
        refuseIf('EXISTS (SELECT 1 FROM ' + RELATION + ' WHERE file IN (' + filesThatMustApply.map(({ file }) => literal(file)).join(',') +
            ') AND NOT (' + filesThatMustApply.map(exactReceipt).join(' OR ') + '))', 'Production receipt apply mode mismatch'),
        refuseIf('NOT EXISTS (SELECT 1 FROM ' + RELATION + ' WHERE ' + exactReceipt(replay) + ')', 'Exact applied 0030 receipt required'),
        ...prerequisites.map(file => refuseIf('NOT EXISTS (SELECT 1 FROM ' + RELATION + ' WHERE file=' + literal(file) + ')',
            'Existing placement receipt required')),
        refuseIf('(SELECT count(*) FROM ' + RELATION + ' WHERE file IN (' + names + ')) NOT IN (0,' + native.length + ')',
            'Partial native receipt set requires owner reconciliation'),
    ].join('\n'));
}


const replayRelation = "'public.ezil_delegation_replay'::regclass";
const replayColumnCount = '(SELECT count(*) FROM pg_attribute WHERE attrelid=' + replayRelation + ' AND attnum>0 AND NOT attisdropped)';
const replayCatalog = guard('native_replay_catalog', [
    refuseIf(replayColumnCount + ' <> 2', 'Committed 0030 replay column count mismatch'),
    ...Object.entries({ jti: 'uuid', expires_at: 'timestamp with time zone' }).map(([column, type]) => refuseIf(
        'NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=' + replayRelation + ' AND attname=' + literal(column) +
        ' AND format_type(atttypid,atttypmod)=' + literal(type) +
        " AND attnotnull AND NOT attisdropped AND NOT atthasdef AND attidentity='' AND attgenerated='')", 'Committed 0030 replay column mismatch')),
    ...Object.entries({ ezil_delegation_replay_jti_key: 'jti', ezil_delegation_replay_expires_at_idx: 'expires_at' }).map(([name, column]) => refuseIf(
        'NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_am am ON am.oid=x.relam' +
        ' JOIN pg_attribute a ON a.attrelid=i.indrelid AND i.indkey[0]=a.attnum WHERE i.indrelid=' + replayRelation +
        ' AND x.relname=' + literal(name) + ' AND a.attname=' + literal(column) + " AND am.amname='btree'" +
        ' AND i.indisunique=' + (column === 'jti' ? 'true' : 'false') +
        ' AND i.indisvalid AND i.indisready AND i.indimmediate AND i.indpred IS NULL AND i.indexprs IS NULL' +
        ' AND i.indnkeyatts=1 AND i.indnatts=1)', 'Committed 0030 replay index mismatch')),
].join('\n'));

function catalogGuard(entries) {
    return guard('native_catalog', entries.flatMap(entry =>
        [...entry.sql.matchAll(/CREATE TABLE public\.([a-z_]+) \(/g)].map(([, table]) => {
            const relation = literal('public.' + table);
            const access = clientPrivilege('c.oid', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
            return refuseIf('EXISTS (SELECT 1 FROM ' + RELATION + ' WHERE file=' + literal(entry.file) + ')' +
                ' AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=to_regclass(' + relation +
                ") AND c.relkind='r' AND c.relpersistence='p' AND c.relrowsecurity AND pg_has_role(current_user,c.relowner,'USAGE')" +
                ' AND NOT (' + access + '))', 'Native receipt/catalog mismatch');
        })
    ).join('\n'));
}

export function runProductionNativeSchema({ mode, expectRole, expectDatabase, expectEventTriggerSha256, legacyFiles, psql, emit }) {
    const entries = Object.entries(NATIVE_SQL_PINS).map(([file, digest]) => {
        const bytes = readFileSync(new URL(file, ROOT));
        const sql = bytes.toString('utf8');
        if (createHash('sha256').update(bytes).digest('hex') !== digest || !Buffer.from(sql).equals(bytes)) {
            throw new Error('Native SQL source hash mismatch');
        }
        return { file, sha256: digest, sql };
    });
    const native = entries.filter(({ file }) => NATIVE_PRODUCTION_FILES.includes(file));
    const legacy = legacyFiles.filter(({ file }) => !Object.hasOwn(NATIVE_SQL_PINS, file));
    legacy.push(...entries.filter(({ file }) => !NATIVE_PRODUCTION_FILES.includes(file)));
    const verifyReceipts = receiptGuard(legacy, native);
    const verifyCatalog = catalogGuard(entries.filter(({ file }) => file.startsWith('app/drizzle/'))) + replayCatalog;
    const preflight = "SET LOCAL search_path=pg_catalog,public; " + nativePreflight(expectRole, expectDatabase) + logShape;
    if (mode === 'plan') {
        const receiptCount = 'SELECT count(*) FROM ' + RELATION + ' WHERE file IN (' +
            native.map(({ file }) => literal(file)).join(',') + ');';
        const output = psql(['--single-transaction', '-c', preflight +
            'LOCK TABLE ' + RELATION + ' IN ACCESS SHARE MODE;' + verifyReceipts + verifyCatalog + eventTriggerDigest + ';' + receiptCount],
        { readOnly: true });
        const [fingerprint, count, ...extra] = output.trim().split('\n');
        if (!/^[a-f0-9]{64}$/.test(fingerprint) || !['0', String(native.length)].includes(count) || extra.length) {
            throw new Error('Expected production catalog and receipt evidence');
        }
        emit('Production enabled event trigger SHA-256 ' + fingerprint);
        for (const entry of entries) {
            const status = NATIVE_PRODUCTION_FILES.includes(entry.file)
                ? (count === '0' ? 'pending native production batch' : 'exact apply receipt verified')
                : 'existing prerequisite; never applied here';
            emit(entry.file + '  ' + entry.sha256 + '  ' + status);
        }
        return 0;
    }

    const checkEventTriggers = guard('native_event_triggers', refuseIf(
        '(' + eventTriggerDigest + ') IS DISTINCT FROM ' + literal(expectEventTriggerSha256), 'Production event trigger fingerprint mismatch'
    ));
    const ddl = native.map(entry => guard('native_apply', 'IF NOT EXISTS (SELECT 1 FROM ' + RELATION + ' WHERE file=' + literal(entry.file) +
        ') THEN EXECUTE ' + literal(entry.sql) + '; INSERT INTO ' + RELATION + ' (file,sha256,mode) VALUES (' +
        literal(entry.file) + ',' + literal(entry.sha256) + ",'apply'); END IF;")).join('\n');
    // The already-applied replay ledger is checked under the lock and never enters this DDL batch.
    psql(['--single-transaction', '-c', preflight + 'SELECT pg_advisory_xact_lock(1851880553,20261117);' +
        'LOCK TABLE ' + RELATION + ' IN SHARE ROW EXCLUSIVE MODE;' +
        logShape + verifyReceipts + verifyCatalog + checkEventTriggers + ddl + verifyReceipts + verifyCatalog + checkEventTriggers]);
    for (const entry of native) emit(entry.file + '  exact apply receipt verified');
    return 0;
}
