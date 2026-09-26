# Durable computer mount authority

Migration `0011_computer_data_mount_authority.sql` adds service-only mount
authorizations and a transactional delivery queue. It does not enable an issuer,
send SSM commands, format disks or mark applications ready.

An authorization freezes the completed lifecycle job, current computer writer,
instance/volume IDs, filesystem UUID, mode, provider observation time and plan
digest. PostgreSQL computes canonical plan bytes and the SHA-256 digest, and
sets an integer-second issuance time with a 900-second lifetime. The only
mutable authorization field is an irreversible revocation timestamp.

Provisioning may receive one initialization grant per computer. Start,
replacement and retained recovery can receive only mount grants. A grant cannot
be renewed, deleted, truncated or moved to another job to clear its history.
An expired, uncertain initialization requires explicit recovery/inspection;
it never becomes an automatic second formatting attempt. The host still checks
blank media and keeps its durable attempt journal.

The SQL checks require a successful immutable lifecycle source, the current
unfenced running writer, the recorded filesystem UUID, the owner's request and
running desired state. A later lifecycle job prevents use of the old grant.
Creating a grant atomically creates its delivery row. A mounted receipt needs
an unexpired lease, unrevoked authority, current writer and exact host receipt
identity; accepted receipts cannot be overwritten or removed.

These records do not establish provider truth or user entitlement. A trusted
issuer must check OS access and the approved deployment, independently observe
the actual provider resources, then recheck database authority before issuance.
The delivery workflow must reauthorize before dispatch and handle revocation
during host work. A stored receipt is historical mount evidence, not current
application readiness. Status reads do not start compute.

Apply this additive migration before shipping consumers, after reviewing the
live hosted schema and obtaining migration authorization. Do not replay old
migrations or run an unreviewed schema push. Disabling consumers is the rollback;
retain authorization, attempt and receipt history. No hosted migration was
performed while authoring this change.

Local validation uses `bash tools/test.sh app`, the production app build, and
`bun run test:db:data-mounts` with `EZIL_TEST_DATABASE_URL` set to an isolated
loopback PostgreSQL database. The database suite creates/drops its own database
and exercises constraints, concurrent issuance, rollback, leases, revocation,
RLS and unchanged historical lifecycle documents. Provider lifecycle regression
suites also run with this migration. These tests simulate provider observations;
actual AWS and host-delivery acceptance remain separate.
