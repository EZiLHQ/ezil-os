// Explicit self-hosted AWS staging profile only. No general migration registration.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const ROOT = new URL('../../', import.meta.url);
const literal = value => "E'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";

// Confirm existing placement and delegation prerequisites before the editor batch.
function stagingPreflight() {
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
            " AND c.relkind='r' AND c.relrowsecurity AND pg_has_role(current_user,c.relowner,'USAGE')) THEN RAISE EXCEPTION 'Staging placement prerequisite ownership/RLS mismatch'; END IF;",
        ...Object.entries(fields).map(([column, type]) => "IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(" + literal('public.' + table) +
            ") AND a.attname=" + literal(column) + (required[table].includes(column) ? " AND a.attnotnull" : "") + " AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)=" + literal(type) +
            ") THEN RAISE EXCEPTION 'Staging placement prerequisite column mismatch'; END IF;"),
    ]);
    return "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'; DO $editor_staging_preflight$ BEGIN " +
        "IF current_user IS DISTINCT FROM " + literal('postgres') + " OR session_user IS DISTINCT FROM " + literal('postgres') +
        " OR current_database() IS DISTINCT FROM " + literal('postgres') +
        " OR pg_is_in_recovery() OR current_setting('server_version_num')::integer / 10000 <> 17" +
        " OR NOT has_schema_privilege(current_user,'public','USAGE,CREATE')" +
        " OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated')" +
        " THEN RAISE EXCEPTION 'Editor staging role, database, recovery or version mismatch'; END IF; " + checks.join('\n') + " END $editor_staging_preflight$;";
}

