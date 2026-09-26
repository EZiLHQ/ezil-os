import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { lifecycleDeployment } from './lifecycle';
import type { MountComputer } from './data-mount';

/** Simulated host receipt; all lifecycle/grant/receipt constraints remain on.
 * These fixtures establish DB behavior, not a mounted disk or AWS readiness. */
export async function recordConfigurationMount(sql: Sql, c: MountComputer) {
    const [a] = await sql`INSERT INTO ezil_computer_data_mount_authorizations(computer_id,computer_generation,lifecycle_job_id,
        fence_token,provider_instance_id,data_volume_id,filesystem_uuid,mode,provider_observed_at)
        VALUES (${c.computerId},${c.generation},${c.jobId},${c.fence},${c.instance},${c.volume},${c.filesystemUuid},
            ${c.operation === 'provision' ? 'initialize' : 'mount'},clock_timestamp()) RETURNING id,digest`;
    const receipt = { schemaVersion: 1, authorizationId: a!.id, digest: a!.digest, state: 'mounted',
        scope: { computerId: c.computerId, computerGeneration: c.generation, fenceToken: c.fence,
            providerInstanceId: c.instance, dataVolumeId: c.volume },
        computerId: c.computerId, volumeId: c.volume, filesystemUuid: c.filesystemUuid };
    await sql`UPDATE ezil_computer_data_mount_deliveries SET attempts=1,lease_until=now()+interval '30 seconds' WHERE authorization_id=${a!.id}`;
    await sql`UPDATE ezil_computer_data_mount_deliveries SET mounted_at=now(),receipt=${JSON.stringify(receipt)} WHERE authorization_id=${a!.id}`;
    return a!.id as string;
}

export async function restartConfigurationComputer(sql: Sql, c: MountComputer) {
    for (const operation of ['stop', 'start'] as const) {
        const jobId = randomUUID();
        await sql.begin(async tx => {
            await tx`SET LOCAL lock_timeout='1s'`;
            await tx`SELECT id FROM ezil_computers WHERE id=${c.computerId} FOR UPDATE`;
            const [next] = await tx`SELECT coalesce(max(revision),0)+1 revision FROM ezil_computer_lifecycle_intents WHERE computer_id=${c.computerId}`;
            await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key)
                VALUES (${jobId},${c.computerId},${c.userId},${operation},${randomUUID()})`;
            await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${jobId},${c.computerId})`;
            await tx`INSERT INTO ezil_computer_lifecycle_intents(job_id,computer_id,revision,operation,target_generation,fence_token,
                provider_instance_id,data_volume_id,deployment)
                VALUES (${jobId},${c.computerId},${next!.revision},${operation},${c.generation},${c.fence},${c.instance},${c.volume},${JSON.stringify(lifecycleDeployment)})`;
            await tx`UPDATE ezil_computer_instances SET observed_state=${operation === 'stop' ? 'stopped' : 'running'},observed_at=now()
                WHERE computer_id=${c.computerId} AND generation=${c.generation}`;
            await tx`UPDATE ezil_computer_lifecycle_jobs SET status='succeeded',started_at=now(),completed_at=now() WHERE id=${jobId}`;
            await tx`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=now() WHERE job_id=${jobId}`;
        });
        if (operation === 'start') return { ...c, jobId, operation };
    }
    throw new Error('restart fixture incomplete');
}

/** Simulate elapsed time only in a disposable DB. Shift the completed receipt
 * WITH its grant so it still represents an in-time mount; production history
 * cannot be rewritten. No wall-clock sleep or weakened production trigger. */
export async function ageConfigurationMount(sql: Sql, authorizationId: string) {
    await sql.begin(async tx => {
        await tx`ALTER TABLE ezil_computer_data_mount_authorizations DISABLE TRIGGER ezil_mount_authority_write_trg`;
        await tx`ALTER TABLE ezil_computer_data_mount_deliveries DISABLE TRIGGER ezil_mount_delivery_write_trg`;
        await tx`UPDATE ezil_computer_data_mount_authorizations SET issued_at=issued_at-interval '1 hour',expires_at=expires_at-interval '1 hour',
            provider_observed_at=provider_observed_at-interval '1 hour' WHERE id=${authorizationId}`;
        await tx`UPDATE ezil_computer_data_mount_deliveries SET mounted_at=mounted_at-interval '1 hour' WHERE authorization_id=${authorizationId}`;
        await tx`ALTER TABLE ezil_computer_data_mount_authorizations ENABLE TRIGGER ezil_mount_authority_write_trg`;
        await tx`ALTER TABLE ezil_computer_data_mount_deliveries ENABLE TRIGGER ezil_mount_delivery_write_trg`;
    });
}
