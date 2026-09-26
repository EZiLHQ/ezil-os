import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { lifecycleDeployment as deployment } from './lifecycle';

const handle = (prefix: string) => `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 17)}`;
/** Simulated lifecycle settlement in a disposable database, not AWS proof. */
export async function dataMountComputer(sql: Sql, operation: 'provision' | 'start' | 'replace' = 'provision', status: 'succeeded' | 'failed' = 'succeeded') {
    const computerId = randomUUID(), userId = randomUUID(), jobId = randomUUID(), fence = randomUUID(),
        volume = handle('vol'), instance = handle('i'), oldInstance = handle('i'), oldFence = randomUUID();
    const generation = operation === 'replace' ? 2 : 1;
    await sql`INSERT INTO auth.users(id) VALUES (${userId})`;
    await sql`INSERT INTO ezil_computers(id,user_id,slot,provider) VALUES (${computerId},${userId},1,'aws-ec2')`;
    await sql`INSERT INTO ezil_computer_runtimes(computer_id,region,desired_state,data_volume_id,availability_zone,next_generation,data_filesystem_uuid)
        VALUES (${computerId},'us-east-1','running',${operation === 'provision' ? null : volume},
            ${operation === 'provision' ? null : 'us-east-1a'},${operation === 'provision' ? 1 : 2},${randomUUID()})`;
    if (operation !== 'provision') await sql`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,fence_token,observed_state)
        VALUES (${computerId},1,${operation === 'replace' ? oldInstance : instance},${operation === 'replace' ? oldFence : fence},'stopped')`;
    await sql.begin(async tx => {
        await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key)
            VALUES (${jobId},${computerId},${userId},${operation},${randomUUID()})`;
        await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${jobId},${computerId})`;
        await tx`INSERT INTO ezil_computer_lifecycle_intents(job_id,computer_id,revision,operation,target_generation,fence_token,provider_instance_id,
            data_volume_id,previous_generation,previous_instance_id,previous_fence_token,deployment)
            VALUES (${jobId},${computerId},1,${operation},${generation},${fence},${operation === 'start' ? instance : null},
                ${operation === 'provision' ? null : volume},${operation === 'replace' ? 1 : null},
                ${operation === 'replace' ? oldInstance : null},${operation === 'replace' ? oldFence : null},${JSON.stringify(deployment)})`;
    });
    await sql.begin(async tx => {
        if (operation === 'replace') await tx`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${computerId}`;
        await tx`UPDATE ezil_computer_runtimes SET data_volume_id=${volume},availability_zone='us-east-1a' WHERE computer_id=${computerId}`;
        if (operation !== 'start') await tx`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,fence_token,observed_state,observed_at)
            VALUES (${computerId},${generation},${instance},${fence},'running',now())`;
        else await tx`UPDATE ezil_computer_instances SET observed_state='running',observed_at=now() WHERE computer_id=${computerId}`;
        await tx`UPDATE ezil_computer_lifecycle_jobs SET status=${status},started_at=now(),completed_at=now() WHERE id=${jobId}`;
        await tx`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=now() WHERE job_id=${jobId}`;
    });
    const [r] = await sql`SELECT data_filesystem_uuid FROM ezil_computer_runtimes WHERE computer_id=${computerId}`;
    return { computerId, userId, jobId, generation, fence, volume, instance, filesystemUuid: r!.data_filesystem_uuid as string, operation };
}
export type MountComputer = Omit<Awaited<ReturnType<typeof dataMountComputer>>, 'operation'> & {
    operation: 'provision' | 'start' | 'replace' | 'recover';
};
