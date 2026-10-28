# Feedback tables — founder rehearsal and registration

The SQL lives in `app/src/server/feedback/migration-sql.ts` (`FEEDBACK_REPORTS_SQL`,
`FEEDBACK_ATTACHMENTS_SQL`) and is grammar-checked by `migration-sql.test.ts`. It is
deliberately not a `.sql` file yet: `production-migrations.mjs validate` refuses any
unregistered `.sql`, and registration needs the `after` catalog digest.

To register (founder, after reviewing):
1. Write each constant to `app/drizzle/hardening/0003_feedback_reports.sql` and
   `0004_feedback_attachments.sql` (byte-identical, trailing newline as you prefer — the sha256 is of the file).
2. On a disposable database restored from the current production catalog, apply 0003,
   record the `public` catalog digest (`production-migrations.mjs plan`), then 0004 and record again.
3. Add both files to `sources` (`kind: "migration"`) and to `migrations`
   (`{id, path, sha256, before, after}`; the first `before` is the current `initialCatalog.digest`).
4. `node .github/scripts/production-migrations.mjs validate`, then release normally.

Until then `EZIL_OS_FEEDBACK` must stay unset in production: the route needs the tables.
