import type { Usage } from './types';

/** Copilot 0.69's existing `usage` data-part contract. Request-local; never stored by session/model globally.
 * Messages input excludes cache buckets; Responses input includes them. Reasoning is a subset of output.
 * Optional counters remain absent. Unknown cache coverage makes the context count explicitly estimated. */
export function copilotUsage(usage: Usage, outputLimit?: number) {
    const inclusive = usage.inputIncludesCache ?? false;
    const measured = inclusive || (usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined);
    const prompt = usage.inputTokens + (inclusive ? 0 : (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0));
    return {
        prompt_tokens: prompt,
        completion_tokens: usage.outputTokens,
        total_tokens: prompt + usage.outputTokens,
        prompt_tokens_details: {
            ...(usage.cacheReadTokens === undefined ? {} : { cached_tokens: usage.cacheReadTokens }),
            ...(usage.cacheWriteTokens === undefined ? {} : { cache_creation_input_tokens: usage.cacheWriteTokens }),
        },
        ...(usage.reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
        ezil_usage: {
            source: measured ? 'measured' : 'estimated',
            ...(outputLimit === undefined ? {} : { output_limit: outputLimit }),
            // This is a lower bound if a Messages server omits cache counters; never claim exact coverage.
            ...(measured ? {} : { cache_coverage: 'unknown' }),
        },
    };
}
