export type Plan = 'free' | 'subscriber';
export type ShapeId = 'standard' | 'performance';

export const COMPUTE_SHAPES = [
    { id: 'standard', runtime: 'Cloudflare Containers custom', containerClass: 'Sandbox', vcpu: 2, memoryGiB: 6, diskGB: 16 },
    { id: 'performance', runtime: 'Cloudflare Containers standard-4', containerClass: 'SandboxPerformance', vcpu: 4, memoryGiB: 12, diskGB: 20 },
] as const;

export const VCPU_DESCRIPTION = 'vCPU is a Cloudflare virtual CPU allocation, not a physical core.';

export function eligibleShapes(plan: Plan) {
    return COMPUTE_SHAPES.filter((shape) => shape.id === 'standard' || plan === 'subscriber');
}

export function shapesForPlan(plan: Plan) {
    return COMPUTE_SHAPES.map((shape) => ({
        ...shape,
        eligible: eligibleShapes(plan).some((eligible) => eligible.id === shape.id),
        reason: shape.id === 'performance' && plan !== 'subscriber' ? 'subscription_required' as const : null,
        vcpuDescription: VCPU_DESCRIPTION,
    }));
}

export class ShapeEligibilityError extends Error {
    constructor() {
        super('subscription_required');
        this.name = 'ShapeEligibilityError';
    }
}

export function assertShapeEligible(shape: ShapeId, plan: Plan) {
    const eligible = eligibleShapes(plan).find((candidate) => candidate.id === shape);
    if (!eligible) throw new ShapeEligibilityError();
    return eligible;
}