export const EDITOR_SQL_PINS = Object.freeze({
    'app/drizzle/0034_editor_agent_sessions.sql': '1ae73e8865f488b2736608a88dd0767aebd04dfe49c43db69751db78dc8cc80d',
    'app/drizzle/0035_editor_control_operations.sql': '0ab5ff43439b281ea6ff8eaa56efb7b166e0cdcb6e283029c2a216baf7c8da59',
    'app/drizzle/0036_editor_protocol_2.sql': '134e14daa769de62f5ac25298569fd7b5e0a26697cf7e98963c650cd28f08c16',
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
const logShape = guard('editor_staging_log_shape', [
    refuseIf("NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass(" + literal(RELATION) +
        ") AND relkind='r' AND relpersistence='p' AND pg_has_role(current_user,relowner,'USAGE'))", 'Untrusted staging receipt relation'),
    refuseIf('(SELECT count(*) FROM pg_attribute WHERE attrelid=' + literal(RELATION) +
        '::regclass AND attnum>0 AND NOT attisdropped) <> 4', 'Staging receipt columns mismatch'),
    ...Object.entries(receiptColumns).map(([column, type]) => refuseIf(
        'NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=' + literal(RELATION) + '::regclass AND attname=' + literal(column) +
        ' AND format_type(atttypid,atttypmod)=' + literal(type) +
        " AND attnotnull AND NOT attisdropped AND attgenerated='' AND attidentity='')", 'Staging receipt column mismatch')),
    refuseIf('NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=' +
        literal(RELATION) + "::regclass AND a.attname='applied_at' AND pg_get_expr(d.adbin,d.adrelid)='now()')", 'Staging receipt timestamp default mismatch'),
    refuseIf('NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_index i ON i.indexrelid=k.conindid ' +
        "JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attname='file' WHERE k.conrelid=" + literal(RELATION) +
        "::regclass AND k.contype='p' AND NOT k.condeferrable AND k.convalidated AND k.conkey=ARRAY[a.attnum]::smallint[] " +
        'AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate AND i.indpred IS NULL AND i.indexprs IS NULL ' +
        'AND i.indnkeyatts=1 AND i.indnatts=1)', 'Staging receipts require an immediate primary key on file'),
    refuseIf("EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=" + literal(RELATION) + '::regclass AND NOT tgisinternal)',
        'Staging receipt relation has an unexpected trigger'),
].join('\n'));

// Bind enabled triggers and their functions, using stable names and definitions instead of OIDs.
const eventTriggerDigest = "SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_array(e.evtname,e.evtevent,e.evtenabled,e.evttags," +
    "r.rolname,n.nspname,p.proname,pg_get_userbyid(p.proowner),pg_get_functiondef(p.oid)) ORDER BY e.evtname)::text,'[]'),'UTF8')),'hex')" +
    " FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid JOIN pg_namespace n ON n.oid=p.pronamespace" +
    " JOIN pg_roles r ON r.oid=e.evtowner WHERE e.evtenabled <> 'D'";
const replayRelation = "'public.ezil_delegation_replay'::regclass";
const replayColumnCount = '(SELECT count(*) FROM pg_attribute WHERE attrelid=' + replayRelation + ' AND attnum>0 AND NOT attisdropped)';
const replayCatalog = guard('editor_staging_replay_catalog', [
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
const RECEIPT_WRITE = 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER';
const CLIENTS = ['anon', 'authenticated'];
const clientColumnPrivilege = (relation, privilege) => CLIENTS.map(role =>
    'has_any_column_privilege(' + literal(role) + ',' + relation + ',' + literal(privilege) + ')'
).join(' OR ');
const receiptWritable = '(' + clientPrivilege(literal(RELATION), RECEIPT_WRITE) + ' OR ' +
    clientColumnPrivilege(literal(RELATION), 'INSERT,UPDATE') + ')';
const verifyReceiptAcl = guard('editor_staging_receipt_acl', refuseIf(receiptWritable, 'Staging receipts must not be client-writable'));
const replayAcl = guard('editor_staging_replay_acl', refuseIf(
    'NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=' + replayRelation +
    " AND c.relkind='r' AND c.relpersistence='p' AND c.relrowsecurity AND pg_has_role(current_user,c.relowner,'USAGE')" +
    ' AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=c.oid)' +
    ' AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid)' +
    ' AND NOT (' + clientPrivilege('c.oid', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') +
    ' OR ' + clientColumnPrivilege('c.oid', 'SELECT,INSERT,UPDATE,REFERENCES') + '))',
    'Committed staging 0030 replay ownership, RLS or ACL mismatch'));
function editorReceiptCount(entries) {
    return 'SELECT count(*) FROM ' + RELATION + ' WHERE file IN (' + entries.map(({ file }) => literal(file)).join(',') + ')';
}

/** Project a closed catalog from the hash-verified three-file editor batch. */
function editorCatalogGuard(entries) {
    const sql = entries.map(entry => entry.sql).join('\n');
    const tables = new Map();
    for (const [, table, definition] of sql.matchAll(/CREATE TABLE public\.([a-z_]+) \(\n([\s\S]*?)\n\);/g)) {
        const fields = definition.split('\n').map(line => {
            const match = /^    ([a-z_]+) ([a-z0-9]+)( NOT NULL)?,?$/.exec(line);
            if (!match) throw new Error('Unexpected pinned editor column definition');
            return { name: match[1], type: match[2], notNull: Boolean(match[3]) };
        });
        tables.set(table, fields);
    }
    for (const [, table, name, type] of sql.matchAll(/ALTER TABLE public\.([a-z_]+) ADD COLUMN ([a-z_]+) ([a-z0-9]+);?/g)) {
        if (!tables.has(table)) throw new Error('Unexpected pinned editor ALTER target');
        tables.get(table).push({ name, type, notNull: false });
    }
    const indexes = [...sql.matchAll(/CREATE (UNIQUE )?INDEX ([a-z_]+) ON public\.([a-z_]+) \(([a-z_, ]+)\)(?: WHERE ([A-Za-z_ ]+))?;/g)];
    if (tables.size !== 5 || indexes.length !== 15) throw new Error('Unexpected pinned editor catalog scope');
    const verifyExisting = (condition, message) => refuseIf('receipt_count = ' + entries.length + ' AND (' + condition + ')', message);
    const verifyAbsent = name => refuseIf('receipt_count = 0 AND to_regclass(' + literal('public.' + name) +
        ') IS NOT NULL', 'Unreceipted editor catalog object exists');
    const checks = [
        refuseIf('receipt_count NOT IN (0,' + entries.length + ')', 'Partial editor receipt set requires owner reconciliation'),
        ...[...tables].flatMap(([table, columns]) => {
            const relation = 'to_regclass(' + literal('public.' + table) + ')';
            const blocked = clientPrivilege('c.oid', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') +
                ' OR ' + clientColumnPrivilege('c.oid', 'SELECT,INSERT,UPDATE,REFERENCES');
            return [
                verifyAbsent(table),
                verifyExisting('NOT EXISTS (SELECT 1 FROM pg_class c WHERE oid=' + relation +
                    " AND relkind='r' AND relpersistence='p' AND relrowsecurity AND pg_has_role(current_user,relowner,'USAGE')" +
                    ' AND NOT (' + blocked + ') AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=c.oid)' +
                    ' AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid)' +
                    ' AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=c.oid)' +
                    ' AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid))',
                    'Editor table ownership, ACL or catalog attributes mismatch'),
                verifyExisting('(SELECT count(*) FROM pg_attribute WHERE attrelid=' + relation +
                    ' AND attnum>0 AND NOT attisdropped) <> ' + columns.length, 'Editor column count mismatch'),
                verifyExisting('(SELECT count(*) FROM pg_index WHERE indrelid=' + relation + ') <> ' +
                    indexes.filter(([, , , indexTable]) => indexTable === table).length, 'Editor index count mismatch'),
                ...columns.map(({ name, type, notNull }) => verifyExisting(
                    'NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=' + relation + ' AND attname=' + literal(name) +
                    ' AND format_type(atttypid,atttypmod)=' + literal(type === 'timestamptz' ? 'timestamp with time zone' : type) +
                    ' AND attnotnull=' + notNull + " AND NOT attisdropped AND NOT atthasdef AND attidentity='' AND attgenerated='')",
                    'Editor column shape mismatch')),
            ];
        }),
        ...indexes.flatMap(([, unique, name, table, columns, predicate]) => [
            verifyAbsent(name),
            verifyExisting('NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_am am ON am.oid=x.relam' +
                ' WHERE i.indexrelid=to_regclass(' + literal('public.' + name) + ') AND i.indrelid=to_regclass(' + literal('public.' + table) +
                ") AND am.amname='btree' AND i.indisvalid AND i.indisready AND i.indimmediate AND i.indexprs IS NULL" +
                ' AND i.indisunique=' + Boolean(unique) + ' AND pg_get_expr(i.indpred,i.indrelid) IS NOT DISTINCT FROM ' +
                (predicate ? literal('(' + predicate + ')') : 'NULL') +
                ' AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)' +
                ' JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum) = ARRAY[' +
                columns.split(', ').map(literal).join(',') + ']::text[])', 'Editor index shape mismatch'),
        ]),
    ];
    return 'DO $editor_catalog$ DECLARE receipt_count bigint; BEGIN receipt_count := (' + editorReceiptCount(entries) +
        '); ' + checks.join('\n') + ' END $editor_catalog$;';
}


export const EDITOR_STAGING_SYSTEM_ID = '7698279149046886433';
const placementFiles = Object.freeze({
    'docs/aws-computers/sql/0001_compute_placement.sql.txt': '1cc5cf166326d58ed52714f0ba238e826f14b874661326596118318f58e6a09b',
    'docs/aws-computers/sql/0002_image_rebase.sql.txt': 'cf986a4f75f5d815b48261a1f7b263717912b80d689b552ce5e8a2e7ddcd0034',
});
const replayFile = 'app/drizzle/0030_delegation_replay.sql';
const replayPin = '50ff0b0a441ee539ca5d72302443315be1f1812e6b11e4afb2e1af3f575692a7';

function receiptGuard(legacy, editor) {
    if (Object.entries({ ...placementFiles, [replayFile]: replayPin }).some(([file, sha256]) =>
        !legacy.some(entry => entry.file === file && entry.sha256 === sha256))) {
        throw new Error('Editor staging prerequisite source hash mismatch');
    }
    return guard('editor_staging_receipts', [
        refuseIf('EXISTS (SELECT 1 FROM ' + RELATION + ' logged LEFT JOIN (VALUES ' + values([...legacy, ...editor]) +
            ') expected(file,sha256) ON expected.file=logged.file WHERE expected.file IS NULL OR logged.sha256<>expected.sha256' +
            " OR logged.mode NOT IN ('baseline','apply'))", 'Staging receipt outside reviewed source or checksum mismatch'),
        ...Object.keys(placementFiles).map(file =>
            refuseIf('NOT EXISTS (SELECT 1 FROM ' + RELATION + ' WHERE file=' + literal(file) + ')', 'Staging placement receipt required')),
        refuseIf('NOT EXISTS (SELECT 1 FROM ' + RELATION + ' WHERE ' + exactReceipt({ file: replayFile, sha256: replayPin }) + ')',
            'Exact applied staging 0030 receipt required'),
        refuseIf('EXISTS (SELECT 1 FROM ' + RELATION + ' WHERE file IN (' + editor.map(({ file }) => literal(file)).join(',') +
            ") AND mode<>'apply')", 'Editor staging receipts must be applied'),
    ].join('\n'));
}

export function runEditorStagingSchema({ mode, expectEventTriggerSha256, files, psql, emit }) {
    const editor = Object.entries(EDITOR_SQL_PINS).map(([file, sha256]) => {
        const bytes = readFileSync(new URL(file, ROOT));
        const sql = bytes.toString('utf8');
        if (createHash('sha256').update(bytes).digest('hex') !== sha256 || !Buffer.from(sql).equals(bytes)) {
            throw new Error('Editor staging SQL source hash mismatch');
        }
        return { file, sha256, sql };
    });
    const preflight = 'SET LOCAL search_path=pg_catalog,public; ' + stagingPreflight() + logShape;
    const verify = verifyReceiptAcl + receiptGuard(files, editor) + replayCatalog + replayAcl + editorCatalogGuard(editor);
    if (mode === 'plan') {
        const output = psql(['--single-transaction', '-c', preflight + 'LOCK TABLE ' + RELATION + ' IN ACCESS SHARE MODE;',
            '-c', verify + eventTriggerDigest + ';' + editorReceiptCount(editor) + ';'], { readOnly: true });
        const [fingerprint, count, ...extra] = output.trim().split('\n');
        if (!/^[a-f0-9]{64}$/.test(fingerprint) || !['0', String(editor.length)].includes(count) || extra.length) {
            throw new Error('Expected editor staging catalog and receipt evidence');
        }
        emit('Staging enabled event trigger SHA-256 ' + fingerprint);
        for (const entry of editor) {
            emit(entry.file + '  ' + entry.sha256 + '  ' + (count === '0' ? 'pending editor staging batch' : 'exact apply receipt verified'));
        }
        return 0;
    }
    const triggers = guard('editor_staging_event_triggers', refuseIf('(' + eventTriggerDigest + ') IS DISTINCT FROM ' +
        literal(expectEventTriggerSha256), 'Staging event trigger fingerprint mismatch'));
    const ddl = editor.map(entry => guard('editor_staging_apply', 'IF NOT EXISTS (SELECT 1 FROM ' + RELATION + ' WHERE file=' +
        literal(entry.file) + ') THEN EXECUTE ' + literal(entry.sql) + '; INSERT INTO ' + RELATION + ' (file,sha256,mode) VALUES (' +
        literal(entry.file) + ',' + literal(entry.sha256) + ",'apply'); END IF;")).join('\n');
    psql(['--single-transaction', '-c', preflight + 'SELECT pg_advisory_xact_lock(1702521196,1835624306);' +
        'LOCK TABLE ' + RELATION + ' IN SHARE ROW EXCLUSIVE MODE;',
    '-c', logShape + verify + triggers, '-c', ddl, '-c', verify + triggers]);
    for (const entry of editor) emit(entry.file + '  exact apply receipt verified');
    return 0;
}
