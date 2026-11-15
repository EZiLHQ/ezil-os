/** Closed Carbon v1 wire contract. Self-contained so the pinned workbench embeds this exact function. */
export function validateInferenceTrace(value, maxBytes = 4096) {
    try {
        // Copy own data only: getters, symbols, private keys and inherited toJSON cannot execute.
        let nodes = 0;
        const copy = (v, depth = 0) => {
            if (++nodes > 2048 || depth > 6 || (typeof v === "string" && v.length > 128)) throw 0;
            if (v === null || ["string", "boolean", "number", "undefined"].includes(typeof v)) return v;
            if (typeof v !== "object") throw 0;
            const array = Array.isArray(v), out = array ? [] : Object.create(null);
            if (array && (v.length > 128 || Reflect.ownKeys(v).length !== v.length + 1)) throw 0;
            for (const key of Reflect.ownKeys(v)) {
                if (array && key === "length") continue;
                const d = Object.getOwnPropertyDescriptor(v, key);
                if (typeof key !== "string" || !d || !("value" in d) || !d.enumerable) throw 0;
                if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw 0;
                Object.defineProperty(out, key, { value: copy(d.value, depth + 1), enumerable: true, configurable: true, writable: true });
            }
            return out;
        };
        const r = copy(value);
        const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
        const exact = (v, keys) => object(v) && Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
        const matches = (v, re) => typeof v === "string" && re.exec(v)?.[0] === v;
        const integer = v => Number.isSafeInteger(v) && v >= 0 && v <= 2147483647;
        const uuid = v => matches(v, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        const hash = v => matches(v, /^[0-9a-f]{64}$/);
        const bool = v => typeof v === "boolean";
        const categories = ["read", "search", "write", "other"];
        const keys = ["contract","adapterVersion","requestId","turnId","modelAlias","clientRequestId","gatewayRequestId","conversationId","toolCalls","toolResults","observationsTruncated","offered","requested","results","writeRequested","toolReportedSuccess","verifiedFileChange","usage","usageSource","estimatedInputTokens","wireBytes","totalWireBytes","attempts","compaction","finishReason","durationMs","cancelled","outcome","thought_signature_replayed","readHeavyWithoutVerifiedEdit"];
        if (!exact(r, keys) || r.contract !== "ezil.inference.v1" || !uuid(r.requestId) || !uuid(r.turnId)) return null;
        if (!matches(r.adapterVersion, /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:\+carbon-progress\.\d{1,3})?$/)) return null;
        if (!matches(r.modelAlias, /^(?:unknown|[a-z][a-z0-9_.:-]{0,127})$/i)
            || /secret|token|passw|bearer|credential|cookie|session|api.?key|^(sk|pk|ghp|github_pat|xoxb)[_-]/i.test(r.modelAlias)
            || /[a-z0-9]{32,}/i.test(r.modelAlias)) return null;
        for (const k of ["clientRequestId", "gatewayRequestId"]) if (r[k] !== null && !matches(r[k], /^[a-zA-Z0-9_-]{1,128}$/)) return null;
        if (r.conversationId !== null && !hash(r.conversationId)) return null;
        for (const k of ["toolCalls", "toolResults"]) {
            if (!Array.isArray(r[k]) || r[k].length > 128) return null;
            for (const item of r[k]) if (!exact(item, k === "toolCalls" ? ["call", "category"] : ["call", "category", "state"])
                || !hash(item.call) || !categories.includes(item.category)
                || (k === "toolResults" && !["error", "reported_success", "unknown"].includes(item.state))) return null;
        }
        for (const k of ["offered", "requested"]) if (!exact(r[k], categories) || !Object.values(r[k]).every(integer)) return null;
        if (!exact(r.results, ["matched", "error", "reportedSuccess", "unknown", "unmatched"]) || !Object.values(r.results).every(integer)) return null;
        for (const k of ["writeRequested", "toolReportedSuccess", "cancelled", "thought_signature_replayed", "readHeavyWithoutVerifiedEdit", "observationsTruncated"]) if (!bool(r[k])) return null;
        if (r.verifiedFileChange !== null || r.writeRequested !== (r.requested.write > 0)
            || r.readHeavyWithoutVerifiedEdit !== (r.requested.read + r.requested.search > 0 && !r.writeRequested)) return null;
        if (!["completed", "failed", "cancelled"].includes(r.outcome) || r.cancelled !== (r.outcome === "cancelled")) return null;
        if (!["provider_reported", "unknown"].includes(r.usageSource) || (r.usage === null) !== (r.usageSource === "unknown")) return null;
        if (r.usage !== null) {
            const allowed = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "inputIncludesCache", "reasoningTokens"];
            if (!object(r.usage) || !Reflect.ownKeys(r.usage).every(k => allowed.includes(k))
                || !integer(r.usage.inputTokens) || !integer(r.usage.outputTokens)) return null;
            for (const k of Reflect.ownKeys(r.usage)) if (r.usage[k] !== undefined && !(k === "inputIncludesCache" ? bool(r.usage[k]) : integer(r.usage[k]))) return null;
        }
        for (const k of ["estimatedInputTokens", "totalWireBytes", "attempts", "durationMs"]) if (!integer(r[k])) return null;
        if (r.wireBytes !== null && !integer(r.wireBytes)) return null;
        if (r.compaction !== null && (!exact(r.compaction, ["trigger", "count", "folded", "shortened"])
            || !["remote", "local_input_too_large", "local_too_many_messages", "local_too_many_blocks"].includes(r.compaction.trigger)
            || !["count", "folded", "shortened"].every(k => integer(r.compaction[k])))) return null;
        if (r.finishReason !== null && !["end_turn", "tool_use", "max_tokens", "stop_sequence", "refusal", "stop", "length", "completed", "failed", "incomplete"].includes(r.finishReason)) return null;
        if (new TextEncoder().encode(JSON.stringify(r)).byteLength > maxBytes) return null;
        if (!/^(?:(?:us|eu|apac|global|au|jp)[.])?(?:(?:anthropic|openai|google|gemini|vertex|bedrock|azure|moonshotai|zai)[.:])?(?:ezil|claude|gemini|gpt|qwen|kimi|glm|deepseek|mistral|codestral|llama|grok|nova|minimax|command|sonar)[-_.:][a-z0-9_.:-]{1,96}$/i.test(r.modelAlias)) r.modelAlias = "unknown";
        for (const k of ["clientRequestId", "gatewayRequestId"]) r[k] = uuid(r[k]) ? r[k].toLowerCase() : null;
        return JSON.parse(JSON.stringify(r));
    } catch { return null; }
}
