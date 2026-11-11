/** Account/route-scoped effort. No shared preferences and no model-family guesses. */
import type { GatewayProtocol, ResolvedModel } from './config';
export interface GatewayEffortCapability { protocol: GatewayProtocol; values: readonly string[]; default: string | null }
const TOKEN = /^[A-Za-z0-9._-]{1,32}$/;
export function parseGatewayEffort(value: unknown, protocol: GatewayProtocol): GatewayEffortCapability | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(k => !['protocol', 'values', 'default'].includes(k)) || row.protocol !== protocol
        || !Array.isArray(row.values) || !row.values.length || row.values.length > 16
        || row.values.some(v => typeof v !== 'string' || !TOKEN.test(v)) || new Set(row.values).size !== row.values.length
        || (row.default !== null && (typeof row.default !== 'string' || !row.values.includes(row.default)))) return undefined;
    return { protocol, values: [...row.values] as string[], default: row.default as string | null };
}
function capability(model: ResolvedModel): GatewayEffortCapability | undefined {
    return model.provider.type === 'ezil-gateway' ? parseGatewayEffort(model.gatewayEffort, model.gatewayProtocol ?? 'anthropic-messages') : undefined;
}
export function effortConfigurationSchema(model: ResolvedModel) {
    const cap = capability(model);
    return cap ? { properties: { reasoningEffort: { type: 'string' as const, enum: [...cap.values],
        ...(cap.default !== null ? { default: cap.default } : {}) } } } : undefined;
}
export class SessionEffortError extends Error {
    constructor() { super('Requested session effort is unavailable for this model route. Nothing was sent.'); this.name = 'SessionEffortError'; }
}
export function withSessionEffort(model: ResolvedModel, configuration: unknown): ResolvedModel {
    const { sessionEffort: _previous, ...base } = model;
    if (configuration === undefined || configuration === null) return base;
    if (typeof configuration !== 'object' || Array.isArray(configuration)) throw new SessionEffortError();
    const value = (configuration as Record<string, unknown>).reasoningEffort;
    if (value === undefined) return base;
    const cap = capability(model);
    if (typeof value !== 'string' || !cap?.values.includes(value)) throw new SessionEffortError();
    return { ...base, sessionEffort: value };
}
/** Revalidate at serialization; an absent override adds no wire field. */
export function sessionEffort(model: ResolvedModel, protocol: GatewayProtocol): string | undefined {
    if (model.sessionEffort === undefined) return undefined;
    const cap = capability(model);
    if (cap?.protocol !== protocol || !cap.values.includes(model.sessionEffort)) throw new SessionEffortError();
    return model.sessionEffort;
}
