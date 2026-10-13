import { Aspects, CliCredentialsStackSynthesizer, type IAspect, type Stack, aws_iam as iam } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import { z } from 'zod';

/** How a workload stack is deployed under the I5 identity: its roles live under
 * the workload path and carry the boundary, and its assets go to the identity
 * stack's bucket (no CDK bootstrap). */
export const WorkloadDeploySchema = z.object({
    assetBucketName: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
}).strict();
export type WorkloadDeploy = z.infer<typeof WorkloadDeploySchema>;

export const workloadPath = (namespace: string) => `/ezil/${namespace}/`;
export const boundaryArn = (accountId: string, namespace: string) => `arn:aws:iam::${accountId}:policy/ezil/identity/ezil-${namespace}-boundary`;
export const workloadStackName = (namespace: string, kind: string) => `ezil-${namespace}-${kind}`;

/** Assets publish with the caller's own credentials to the identity bucket. */
export const workloadSynthesizer = (deploy: WorkloadDeploy) =>
    new CliCredentialsStackSynthesizer({ fileAssetsBucketName: deploy.assetBucketName, bucketPrefix: 'assets/' });

class RolePath implements IAspect {
    constructor(private readonly path: string) {}
    visit(node: IConstruct) { if (node instanceof iam.CfnRole) node.path = this.path; }
}
/** Every role in the stack: workload path + permission boundary. */
export function applyWorkloadIdentity(stack: Stack, accountId: string, namespace: string) {
    Aspects.of(stack).add(new RolePath(workloadPath(namespace)));
    iam.PermissionsBoundary.of(stack).apply(iam.ManagedPolicy.fromManagedPolicyArn(stack, 'WorkloadBoundary', boundaryArn(accountId, namespace)));
}
