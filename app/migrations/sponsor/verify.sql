-- READ-ONLY structural fingerprint of the sponsor schema (request sponsor-checkout-20261111). Writes nothing. Run by the runner INSIDE a read-only transaction
-- after `set local search_path = pg_catalog` (so every definition is schema-qualified the same way whatever the session's search_path is). It reduces the
-- exact owned objects to one canonical text and returns its sha256 plus the line count; the runner compares it with a pinned value per server major version.
-- Covered: columns (type, nullability, default), every constraint definition, every index definition, every trigger definition and enabled state,
-- row-level-security flags, every policy (command, roles, expressions), ACL for anon / authenticated / public on both tables and both functions, and the
-- two guard functions (security mode, volatility, language, config, source hash, return type). Owner and grant order are deliberately not covered.
WITH rels AS (
	SELECT c.oid, c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
		AND c.relname IN ('ezil_sponsor_attributions', 'ezil_sponsor_trial_claims')
), fns AS (
	SELECT p.oid, p.proname, p.prosecdef, p.provolatile, p.proconfig, p.prosrc, p.prorettype, p.prolang FROM pg_proc p
	WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('ezil_sponsor_attribution_guard', 'ezil_sponsor_trial_claim_guard')
), roles AS (SELECT unnest(ARRAY['anon', 'authenticated', 'public']) AS g), lines AS (
	SELECT 'col|' || r.relname || '|' || a.attnum || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|'
		|| coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS l
		FROM rels r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
	UNION ALL SELECT 'con|' || r.relname || '|' || c.conname || '|' || c.contype::text || '|' || pg_get_constraintdef(c.oid) FROM rels r JOIN pg_constraint c ON c.conrelid = r.oid
	UNION ALL SELECT 'idx|' || r.relname || '|' || pg_get_indexdef(i.indexrelid) FROM rels r JOIN pg_index i ON i.indrelid = r.oid
	UNION ALL SELECT 'trg|' || r.relname || '|' || t.tgname || '|' || t.tgenabled::text || '|' || pg_get_triggerdef(t.oid) FROM rels r JOIN pg_trigger t ON t.tgrelid = r.oid AND NOT t.tgisinternal
	UNION ALL SELECT 'rls|' || r.relname || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text FROM rels r JOIN pg_class c ON c.oid = r.oid
	UNION ALL SELECT 'pol|' || r.relname || '|' || p.polname || '|' || p.polcmd::text || '|' || p.polpermissive::text || '|' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|'
		|| coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') || '|'
		|| coalesce((SELECT string_agg(coalesce(ro.rolname, 'public'), ',' ORDER BY coalesce(ro.rolname, 'public')) FROM unnest(p.polroles) u(roid) LEFT JOIN pg_roles ro ON ro.oid = u.roid), '')
		FROM rels r JOIN pg_policy p ON p.polrelid = r.oid
	UNION ALL SELECT 'acl|' || r.relname || '|' || x.g || '|' || has_table_privilege(x.g, r.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')::text FROM rels r CROSS JOIN roles x
	UNION ALL SELECT 'fn|' || f.proname || '|' || f.prosecdef::text || '|' || f.provolatile::text || '|' || l.lanname || '|' || coalesce(array_to_string(f.proconfig, ','), '') || '|'
		|| encode(sha256(convert_to(f.prosrc, 'UTF8')), 'hex') || '|' || f.prorettype::regtype::text FROM fns f JOIN pg_language l ON l.oid = f.prolang
	UNION ALL SELECT 'fnacl|' || f.proname || '|' || x.g || '|' || has_function_privilege(x.g, f.oid, 'EXECUTE')::text FROM fns f CROSS JOIN roles x
)
SELECT encode(sha256(convert_to(coalesce(string_agg(l, E'\n' ORDER BY l), ''), 'UTF8')), 'hex') AS fingerprint, count(*)::int AS lines FROM lines;
