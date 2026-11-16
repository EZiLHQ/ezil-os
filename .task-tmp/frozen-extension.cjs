var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// extensions/ezil-models/src/extension.ts
var exports_extension = {};
__export(exports_extension, {
  settingsSnippet: () => settingsSnippet,
  resolveConfigPath: () => resolveConfigPath,
  deactivate: () => deactivate,
  activate: () => activate,
  UsageTracker: () => UsageTracker,
  DEFAULT_CONFIG_PATH: () => DEFAULT_CONFIG_PATH,
  ConfigStore: () => ConfigStore,
  CONFIG_TEMPLATE: () => CONFIG_TEMPLATE,
  CONFIG_ENV: () => CONFIG_ENV
});
module.exports = __toCommonJS(exports_extension);
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var vscode3 = __toESM(require("vscode"));

// extensions/ezil-models/src/types.ts
var CACHE_CONTROL_MIME = "cache_control";
var STATEFUL_MARKER_MIME = "stateful_marker";
function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
function base64(data) {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}
function isCacheMarker(part) {
  return part.type === "data" && part.mimeType === CACHE_CONTROL_MIME;
}
function isStatefulMarker(part) {
  return part.type === "data" && part.mimeType === STATEFUL_MARKER_MIME;
}
var IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// extensions/ezil-models/src/gateway-messages.ts
var QWEN = "qwen.qwen3-coder-next";
var KIMI = "us.moonshotai.kimi-k3";
var GATEWAY_INPUT_TOKENS = 131072;
var INPUT_FRAMING = 1056;
var ENVELOPE_RESERVE = 1536;
var DEFAULT_TOOL_RESERVE = 8000;
var TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function jsonValue(value, seen = new Set, depth = 0) {
  if (depth > 240)
    return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number")
    return Number.isFinite(value);
  if (!isObject(value) && !Array.isArray(value))
    return false;
  if (seen.has(value) || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return false;
  seen.add(value);
  const valid = Object.values(value).every((item) => jsonValue(item, seen, depth + 1));
  seen.delete(value);
  return valid;
}
var text = (value) => ({ type: "text", text: value });
function gatewayTools(tools, log = () => {}) {
  const names = new Set;
  const dropped = new Set;
  const result = [];
  for (const tool of tools) {
    const schema = tool.inputSchema ?? { type: "object", properties: {} };
    if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name) || names.has(tool.name) || result.length >= 64 || !isObject(schema) || schema.type !== "object" || !jsonValue(schema)) {
      dropped.add(String(tool.name));
      continue;
    }
    names.add(tool.name);
    result.push({ name: tool.name, input_schema: schema, ...typeof tool.description === "string" && tool.description.trim() ? { description: tool.description } : {} });
  }
  if (dropped.size)
    log(`[gateway] dropped tools: ${JSON.stringify([...dropped])}`);
  return result;
}
function partText(part) {
  if (part.type === "text")
    return part.value;
  if (part.type === "thinking" || isCacheMarker(part) || isStatefulMarker(part))
    return "";
  if (part.type === "data") {
    if (part.mimeType.startsWith("text/"))
      return Buffer.from(part.data).toString("utf8");
    return `[${part.mimeType.startsWith("image/") ? "image" : "document"} omitted: not supported by this model]`;
  }
  if (part.type === "tool_result")
    return part.content.map(partText).filter(Boolean).join(`
`);
  return "[tool call omitted]";
}
function gatewayMessage(message) {
  const content = [];
  for (const part of message.parts) {
    if (message.role === "assistant" && part.type === "tool_call") {
      if (typeof part.callId === "string" && typeof part.name === "string" && TOOL_NAME.test(part.callId) && TOOL_NAME.test(part.name) && isObject(part.input) && jsonValue(part.input)) {
        content.push({ type: "tool_use", id: part.callId, name: part.name, input: part.input });
      } else
        content.push(text("[tool call omitted: invalid arguments or identifier]"));
    } else if (message.role === "user" && part.type === "tool_result") {
      content.push({
        type: "tool_result",
        tool_use_id: part.callId,
        content: [text(partText(part) || "(no output)")],
        ...typeof part.isError === "boolean" ? { is_error: part.isError } : {}
      });
    } else {
      const value = partText(part);
      if (value)
        content.push(text(value));
    }
  }
  return { role: message.role, content: content.length ? content : [text("(empty)")] };
}
function gatewayConversation(messages, tools) {
  const system = [];
  const turns = [];
  const names = new Set(tools.map((tool) => tool.name));
  const seen = new Set;
  for (const message of messages) {
    if (message.role === "system") {
      for (const part of message.parts) {
        const value = partText(part);
        if (value)
          system.push(text(value));
      }
      continue;
    }
    const converted = gatewayMessage(message);
    const content = converted.content.map((block) => {
      if (block.type !== "tool_use")
        return block;
      if (!names.has(block.name) || seen.has(block.id))
        return text("[tool call omitted: unavailable tool or duplicate identifier]");
      seen.add(block.id);
      return block;
    });
    const previous = turns.at(-1);
    if (previous?.role === message.role)
      previous.content.push(...content);
    else
      turns.push({ role: message.role, content });
  }
  if (!turns.length || turns[0].role !== "user")
    turns.unshift({ role: "user", content: [text("(conversation history)")] });
  if (turns.at(-1).role === "assistant")
    turns.push({ role: "user", content: [text("Continue.")] });
  let pending = new Set;
  for (const turn of turns) {
    if (turn.role === "assistant") {
      pending = new Set(turn.content.filter((block) => block.type === "tool_use").map((block) => block.id));
      continue;
    }
    turn.content = turn.content.map((block) => {
      if (block.type !== "tool_result")
        return block;
      if (pending.delete(block.tool_use_id))
        return block;
      return text(`[Earlier tool output]
${block.content.map((part) => part.text).join(`
`)}`);
    });
    turn.content.unshift(...[...pending].map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      is_error: true,
      content: [text("No result was recorded for this tool call.")]
    })));
    pending.clear();
  }
  return { system, messages: turns };
}
function gatewayOutputTokens(model) {
  const fallback = model.model === KIMI ? 4096 : 8192;
  return Math.max(16, Math.min(16384, Math.floor(Number.isFinite(model.maxOutputTokens) ? model.maxOutputTokens : fallback)));
}
function gatewayInputTokens(model) {
  return Math.max(1, Math.min(GATEWAY_INPUT_TOKENS, model.maxInputTokens) - INPUT_FRAMING - ENVELOPE_RESERVE - (model.toolReserve ?? DEFAULT_TOOL_RESERVE));
}
function buildGatewayBody(model, request, log) {
  const tools = gatewayTools(request.tools, log);
  const conversation = gatewayConversation(request.messages, tools);
  const body = {
    model: model.model,
    messages: conversation.messages,
    max_tokens: gatewayOutputTokens(model),
    stream: model.model !== KIMI && model.stream !== false
  };
  if (conversation.system.length)
    body.system = conversation.system;
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = { type: "auto" };
  }
  if (request.toolMode === "required")
    log?.("[gateway] required tool choice mapped to auto");
  for (const [key, configured] of [["temperature", model.temperature], ["top_p", model.topP]]) {
    const value = request.modelOptions[key] ?? configured;
    if (typeof value === "number" && Number.isFinite(value))
      body[key] = Math.max(0, Math.min(1, value));
  }
  if (body.messages.length > 1024 || body.messages.some((message) => message.content.length > 1024))
    throw new Error("Conversation too large — start a new chat");
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.byteLength + INPUT_FRAMING > Math.min(GATEWAY_INPUT_TOKENS, model.maxInputTokens))
    throw new Error("Conversation too large — start a new chat");
  return { body, bytes };
}
function gatewayTokenCount(value) {
  if (typeof value === "string")
    return Buffer.byteLength(JSON.stringify(text(value)), "utf8");
  if (value.role === "system") {
    const blocks = value.parts.map(partText).filter(Boolean).map(text);
    return blocks.length ? Buffer.byteLength(JSON.stringify(blocks), "utf8") : 0;
  }
  return Buffer.byteLength(JSON.stringify(gatewayMessage(value)), "utf8");
}

// extensions/ezil-models/src/config.ts
var PROVIDER_TYPES = ["ezil-gateway", "anthropic", "anthropic-foundry", "openai", "azure-openai", "openai-compatible"];
var MODEL_ROLES = ["default", "plan", "utility", "utilitySmall"];
var EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

class ConfigError extends Error {
  errors;
  source;
  constructor(errors, source) {
    super(`${source ? `${source}: ` : ""}invalid EZiL models config:
  - ${errors.join(`
  - `)}`);
    this.errors = errors;
    this.source = source;
    this.name = "ConfigError";
  }
}
var ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
var REFERENCE = /^\{(env|file):([^}]+)\}$/;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isAnthropic(type) {
  return type === "anthropic" || type === "anthropic-foundry";
}
function supportsForcedToolChoice(model) {
  return !/opus-5-5|fable-5|mythos/i.test(model);
}
function parseModelsConfig(text2, options = {}) {
  const source = options.source;
  let raw;
  try {
    raw = JSON.parse(text2);
  } catch (error) {
    throw new ConfigError([`not valid JSON (${error.message}). YAML is not supported; use JSON.`], source);
  }
  return resolveModelsConfig(raw, options);
}
function resolveModelsConfig(raw, options = {}) {
  const fatal = [];
  const errors = [];
  const warnings = [];
  const secrets = [];
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path) => require("node:fs").readFileSync(path, "utf8"));
  const resolveString = (value, where, field, secret, sink) => {
    if (value === undefined)
      return;
    if (typeof value !== "string") {
      sink.problems.push(`${where}.${field} must be a string`);
      return;
    }
    const match = REFERENCE.exec(value.trim());
    let resolved = value;
    if (match) {
      const [, kind, target] = match;
      const name = target.trim();
      if (kind === "env") {
        const fromEnv = env[name];
        if (fromEnv === undefined || fromEnv === "") {
          sink.unresolved.push(`${field}: environment variable ${name} is not set`);
          return;
        }
        resolved = fromEnv;
      } else {
        try {
          resolved = readFile(name).trim();
        } catch (error) {
          sink.unresolved.push(`${field}: cannot read ${name} (${error.message})`);
          return;
        }
        if (!resolved) {
          sink.unresolved.push(`${field}: ${name} is empty`);
          return;
        }
      }
    }
    if (secret && resolved)
      secrets.push(resolved);
    return resolved;
  };
  if (!isRecord(raw))
    throw new ConfigError(['top level must be an object with "providers" and "models"'], options.source);
  const outcomes = {};
  const providers = {};
  const providerEntries = isRecord(raw.providers) ? Object.entries(raw.providers).filter(([name]) => name !== "$comment") : [];
  if (!isRecord(raw.providers) || providerEntries.length === 0) {
    fatal.push('"providers" must be a non-empty object');
  } else {
    for (const [name, value] of providerEntries) {
      const where = `providers.${name}`;
      const sink = { problems: [], unresolved: [] };
      if (!ID_PATTERN.test(name))
        sink.problems.push(`${where}: provider names must match ${ID_PATTERN}`);
      if (!isRecord(value)) {
        errors.push(`${where} must be an object`);
        continue;
      }
      const type = value.type;
      if (!PROVIDER_TYPES.includes(type)) {
        errors.push(`${where}.type must be one of ${PROVIDER_TYPES.join(", ")}`);
        continue;
      }
      const apiKey = resolveString(value.apiKey, where, "apiKey", true, sink);
      const baseUrl = resolveString(value.baseUrl, where, "baseUrl", false, sink)?.replace(/\/+$/, "");
      const resource = resolveString(value.resource, where, "resource", false, sink);
      const apiVersion = resolveString(value.apiVersion, where, "apiVersion", false, sink);
      const headers = {};
      if (value.headers !== undefined) {
        if (!isRecord(value.headers))
          sink.problems.push(`${where}.headers must be an object of strings`);
        else
          for (const [header, headerValue] of Object.entries(value.headers)) {
            const resolved = resolveString(headerValue, where, `headers.${header}`, true, sink);
            if (resolved !== undefined)
              headers[header.toLowerCase()] = resolved;
          }
      }
      let betas = [];
      if (value.betas !== undefined) {
        if (!Array.isArray(value.betas) || value.betas.some((beta) => typeof beta !== "string"))
          sink.problems.push(`${where}.betas must be an array of strings`);
        else
          betas = value.betas;
      }
      if (value.includeUsage !== undefined && typeof value.includeUsage !== "boolean")
        sink.problems.push(`${where}.includeUsage must be a boolean`);
      if (value.maxTokensField !== undefined && value.maxTokensField !== "max_tokens" && value.maxTokensField !== "max_completion_tokens")
        sink.problems.push(`${where}.maxTokensField must be max_tokens or max_completion_tokens`);
      const given = (field, resolved) => resolved || sink.unresolved.some((line) => line.startsWith(`${field}:`)) || sink.problems.some((line) => line.startsWith(`${where}.${field} `));
      if (!given("apiKey", apiKey) && type !== "openai-compatible")
        sink.problems.push(`${where}.apiKey is required for type ${type}`);
      if ((type === "anthropic-foundry" || type === "azure-openai") && !given("resource", resource) && !given("baseUrl", baseUrl))
        sink.problems.push(`${where}: type ${type} needs "resource" (Azure resource name) or "baseUrl"`);
      if ((type === "openai-compatible" || type === "ezil-gateway") && !given("baseUrl", baseUrl))
        sink.problems.push(`${where}: type ${type} needs "baseUrl"`);
      if (baseUrl && !/^https?:\/\//.test(baseUrl))
        sink.problems.push(`${where}.baseUrl must start with http:// or https://`);
      if (resource && !/^[a-z0-9-]+$/i.test(resource))
        sink.problems.push(`${where}.resource must be a bare Azure resource name (letters, digits, hyphens)`);
      const provider = {
        name,
        type,
        apiKey,
        baseUrl,
        resource,
        apiVersion,
        headers,
        betas,
        includeUsage: value.includeUsage !== false,
        maxTokensField: value.maxTokensField
      };
      outcomes[name] = { provider, unresolved: sink.unresolved, problems: sink.problems, omittedModels: 0 };
      if (!sink.problems.length && !sink.unresolved.length)
        providers[name] = provider;
    }
  }
  const defaults = isRecord(raw.defaults) ? raw.defaults : {};
  if (raw.defaults !== undefined && !isRecord(raw.defaults))
    errors.push('"defaults" must be an object (ignored)');
  const models = [];
  const seen = new Set;
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    fatal.push('"models" must be a non-empty array');
  } else {
    raw.models.forEach((entry, index) => {
      const where = `models[${index}]`;
      const problems = [];
      if (!isRecord(entry)) {
        errors.push(`${where} must be an object`);
        return;
      }
      const merged = { ...defaults, ...entry };
      const id = typeof merged.id === "string" ? merged.id : undefined;
      if (!id || !ID_PATTERN.test(id)) {
        errors.push(`${where}.id must match ${ID_PATTERN}`);
        return;
      }
      if (seen.has(id.toLowerCase()))
        problems.push(`${where}.id "${id}" is duplicated (ids are compared case-insensitively)`);
      seen.add(id.toLowerCase());
      const providerName = typeof merged.provider === "string" ? merged.provider : undefined;
      const outcome = providerName ? outcomes[providerName] : undefined;
      if (!outcome) {
        errors.push(`${where}.provider "${String(merged.provider)}" is not defined in "providers"`);
        return;
      }
      const provider = outcome.provider;
      if (typeof merged.model !== "string" || !merged.model) {
        errors.push(`${where}.model (provider model id or deployment name) is required`);
        return;
      }
      const positiveInt = (value, field, fallback) => {
        if (value === undefined)
          return fallback;
        if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
          problems.push(`${where}.${field} must be a positive integer`);
          return fallback;
        }
        return value;
      };
      const gatewayOutput = () => {
        const fallback = merged.model === "us.moonshotai.kimi-k3" ? 4096 : 8192;
        if (merged.maxOutputTokens === undefined)
          return fallback;
        if (typeof merged.maxOutputTokens !== "number" || !Number.isFinite(merged.maxOutputTokens)) {
          problems.push(`${where}.maxOutputTokens must be finite`);
          return fallback;
        }
        return Math.max(16, Math.min(16384, Math.floor(merged.maxOutputTokens)));
      };
      const capabilities = isRecord(merged.capabilities) ? merged.capabilities : {};
      if (merged.capabilities !== undefined && !isRecord(merged.capabilities))
        problems.push(`${where}.capabilities must be an object`);
      const toolCalling = capabilities.toolCalling === undefined ? true : capabilities.toolCalling;
      if (typeof toolCalling !== "boolean" && typeof toolCalling !== "number")
        problems.push(`${where}.capabilities.toolCalling must be a boolean or a number`);
      const imageInput = capabilities.imageInput === undefined ? true : capabilities.imageInput;
      if (typeof imageInput !== "boolean")
        problems.push(`${where}.capabilities.imageInput must be a boolean`);
      let thinking;
      if (merged.thinking !== undefined) {
        if (!isRecord(merged.thinking))
          problems.push(`${where}.thinking must be an object`);
        else {
          const type = merged.thinking.type;
          if (type !== "adaptive" && type !== "enabled" && type !== "disabled")
            problems.push(`${where}.thinking.type must be adaptive, enabled or disabled`);
          else {
            thinking = { type };
            if (merged.thinking.budgetTokens !== undefined)
              thinking.budgetTokens = positiveInt(merged.thinking.budgetTokens, "thinking.budgetTokens", 1024);
            if (type === "enabled" && thinking.budgetTokens === undefined)
              thinking.budgetTokens = 4096;
            if (thinking.budgetTokens !== undefined && thinking.budgetTokens < 1024)
              problems.push(`${where}.thinking.budgetTokens must be at least 1024`);
            if (merged.thinking.effort !== undefined) {
              if (!EFFORT_LEVELS.includes(merged.thinking.effort))
                problems.push(`${where}.thinking.effort must be one of ${EFFORT_LEVELS.join(", ")}`);
              else
                thinking.effort = merged.thinking.effort;
            }
            if (merged.thinking.display !== undefined) {
              if (!["summarized", "omitted", "updates"].includes(merged.thinking.display))
                problems.push(`${where}.thinking.display must be summarized, omitted or updates`);
              else
                thinking.display = merged.thinking.display;
            }
          }
        }
      }
      const cache = { enabled: isAnthropic(provider.type), ttl: "5m" };
      if (merged.cache !== undefined) {
        if (!isRecord(merged.cache))
          problems.push(`${where}.cache must be an object`);
        else {
          if (merged.cache.enabled !== undefined) {
            if (typeof merged.cache.enabled !== "boolean")
              problems.push(`${where}.cache.enabled must be a boolean`);
            else
              cache.enabled = merged.cache.enabled;
          }
          if (merged.cache.ttl !== undefined) {
            if (merged.cache.ttl !== "5m" && merged.cache.ttl !== "1h")
              problems.push(`${where}.cache.ttl must be "5m" or "1h"`);
            else
              cache.ttl = merged.cache.ttl;
          }
        }
      }
      if (cache.enabled && !isAnthropic(provider.type))
        cache.enabled = false;
      let roles = [];
      if (merged.roles !== undefined) {
        if (!Array.isArray(merged.roles) || merged.roles.some((role) => !MODEL_ROLES.includes(role)))
          problems.push(`${where}.roles must be an array of ${MODEL_ROLES.join(", ")}`);
        else
          roles = merged.roles;
      }
      if (merged.default !== undefined && typeof merged.default !== "boolean")
        problems.push(`${where}.default must be a boolean`);
      if (merged.forcedToolChoice !== undefined && typeof merged.forcedToolChoice !== "boolean")
        problems.push(`${where}.forcedToolChoice must be a boolean`);
      if (merged.stream !== undefined && typeof merged.stream !== "boolean")
        problems.push(`${where}.stream must be a boolean`);
      if (merged.toolReserve !== undefined && (typeof merged.toolReserve !== "number" || !Number.isSafeInteger(merged.toolReserve) || merged.toolReserve < 0 || merged.toolReserve > 128479))
        problems.push(`${where}.toolReserve must be an integer from 0 to 128479`);
      if (merged.topP !== undefined && (typeof merged.topP !== "number" || !Number.isFinite(merged.topP)))
        problems.push(`${where}.topP must be finite`);
      if (merged.temperature !== undefined && (typeof merged.temperature !== "number" || !Number.isFinite(merged.temperature) || provider.type !== "ezil-gateway" && (merged.temperature < 0 || merged.temperature > 2)))
        problems.push(`${where}.temperature must be a number between 0 and 2`);
      for (const field of ["name", "family", "version", "tooltip", "detail"]) {
        if (merged[field] !== undefined && typeof merged[field] !== "string")
          problems.push(`${where}.${field} must be a string`);
      }
      const isDefault = merged.default === true || roles.includes("default");
      const resolved = {
        id,
        name: typeof merged.name === "string" ? merged.name : id,
        providerName: provider.name,
        provider,
        model: merged.model,
        family: typeof merged.family === "string" ? merged.family : isAnthropic(provider.type) ? "claude" : "gpt",
        version: typeof merged.version === "string" ? merged.version : "1",
        tooltip: typeof merged.tooltip === "string" ? merged.tooltip : undefined,
        detail: typeof merged.detail === "string" ? merged.detail : undefined,
        maxInputTokens: positiveInt(merged.maxInputTokens, "maxInputTokens", provider.type === "ezil-gateway" ? 131072 : 200000),
        maxOutputTokens: provider.type === "ezil-gateway" ? gatewayOutput() : positiveInt(merged.maxOutputTokens, "maxOutputTokens", isAnthropic(provider.type) ? 64000 : 32768),
        capabilities: { toolCalling, imageInput: provider.type === "ezil-gateway" ? false : imageInput },
        thinking,
        cache,
        default: isDefault,
        roles,
        forcedToolChoice: provider.type === "ezil-gateway" ? false : typeof merged.forcedToolChoice === "boolean" ? merged.forcedToolChoice : supportsForcedToolChoice(merged.model),
        stream: merged.model === "us.moonshotai.kimi-k3" ? false : merged.stream !== false,
        toolReserve: typeof merged.toolReserve === "number" ? merged.toolReserve : DEFAULT_TOOL_RESERVE,
        topP: typeof merged.topP === "number" ? merged.topP : undefined,
        temperature: typeof merged.temperature === "number" ? merged.temperature : undefined
      };
      if (problems.length) {
        errors.push(...problems);
        return;
      }
      if (outcome.problems.length || outcome.unresolved.length) {
        outcome.omittedModels += 1;
        return;
      }
      models.push(resolved);
    });
    if (models.length && !models.some((model) => model.default))
      models[0].default = true;
    const defaultModels = models.filter((model) => model.default);
    if (defaultModels.length > 1) {
      errors.push(`only one model may be marked "default" (${defaultModels.map((model) => model.id).join(", ")}); keeping ${defaultModels[0].id}`);
      for (const model of defaultModels.slice(1))
        model.default = false;
    }
  }
  for (const [name, outcome] of Object.entries(outcomes)) {
    const omitted = `${outcome.omittedModels} model(s) not served`;
    if (outcome.problems.length)
      errors.push(`providers.${name} not loaded (${omitted}): ${[...outcome.problems, ...outcome.unresolved].join("; ")}`);
    else if (outcome.unresolved.length)
      warnings.push(`providers.${name} skipped (${omitted}): ${outcome.unresolved.join("; ")}`);
  }
  if (fatal.length)
    throw new ConfigError(fatal, options.source);
  return { providers, models, secrets: Array.from(new Set(secrets)).sort((a, b) => b.length - a.length), warnings, errors };
}
function redact(text2, secrets) {
  let out = text2;
  for (const secret of secrets) {
    if (secret.length < 4)
      continue;
    out = out.split(secret).join("[redacted]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret)
      out = out.split(encoded).join("[redacted]");
  }
  return out;
}
function describeConfig(config) {
  const lines = [];
  for (const warning of config.warnings)
    lines.push(`warning: ${warning}`);
  for (const error of config.errors)
    lines.push(`error: ${error}`);
  for (const provider of Object.values(config.providers)) {
    lines.push(`provider ${provider.name}: type=${provider.type}${provider.resource ? ` resource=${provider.resource}` : ""}${provider.baseUrl ? ` baseUrl=${provider.baseUrl}` : ""} apiKey=${provider.apiKey ? "set" : "none"}${provider.betas.length ? ` betas=${provider.betas.join(",")}` : ""}`);
  }
  for (const model of config.models) {
    lines.push(`model ${model.id}: "${model.name}" -> ${model.providerName}/${model.model} in=${model.maxInputTokens} out=${model.maxOutputTokens} tools=${String(model.capabilities.toolCalling)} images=${model.capabilities.imageInput}${model.thinking ? ` thinking=${model.thinking.type}${model.thinking.effort ? `/${model.thinking.effort}` : ""}` : ""}${model.cache.enabled ? ` cache=${model.cache.ttl}` : ""}${model.default ? " [default]" : ""}${model.roles.length ? ` roles=${model.roles.join(",")}` : ""}`);
  }
  return lines.join(`
`);
}

// extensions/ezil-models/src/gateway.ts
var import_node_crypto = require("node:crypto");

// extensions/ezil-models/src/sse.ts
async function* sseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder;
  let finished = false;
  let buffer = "";
  let event;
  let data = [];
  const flush = () => {
    if (!data.length) {
      event = undefined;
      return;
    }
    const out = { data: data.join(`
`) };
    if (event !== undefined)
      out.event = event;
    event = undefined;
    data = [];
    return out;
  };
  const handleLine = (line) => {
    if (line === "")
      return flush();
    if (line.startsWith(":"))
      return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" "))
      value = value.slice(1);
    if (field === "event")
      event = value;
    else if (field === "data")
      data.push(value);
    return;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      finished = done;
      buffer += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = buffer.search(/\r\n|\n|\r/)) >= 0) {
        if (!done && newline === buffer.length - 1 && buffer[newline] === "\r")
          break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer.startsWith(`\r
`, newline) ? 2 : 1));
        const out = handleLine(line);
        if (out)
          yield out;
      }
      if (done)
        break;
    }
    if (buffer) {
      const out = handleLine(buffer);
      if (out)
        yield out;
    }
    const tail = flush();
    if (tail)
      yield tail;
  } finally {
    if (!finished)
      await reader.cancel().catch(() => {
        return;
      });
    reader.releaseLock();
  }
}

// extensions/ezil-models/src/gateway-response.ts
var STOP_REASONS = new Set(["end_turn", "tool_use", "max_tokens", "stop_sequence", "refusal"]);

class GatewayResponseError extends Error {
  requestId;
  code;
  constructor(requestId, code = "stream_interrupted") {
    super(`EZiL AI: interrupted (request ${requestId ?? "unknown"})`);
    this.requestId = requestId;
    this.code = code;
  }
}
function usage(value) {
  if (!isObject(value))
    throw new Error("Invalid usage");
  const count = (key) => {
    const n = value[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
      throw new Error("Invalid usage");
    return n;
  };
  return {
    inputTokens: count("input_tokens"),
    outputTokens: count("output_tokens"),
    cacheReadTokens: count("cache_read_input_tokens"),
    cacheWriteTokens: count("cache_creation_input_tokens")
  };
}
function toolEvent(block) {
  if (typeof block.id !== "string" || typeof block.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(block.id) || !/^[a-zA-Z0-9_-]{1,64}$/.test(block.name) || !isObject(block.input))
    throw new Error("Invalid tool");
  return { type: "tool_call", callId: block.id, name: block.name, input: block.input };
}
function gatewayJson(value, requestId) {
  try {
    if (!isObject(value) || value.type !== "message" || value.role !== "assistant" || !Array.isArray(value.content) || typeof value.stop_reason !== "string" || !STOP_REASONS.has(value.stop_reason))
      throw new Error("Invalid message");
    const events = [];
    for (const block of value.content) {
      if (!isObject(block))
        throw new Error("Invalid block");
      if (block.type === "text" && typeof block.text === "string")
        events.push({ type: "text", value: block.text });
      else if (block.type === "thinking" && typeof block.thinking === "string") {
        events.push({ type: "thinking", value: block.thinking, metadata: { signature: block.signature } });
      } else if (block.type === "tool_use")
        events.push(toolEvent(block));
      else if (block.type !== "redacted_thinking")
        throw new Error("Invalid block");
    }
    events.push({ type: "usage", usage: usage(value.usage) }, { type: "stop", reason: value.stop_reason, details: { requestId } });
    return events;
  } catch {
    throw new GatewayResponseError(requestId, "invalid_response");
  }
}
async function* gatewayStream(events, requestId) {
  let started = false;
  let stopped = false;
  let finalUsage;
  let stopReason;
  const blocks = new Map;
  const seen = new Set;
  try {
    for await (const event of events) {
      if (event.event === "error")
        throw new GatewayResponseError(requestId);
      const raw = JSON.parse(event.data);
      if (!isObject(raw))
        throw new Error("Invalid event");
      const type = event.event ?? raw.type;
      if (type === "error")
        throw new GatewayResponseError(requestId);
      if (type === "ping")
        continue;
      if (stopped || raw.type !== undefined && raw.type !== type)
        throw new Error("Invalid order");
      if (type === "message_start") {
        if (started || !isObject(raw.message) || raw.message.role !== "assistant")
          throw new Error("Invalid start");
        started = true;
        continue;
      }
      if (!started)
        throw new Error("Missing start");
      if (type === "message_delta") {
        if (blocks.size || finalUsage || !isObject(raw.delta) || typeof raw.delta.stop_reason !== "string" || !STOP_REASONS.has(raw.delta.stop_reason))
          throw new Error("Invalid final delta");
        finalUsage = usage(raw.usage);
        stopReason = raw.delta.stop_reason;
        continue;
      }
      if (type === "message_stop") {
        if (!finalUsage || !stopReason || blocks.size)
          throw new Error("Missing completion");
        stopped = true;
        continue;
      }
      if (finalUsage || typeof raw.index !== "number" || !Number.isSafeInteger(raw.index) || raw.index < 0)
        throw new Error("Invalid index");
      const index = raw.index;
      if (type === "content_block_start") {
        if (seen.has(index) || !isObject(raw.content_block))
          throw new Error("Invalid block start");
        const block = raw.content_block;
        if (block.type !== "text" && block.type !== "tool_use")
          throw new Error("Invalid block type");
        seen.add(index);
        blocks.set(index, { block, json: "" });
        if (block.type === "text") {
          if (typeof block.text !== "string")
            throw new Error("Invalid text");
          if (block.text)
            yield { type: "text", value: block.text };
        }
      } else if (type === "content_block_delta") {
        const current = blocks.get(index);
        if (!current || !isObject(raw.delta))
          throw new Error("Invalid delta");
        const delta = raw.delta;
        if (current.block.type === "text" && delta.type === "text_delta" && typeof delta.text === "string")
          yield { type: "text", value: delta.text };
        else if (current.block.type === "tool_use" && delta.type === "input_json_delta" && typeof delta.partial_json === "string")
          current.json += delta.partial_json;
        else
          throw new Error("Invalid delta");
      } else if (type === "content_block_stop") {
        const current = blocks.get(index);
        if (!current)
          throw new Error("Invalid block stop");
        if (current.block.type === "tool_use")
          yield toolEvent({ ...current.block, input: current.json ? JSON.parse(current.json) : current.block.input });
        blocks.delete(index);
      } else
        throw new Error("Unknown event");
    }
    if (!stopped)
      throw new GatewayResponseError(requestId);
    yield { type: "usage", usage: finalUsage };
    yield { type: "stop", reason: stopReason, details: { requestId } };
  } catch (error) {
    if (error instanceof GatewayResponseError)
      throw error;
    throw new GatewayResponseError(requestId);
  }
}

// extensions/ezil-models/src/status-data.ts
var AI_NOTICE = "AI responses may be inaccurate. Review changes before applying them.";
var record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var micro = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
var numericLimitKeys = ["concurrency", "rpm", "tpm", "max_output_tokens", "daily_budget_micro", "monthly_budget_micro"];
var counterKeys = ["inflight", "pending", "rpm", "tpm", "day_micro", "month_micro"];
var count = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
var alias = (value) => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
var source = (value) => ["default", "role", "plan", "account", "user"].includes(value);
function parsePolicy(value) {
  if (!record(value) || !record(value.policy) || !record(value.sources))
    return;
  const policy = {};
  const sources = {};
  for (const key of numericLimitKeys) {
    if (!(key in value.policy))
      continue;
    const n = value.policy[key];
    const s = value.sources[key];
    if (!count(n) || !source(s))
      return;
    policy[key] = n;
    sources[key] = s;
  }
  if ("allowed_models" in value.policy) {
    const models = value.policy.allowed_models;
    const s = value.sources.allowed_models;
    if (!Array.isArray(models) || !models.length || models.length > 100 || !models.every(alias) || !source(s))
      return;
    policy.allowed_models = models;
    sources.allowed_models = s;
  }
  return { policy, sources };
}
function parseEffectiveLimits(value) {
  if (!record(value) || !record(value.entitlement) || typeof value.entitlement.required !== "boolean" || !(value.entitlement.basis === null || ["subscription", "entitlement_grant", "operations", "not_required"].includes(value.entitlement.basis)) || !record(value.models) || !record(value.ceilings) || !count(value.ceilings.concurrency) || value.ceilings.concurrency < 1 || !count(value.ceilings.rpm) || value.ceilings.rpm < 1 || !record(value.counters) || !Array.isArray(value.pauses))
    return;
  const policy = parsePolicy(value.policy);
  if (!policy)
    return;
  const models = [];
  for (const [name, raw] of Object.entries(value.models)) {
    const model = parsePolicy(raw);
    if (!alias(name) || !model)
      return;
    models.push([name, model]);
  }
  const counters = {};
  for (const key of counterKeys) {
    const n = value.counters[key];
    if (!count(n))
      return;
    counters[key] = n;
  }
  const pauses = [];
  for (const pause of value.pauses) {
    if (!record(pause) || !["user", "account", "role", "model", "client"].includes(pause.scope))
      return;
    pauses.push({ scope: pause.scope });
  }
  return {
    entitlement: { required: value.entitlement.required, basis: value.entitlement.basis },
    policy,
    models: Object.fromEntries(models),
    pauses,
    counters,
    ceilings: { concurrency: value.ceilings.concurrency, rpm: value.ceilings.rpm }
  };
}
function credits(value) {
  const amount = BigInt(value);
  const fraction = (amount % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return (amount / 1000000n).toLocaleString("en-US") + (fraction ? `.${fraction}` : "");
}
var localResetTime = (date) => new Date(date).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
var windowLength = (seconds) => seconds % 3600 === 0 ? `${seconds / 3600}-hour` : seconds % 60 === 0 ? `${seconds / 60}-minute` : `${seconds}-second`;
var decimalMicro = (value) => typeof value === "string" && /^\d+$/.test(value);
var timestamp = (value) => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
function parseBalance(value) {
  if (!record(value) || !micro(value.available_micro) || !micro(value.held_micro))
    return;
  const window = value.window;
  if (window !== undefined && window !== null && (!record(window) || !Number.isInteger(window.seconds) || window.seconds < 600 || window.seconds > 86400 || !decimalMicro(window.budget_micro) || !decimalMicro(window.used_micro) || !decimalMicro(window.remaining_micro) || !timestamp(window.started_at) || !timestamp(window.resets_at)))
    return;
  return { available_micro: value.available_micro, held_micro: value.held_micro, window };
}
async function get(provider, path, parse, doFetch, signal) {
  const timeout = AbortSignal.timeout(5000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    combined.throwIfAborted();
    const response = await doFetch(`${provider.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${provider.apiKey ?? ""}` },
      redirect: "error",
      cache: "no-store",
      signal: combined
    });
    const body = await response.json().catch(() => {
      return;
    });
    combined.throwIfAborted();
    if (!response.ok) {
      const code = record(body) && record(body.error) && typeof body.error.code === "string" && /^[a-z0-9_]{1,64}$/.test(body.error.code) ? body.error.code : `http_${response.status}`;
      const reason = record(body) && record(body.error) && ["expired", "token_expired", "no_ezil_role", "wrong_issuer", "bad_signature"].includes(body.error.reason) ? body.error.reason : undefined;
      return { code, ...reason ? { reason } : {} };
    }
    const value = parse(body);
    return value === undefined ? { code: "invalid_response" } : { value };
  } catch {
    return { code: timeout.aborted ? "request_timeout" : signal?.aborted ? "request_cancelled" : "network_error" };
  }
}
async function readAIStatus(provider, doFetch = fetch, signal) {
  if (provider?.type !== "ezil-gateway" || !provider.baseUrl)
    return { balance: { code: "not_configured" }, usage: { code: "not_configured" }, limits: { code: "not_configured" }, models: { code: "not_configured" } };
  const [balance, usage2, limits, models] = await Promise.all([
    get(provider, "/me/balance", parseBalance, doFetch, signal),
    get(provider, "/me/usage?limit=5", (value) => {
      if (!record(value) || !Array.isArray(value.data) || value.data.some((row) => !record(row) || typeof row.model !== "string" || typeof row.created_at !== "string" || typeof row.status !== "string" || !(row.cost_micro === null || micro(row.cost_micro)) || !(row.uncollected_micro === null || micro(row.uncollected_micro)) || micro(row.cost_micro) && (!micro(row.uncollected_micro) || row.uncollected_micro > row.cost_micro)))
        return;
      return value.data.slice(0, 5);
    }, doFetch, signal),
    get(provider, "/me/limits", parseEffectiveLimits, doFetch, signal),
    get(provider, "/models", (value) => {
      if (!record(value) || typeof value.killswitch !== "boolean" || !(value.pause === null || value.pause === "operations" || value.pause === "reconciliation"))
        return;
      return { killswitch: value.killswitch, pause: value.pause };
    }, doFetch, signal)
  ]);
  return { balance, usage: usage2, limits, models };
}
function statusProblem(result) {
  if (result.reason === "expired" || result.reason === "token_expired" || ["os_session_expired", "access_token_expired", "token_expired", "expired"].includes(result.code ?? "")) {
    return { label: "Session expired", detail: "Your AI sign-in has expired. Reopen Code or sign in to EZiL OS again.", attention: true };
  }
  if (result.code === "not_configured")
    return { label: "Not configured", detail: "EZiL AI is not configured for this computer.", attention: true };
  if (result.code === "os_session_missing")
    return { label: "Sign-in needed", detail: "This computer has not received an AI sign-in. Open EZiL OS and reopen Code. If this persists, check your account access.", attention: true };
  if (result.reason === "no_ezil_role" || ["not_a_member", "no_ezil_role", "role_mismatch", "forbidden", "http_403"].includes(result.code ?? "")) {
    return { label: "AI access needed", detail: "Your account does not have AI access. Contact your administrator.", attention: true };
  }
  if (result.code === "os_proxy_unauthorized")
    return { label: "Reconnect needed", detail: "This computer’s AI connection was refused. Restart the computer to reconnect.", attention: true };
  if (["unauthorized", "http_401"].includes(result.code ?? ""))
    return { label: "Sign-in needed", detail: "Your AI sign-in could not be verified. Reopen Code or sign in again.", attention: true };
  if (["suspended", "account_suspended"].includes(result.code ?? ""))
    return { label: "AI access suspended", detail: "AI access is suspended for your account. Contact your administrator.", attention: true };
  if (result.code === "no_entitlement")
    return { label: "AI access needed", detail: "AI access is not included for this account.", attention: true };
  if (["insufficient_credits", "no_live_grant"].includes(result.code ?? ""))
    return { label: "No credits available", detail: "No AI credits are currently available for this request.", attention: true };
  if (result.code === "window_budget_reached")
    return { label: "Window credits used", detail: "This window’s AI credits are used up.", attention: true };
  if (result.code === "request_cancelled")
    return { label: "Unavailable", detail: "The refresh was cancelled." };
  if (result.code === "request_timeout")
    return { label: "Unavailable", detail: "The refresh timed out. Try again." };
  return { label: "Unavailable", detail: "Could not load current information. Try again." };
}
var limitLabels = {
  concurrency: "Concurrent requests",
  rpm: "Requests per minute",
  tpm: "Tokens per minute",
  max_output_tokens: "Output tokens per request",
  daily_budget_micro: "Daily credit budget",
  monthly_budget_micro: "Monthly credit budget"
};
function policyLines(effective, ceilings) {
  const lines = [];
  for (const key of Object.keys(limitLabels)) {
    const configured = effective.policy[key];
    const ceiling = key === "concurrency" || key === "rpm" ? ceilings?.[key] : undefined;
    const limit = configured === undefined ? ceiling : ceiling === undefined ? configured : Math.min(configured, ceiling);
    if (limit === undefined) {
      if (ceilings)
        lines.push(`${limitLabels[key]}: unknown`);
      continue;
    }
    const source2 = ceiling !== undefined && (configured === undefined || ceiling < configured) ? "platform ceiling" : effective.sources[key];
    lines.push(`${limitLabels[key]}: ${key.endsWith("_micro") ? `${credits(limit)} credits` : limit.toLocaleString("en-US")} (${source2})`);
  }
  if (effective.policy.allowed_models)
    lines.push(`Allowed models: ${effective.policy.allowed_models.join(", ")} (${effective.sources.allowed_models})`);
  return lines;
}
function limitsLines(limits) {
  const basis = limits.entitlement.basis;
  const lines = ["Effective limits", `Entitlement: ${basis === null ? "none" : basis.replace(/_/g, " ")}${limits.entitlement.required ? " (required)" : ""}`];
  lines.push(...policyLines(limits.policy, limits.ceilings));
  const counters = limits.counters;
  lines.push(`Current requests: ${counters.inflight} in flight, ${counters.pending} pending`, `Last minute: ${counters.rpm} requests, ${counters.tpm} reserved tokens`, `Budget usage (held + settled): ${credits(counters.day_micro)} credits this Gateway day, ${credits(counters.month_micro)} this Gateway month`);
  for (const [model, policy] of Object.entries(limits.models)) {
    const detail = policyLines(policy);
    if (detail.length)
      lines.push(`Model limits — ${model} (also subject to account limits)`, ...detail);
  }
  const scopes = [...new Set(limits.pauses.map((p) => p.scope))];
  const memberScopes = scopes.filter((scope) => scope === "user" || scope === "account" || scope === "role");
  if (memberScopes.length)
    lines.push(`AI paused: ${memberScopes.join(", ")}`);
  const conditionalScopes = scopes.filter((scope) => scope === "model" || scope === "client");
  if (conditionalScopes.length)
    lines.push(`Scoped pauses may apply: ${conditionalScopes.join(", ")}`);
  return lines;
}
function statusView(state) {
  if (!state)
    return { text: "EZiL AI · Loading…", lines: ["EZiL AI", "Loading credits, limits and recent usage…", AI_NOTICE] };
  const balance = state.balance.value;
  const window = balance?.window;
  const reset = window?.resets_at ? localResetTime(window.resets_at) : undefined;
  let text2 = window ? `EZiL AI · ${credits(window.remaining_micro)} credits left${reset ? ` · resets ${reset}` : ""}` : balance ? `EZiL AI · ${credits(balance.available_micro)} credits` : "EZiL AI · Credits unavailable";
  const limits = state.limits.value;
  const global = creditState(state.models.value ? { ...state.models.value, data: [] } : undefined, undefined, "");
  const paused = global.state === "paused_reconciliation" || global.state === "paused_operations";
  const attention = [state.balance, state.limits, state.models, state.usage].filter((result) => result.code).map(statusProblem).find((problem) => problem.attention);
  if (attention)
    text2 = `EZiL AI · ${attention.label}`;
  else if (paused)
    text2 = global.state === "paused_reconciliation" ? "EZiL AI · Paused · reconciling usage" : "EZiL AI · Paused";
  else if (limits?.pauses.some((p) => p.scope === "user" || p.scope === "account" || p.scope === "role"))
    text2 = "EZiL AI · Paused";
  else if (limits?.entitlement.required && limits.entitlement.basis === null)
    text2 = "EZiL AI · AI access needed";
  else {
    if (window && BigInt(window.remaining_micro) === 0n)
      text2 += " · window used";
    else if (limits?.policy.policy.daily_budget_micro !== undefined && limits.counters.day_micro >= limits.policy.policy.daily_budget_micro)
      text2 = "EZiL AI · Daily credit budget used";
    else if (limits?.policy.policy.monthly_budget_micro !== undefined && limits.counters.month_micro >= limits.policy.policy.monthly_budget_micro)
      text2 = "EZiL AI · Monthly credit budget used";
    else if (balance?.available_micro === 0 && balance.held_micro > 0)
      text2 = "EZiL AI · Credits held";
    else if (balance?.available_micro === 0)
      text2 = "EZiL AI · 0 credits";
    if (!limits)
      text2 += " · limits unavailable";
    if (!state.models.value)
      text2 += " · availability unknown";
    if (!state.usage.value)
      text2 += " · usage unavailable";
  }
  const lines = ["EZiL AI", balance ? `Available credits: ${credits(balance.available_micro)}` : `Credits unavailable. ${statusProblem(state.balance).detail}`];
  if (balance)
    lines.push(`Held credits: ${credits(balance.held_micro)}`);
  if (balance?.available_micro === 0)
    lines.push(balance.held_micro > 0 ? "Your credits are held by requests in progress or being settled." : "No AI credits are available.");
  if (window) {
    lines.push(`${windowLength(window.seconds)} window: ${credits(window.remaining_micro)} credits left of ${credits(window.budget_micro)}`);
    lines.push(`Window used (held + settled): ${credits(window.used_micro)} credits`);
    lines.push(reset ? `Resets at ${reset} (local time)` : "Window starts with your next admitted request.");
    if (BigInt(window.remaining_micro) === 0n)
      lines.push("This window’s AI credits are used up.");
  }
  if (state.models.value)
    lines.push(paused ? global.text : "Global AI pause: none reported.");
  else
    lines.push(`Global AI availability unknown. ${statusProblem(state.models).detail}`);
  lines.push(...limits ? limitsLines(limits) : [`Limits unavailable. ${statusProblem(state.limits).detail}`]);
  lines.push("Recent usage (up to 5 requests)");
  if (state.usage.value) {
    if (!state.usage.value.length)
      lines.push("No recent usage.");
    for (const row of state.usage.value)
      lines.push(`${row.created_at} · ${row.model} · ${["reserved", "pending", "settled", "released", "failed", "cancelled"].includes(row.status) ? row.status : "unknown"} · ${row.cost_micro === null ? "charge pending" : `${credits(row.cost_micro - row.uncollected_micro)} credits`}`);
  } else
    lines.push(`Usage unavailable. ${statusProblem(state.usage).detail}`);
  lines.push(AI_NOTICE);
  return { text: text2, lines };
}

// extensions/ezil-models/src/gateway.ts
var GATEWAY_FIRST_BYTE_TIMEOUT_MS = 30000;
var GATEWAY_IDLE_TIMEOUT_MS = 30000;
var GATEWAY_MAX_IN_FLIGHT = 2;
var CONCURRENCY_WAIT_BUDGET_MS = 60000;
var MODELS_TTL_MS = 5 * 60000;
var SIDE_CALL_TIMEOUT_MS = 5000;
var MICRO_PER_CREDIT = 1e6;

class GatewayError extends Error {
  status;
  code;
  requestId;
  retryAfterSeconds;
  constructor(message, status, code, requestId, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "GatewayError";
  }
}
function providerIdentity(provider) {
  return JSON.stringify([provider.baseUrl, provider.apiKey ?? ""]);
}
var modelsCache = new Map;
function forgetGatewayModels(baseUrl) {
  if (baseUrl === undefined)
    modelsCache.clear();
  else
    for (const [key, cached] of modelsCache)
      if (cached.baseUrl === baseUrl)
        modelsCache.delete(key);
}
function authHeaders(provider) {
  const headers = { authorization: `Bearer ${provider.apiKey ?? ""}` };
  return headers;
}
async function getJson(provider, path, doFetch, signal) {
  const timeout = AbortSignal.timeout(SIDE_CALL_TIMEOUT_MS);
  const response = await doFetch(`${provider.baseUrl}${path}`, {
    headers: authHeaders(provider),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: "error"
  });
  const text2 = await response.text().catch(() => "");
  let json;
  try {
    json = text2 ? JSON.parse(text2) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}
function asModels(json) {
  if (typeof json !== "object" || json === null || !Array.isArray(json.data))
    return;
  const raw = json;
  if (raw.data === undefined || !Array.isArray(raw.data) || raw.data.some((entry) => typeof entry !== "object" || entry === null || typeof entry.id !== "string" || typeof entry.enabled !== "boolean" || !Number.isSafeInteger(entry.max_input_tokens) || entry.max_input_tokens <= 0 || !Number.isSafeInteger(entry.max_output_tokens) || entry.max_output_tokens <= 0))
    return;
  return { killswitch: raw.killswitch === true, pause: raw.pause === "operations" || raw.pause === "reconciliation" ? raw.pause : null, data: raw.data };
}
function withGatewayModelLimits(model, catalog) {
  const entry = catalog?.data.find((entry2) => entry2.id === model.model);
  if (!entry || model.provider.type !== "ezil-gateway")
    return model;
  return {
    ...model,
    maxInputTokens: Math.min(model.maxInputTokens, entry.max_input_tokens),
    maxOutputTokens: Math.min(model.maxOutputTokens, entry.max_output_tokens)
  };
}
async function gatewayModels(provider, doFetch, now = Date.now(), signal) {
  const key = providerIdentity(provider);
  const cached = modelsCache.get(key);
  if (cached && now - cached.at < MODELS_TTL_MS)
    return cached.models;
  try {
    const { status, json } = await getJson(provider, "/models", doFetch, signal);
    const models = status === 200 ? asModels(json) : undefined;
    if (models)
      modelsCache.set(key, { baseUrl: provider.baseUrl, at: now, models });
    return models;
  } catch {
    return;
  }
}
var CREDIT_STATE_TEXT = {
  unknown: "AI credit balance is unavailable.",
  paused_reconciliation: "AI is paused while usage is being reconciled. Your credits are safe.",
  paused_operations: "AI is temporarily unavailable. Your credits are safe.",
  model_disabled: "This model is not available right now.",
  used: "You have used your included AI credits.",
  expired: "Your AI credits have expired.",
  not_included: "AI credits are not included for this account.",
  held: "Your credits are held by requests in progress or being settled.",
  ok: "AI credits available."
};
function creditState(models, balance, alias2) {
  const pick = (state, credits2) => ({ state, text: state === "ok" && credits2 !== undefined ? `AI credits: ${credits2} remaining` : CREDIT_STATE_TEXT[state], ...credits2 === undefined ? {} : { credits: credits2 } });
  if (models?.killswitch)
    return pick(models.pause === "reconciliation" ? "paused_reconciliation" : "paused_operations");
  if (models && models.data.find((entry) => entry.id === alias2)?.enabled === false)
    return pick("model_disabled");
  if (!balance)
    return pick("unknown");
  if (balance.available_micro === 0 && balance.held_micro === 0) {
    if (balance.grants.some((grant) => grant.live))
      return pick("used");
    return pick(balance.grants.length ? "expired" : "not_included");
  }
  if (balance.available_micro === 0 && balance.held_micro > 0)
    return pick("held");
  return pick("ok", balance.available_micro / MICRO_PER_CREDIT);
}
function parseErrorBody(text2) {
  try {
    const parsed = JSON.parse(text2);
    if (typeof parsed.error === "object" && parsed.error !== null)
      return parsed.error;
  } catch {}
  return {};
}
function retryDelay(value, fallback = 5, now = Date.now()) {
  const seconds = value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value ? (Date.parse(value) - now) / 1000 : fallback;
  return Math.min(60, Math.max(0, Number.isFinite(seconds) ? seconds : fallback));
}
function describeGatewayError(alias2, status, retryAfter, body, headerRequestId, balance, now = Date.now()) {
  const requestId = body.request_id ?? headerRequestId ?? undefined;
  const ref = requestId ? ` (request ${requestId})` : "";
  const code = body.code;
  const make = (message) => new GatewayError(`EZiL AI: ${message}${ref}`, status, code, requestId, retryDelay(retryAfter));
  if (body.reason === "no_ezil_role" || code === "no_ezil_role")
    return make("Your EZiL account has no AI access yet");
  switch (code) {
    case "window_budget_reached": {
      const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : retryAfter ? (Date.parse(retryAfter) - now) / 1000 : NaN;
      const reset = new Date(now + Math.max(0, delay) * 1000);
      const seconds = Number.isFinite(reset.getTime()) ? Math.max(0, Math.ceil(delay)) : undefined;
      return new GatewayError(`EZiL AI: This window's EZiL AI credits are used up. ${seconds === undefined ? "Check EZiL AI status for the reset time." : `Resets at ${localResetTime(reset)} (local time).`}${ref}`, status, code, requestId, seconds);
    }
    case "insufficient_credits":
    case "no_live_grant": {
      const available = body.available_micro ?? balance?.available_micro;
      const state = balance ? creditState(undefined, balance, alias2).text : body.no_live_grant || code === "no_live_grant" ? "No live AI credit grant." : "Not enough AI credits for this request.";
      return make(`${state}${available !== undefined ? ` Available credits: ${available / MICRO_PER_CREDIT}.` : ""}`);
    }
    case "os_session_missing":
      return make("EZiL AI is not available here yet: this account has no EZiL AI access, or this computer has not received your sign-in. Reopen Code to retry");
    case "os_session_expired":
    case "access_token_expired":
      return make("Your OS sign-in has expired. Reopen Code or sign in again");
    case "os_proxy_unauthorized":
      return make("EZiL OS refused this computer’s AI connection. Restart the computer to reconnect");
    case "unauthorized":
      if (body.reason === "token_expired" || body.reason === "expired")
        return make("Your AI sign-in has expired. Reopen Code or sign in again");
      if (body.reason === "wrong_issuer")
        return make("EZiL AI does not accept this account’s sign-in (this OS environment is not connected to EZiL AI)");
      if (body.reason === "bad_signature")
        return make("EZiL AI could not verify this account’s sign-in signature. Contact your administrator");
      return make("EZiL AI refused this account’s sign-in. Contact your administrator");
    case "os_ai_unavailable":
      return make("EZiL OS could not reach EZiL AI. Retry the request");
    case "not_a_member":
    case "role_mismatch":
    case "forbidden":
      return make("Your EZiL account does not have AI membership");
    case "account_suspended":
    case "suspended":
      return make("AI access is suspended for your EZiL account");
    case "input_too_large":
    case "body_too_large":
      return make("Conversation too large — start a new chat");
    case "unsupported_bedrock_converse_request":
    case "unsupported_parameter":
    case "invalid_request":
    case "max_output_tokens_invalid":
    case "idempotency_conflict":
    case "idempotency_key_required":
      return make(`Internal EZiL Models bug (${code}); please report it`);
    case "killswitch":
      return make(body.pause === "reconciliation" ? "AI is paused while usage is reconciled" : "AI is paused by operations");
    case "paused":
    case "pause":
    case "global_cap_reached":
      return make("AI is temporarily paused");
    case "no_provider_route":
    case "model_disabled":
    case "model_not_found":
      return make("This model is temporarily unavailable");
    case "upstream_timeout":
      return make("The model provider did not answer in time");
    case "idempotency_replay":
      return make("already processed");
    case "rate_limited":
      return make("Too many requests; try again later");
    case "concurrency_limit":
      return make("Wait for the current response to finish");
    default:
      if (status === 401)
        return make("The AI service refused authentication. Contact your administrator");
      if (status === 402)
        return make("No AI credits available");
      if (status === 403)
        return make("Your EZiL account does not have AI access");
      if (status === 413)
        return make("Conversation too large — start a new chat");
      return make(`AI request failed (${code ?? `HTTP ${status}`})`);
  }
}
var admissionGates = new Map;
function acquireGatewaySlot(key, signal, budget) {
  signal.throwIfAborted();
  const gate = admissionGates.get(key) ?? { active: 0, queue: [] };
  admissionGates.set(key, gate);
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const enter = () => {
      cleanup();
      gate.active++;
      let released = false;
      resolve(() => {
        if (released)
          return;
        released = true;
        gate.active--;
        const next = gate.queue.shift();
        if (next)
          next();
        else if (gate.active === 0)
          admissionGates.delete(key);
      });
    };
    const leave = (error) => {
      const index = gate.queue.indexOf(enter);
      if (index >= 0)
        gate.queue.splice(index, 1);
      cleanup();
      reject(error);
    };
    const onAbort = () => leave(signal.reason);
    if (gate.active < GATEWAY_MAX_IN_FLIGHT) {
      enter();
      return;
    }
    if (budget && budget.ms <= 0) {
      reject(budget.error);
      return;
    }
    gate.queue.push(enter);
    signal.addEventListener("abort", onAbort, { once: true });
    if (budget)
      timer = setTimeout(() => leave(budget.error), budget.ms);
  });
}
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function bounded(work, ms, abort, error) {
  let timer;
  let onAbort = () => {};
  const deadline = new Promise((_, reject) => {
    onAbort = () => reject(abort.signal.reason);
    timer = setTimeout(() => abort.abort(error), Math.max(1, ms));
    abort.signal.addEventListener("abort", onAbort, { once: true });
    if (abort.signal.aborted)
      onAbort();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    abort.signal.removeEventListener("abort", onAbort);
  }
}
async function timedResponse(doFetch, url, init, abort) {
  const started = performance.now();
  const timeout = (code, requestId2) => new GatewayError(`EZiL AI: ${code === "first_byte_timeout" ? "did not answer within 30 seconds" : "the response stopped arriving"}. Retry the request${requestId2 ? ` (request ${requestId2})` : ""}`, undefined, code, requestId2);
  const response = await bounded(doFetch(url, { ...init, signal: abort.signal }), GATEWAY_FIRST_BYTE_TIMEOUT_MS, abort, timeout("first_byte_timeout"));
  if (!response.body)
    return response;
  const reader = response.body.getReader();
  const requestId = response.headers.get("x-ezil-request-id") ?? undefined;
  let first = true;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const next = await bounded(reader.read(), first ? GATEWAY_FIRST_BYTE_TIMEOUT_MS - (performance.now() - started) : GATEWAY_IDLE_TIMEOUT_MS, abort, timeout(first ? "first_byte_timeout" : "stream_idle_timeout", requestId));
        first = false;
        if (next.done)
          controller.close();
        else
          controller.enqueue(next.value);
      } catch (error) {
        reader.cancel().catch(() => {});
        controller.error(error);
      }
    },
    cancel() {
      abort.abort();
      reader.cancel().catch(() => {});
    }
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, headers: response.headers });
}
async function* gatewayChat(model, request, options) {
  const provider = model.provider;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const started = now();
  const log = (line) => options.log?.(redact(line, [provider.apiKey ?? "", ...Object.values(provider.headers)]));
  const idempotencyKey = (options.newIdempotencyKey ?? import_node_crypto.randomUUID)();
  let requestId;
  let hold = null;
  let status;
  let stopReason;
  let errorCode;
  let stream = model.model !== "us.moonshotai.kimi-k3" && model.stream !== false;
  let used = emptyUsage();
  let attemptAbort = new AbortController;
  const cancelAttempt = () => attemptAbort.abort(options.signal.reason);
  options.signal.addEventListener("abort", cancelAttempt, { once: true });
  try {
    options.signal.throwIfAborted();
    const built = buildGatewayBody(model, request, log);
    stream = built.body.stream;
    const url = `${provider.baseUrl}/messages`;
    options.onRequest?.(url, built, idempotencyKey);
    const headers = { ...authHeaders(provider), "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", "idempotency-key": idempotencyKey };
    const identity = providerIdentity(provider);
    let retried = false;
    let concurrencyStarted;
    let concurrencyWaited = 0;
    let concurrencyRetries = 0;
    let concurrencyError;
    const remainingWait = () => Math.max(0, CONCURRENCY_WAIT_BUDGET_MS - Math.max(concurrencyWaited, concurrencyStarted === undefined ? 0 : now() - concurrencyStarted));
    for (;; ) {
      options.signal.throwIfAborted();
      const release = await acquireGatewaySlot(identity, options.signal, concurrencyError ? { ms: remainingWait(), error: concurrencyError } : undefined);
      let waitMs;
      try {
        options.signal.throwIfAborted();
        if (concurrencyError && now() - concurrencyStarted > CONCURRENCY_WAIT_BUDGET_MS)
          throw concurrencyError;
        attemptAbort = new AbortController;
        let response;
        try {
          response = await timedResponse(doFetch, url, { method: "POST", headers, body: built.bytes, redirect: "error" }, attemptAbort);
        } catch (error) {
          if (options.signal.aborted || attemptAbort.signal.reason instanceof GatewayError)
            throw error;
          if (!retried) {
            retried = true;
            continue;
          }
          throw new GatewayError("EZiL AI: cannot reach EZiL AI. Retry the request", undefined, "os_unreachable", requestId);
        }
        status = response.status;
        hold = response.headers.get("x-ezil-hold-micro");
        requestId = response.headers.get("x-ezil-request-id") ?? undefined;
        if (response.ok) {
          options.signal.throwIfAborted();
          if (!response.body)
            throw new GatewayResponseError(requestId);
          const contentType = response.headers.get("content-type") ?? "";
          if (!(stream ? contentType.includes("text/event-stream") : contentType.includes("application/json"))) {
            await response.body.cancel();
            throw new GatewayResponseError(requestId, "invalid_response");
          }
          const events = stream ? gatewayStream(sseEvents(response.body), requestId) : gatewayJson(await response.json(), requestId);
          for await (const event of events) {
            options.signal.throwIfAborted();
            if (event.type === "usage")
              used = event.usage;
            if (event.type === "stop")
              stopReason = event.reason;
            yield event;
          }
          if (stopReason === "max_tokens")
            throw new GatewayError(`Response truncated (request ${requestId ?? "unknown"})`, status, "max_tokens", requestId);
          return;
        }
        const body = parseErrorBody(await response.text());
        requestId = body.request_id ?? requestId;
        const retryAfter = response.headers.get("retry-after");
        if (status === 429 && body.code === "concurrency_limit") {
          concurrencyStarted ??= now();
          concurrencyError = describeGatewayError(model.model, status, retryAfter, body, requestId ?? null, undefined, now());
          const remaining = remainingWait();
          if (remaining <= 0)
            throw concurrencyError;
          const fallback = Math.min(15, 2 ** Math.min(concurrencyRetries + 1, 4));
          waitMs = Math.min(remaining, Math.min(15, Math.max(1, retryDelay(retryAfter, fallback, now()))) * 1000);
          concurrencyWaited += waitMs;
          concurrencyRetries++;
          retried = true;
        } else if (!retried && status === 429 && body.code === "rate_limited") {
          retried = true;
          waitMs = retryDelay(retryAfter, 60, now()) * 1000;
        } else {
          if (["killswitch", "model_disabled", "model_not_found", "max_output_tokens_invalid", "input_too_large"].includes(body.code ?? ""))
            forgetGatewayModels(provider.baseUrl);
          throw describeGatewayError(model.model, status, retryAfter, body, requestId ?? null, undefined, now());
        }
      } finally {
        attemptAbort.abort();
        release();
      }
      await (options.sleep ?? defaultSleep)(waitMs, options.signal);
    }
  } catch (error) {
    if (options.signal.aborted)
      return;
    if (attemptAbort.signal.reason instanceof GatewayError)
      error = attemptAbort.signal.reason;
    errorCode = error instanceof GatewayError || error instanceof GatewayResponseError ? error.code : status === undefined ? "invalid_request" : "stream_interrupted";
    if (error instanceof GatewayError || error instanceof GatewayResponseError)
      throw error;
    if (status !== undefined)
      throw new GatewayResponseError(requestId);
    throw new GatewayError("Conversation too large or invalid — start a new chat", undefined, errorCode, requestId);
  } finally {
    options.signal.removeEventListener("abort", cancelAttempt);
    attemptAbort.abort();
    const cancelled = options.signal.aborted;
    log(JSON.stringify({
      request_id: requestId ?? null,
      model: model.model,
      stream,
      hold,
      http_status: status ?? null,
      latency_ms: Math.max(0, now() - started),
      usage: { input: used.inputTokens, output: used.outputTokens, cache_read: used.cacheReadTokens, cache_write: used.cacheWriteTokens },
      stop_reason: stopReason ?? null,
      error_code: cancelled ? "cancelled" : errorCode ?? null,
      ...cancelled ? { notice: `cancelled; may still be charged (request ${requestId ?? "unknown"})` } : {}
    }));
  }
}

// extensions/ezil-models/src/status.ts
var vscode = __toESM(require("vscode"));
class EZiLAIStatus {
  provider;
  doFetch;
  ui;
  item;
  timer;
  state;
  request;
  disposed = false;
  constructor(provider, doFetch = fetch, ui = vscode) {
    this.provider = provider;
    this.doFetch = doFetch;
    this.ui = ui;
    this.item = ui.window.createStatusBarItem("ezil-models.aiStatus", ui.StatusBarAlignment.Right, 101);
    this.item.name = "EZiL AI";
    this.item.command = "ezil-models.showStatus";
    this.render();
    this.item.show();
    this.timer = setInterval(() => {
      this.refresh();
    }, 60000);
    this.timer.unref?.();
  }
  render() {
    const view = statusView(this.state);
    this.item.text = view.text;
    this.item.tooltip = view.lines.join(`
`);
    this.item.accessibilityInformation = { label: view.lines.join(". ") };
  }
  async refresh() {
    if (this.disposed)
      return;
    this.request?.abort();
    const request = this.request = new AbortController;
    const configured = this.provider();
    const provider = configured ? { ...configured } : undefined;
    this.state = undefined;
    this.render();
    const state = await readAIStatus(provider, this.doFetch, request.signal);
    if (this.disposed || this.request !== request)
      return;
    const current = this.provider();
    if (current?.type !== provider?.type || current?.baseUrl !== provider?.baseUrl || current?.apiKey !== provider?.apiKey)
      return;
    this.state = state;
    this.render();
  }
  async show() {
    await this.refresh();
    if (this.disposed)
      return;
    const view = statusView(this.state);
    await this.ui.window.showQuickPick(view.lines.slice(1).map((label) => ({ label })), { title: "EZiL AI", placeHolder: "Credits, effective limits and recent Gateway usage" });
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.request?.abort();
    this.item.dispose();
  }
}

// extensions/ezil-models/src/provider.ts
var vscode2 = __toESM(require("vscode"));

// extensions/ezil-models/src/anthropic.ts
/*!
 * Portions of the message conversion are derived from Microsoft VS Code Copilot Chat:
 * https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/byok/vscode-node/anthropicMessageConverter.ts
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the following
 * conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
var MAX_CACHE_BREAKPOINTS = 4;
function supportsCacheControl(block) {
  return block.type !== "thinking" && block.type !== "redacted_thinking";
}
function markCache(blocks) {
  const previous = blocks.at(-1);
  if (!previous || !supportsCacheControl(previous))
    return false;
  previous.cache_control = { type: "ephemeral" };
  return true;
}
function dataBlock(part) {
  if (IMAGE_MIME_TYPES.has(part.mimeType))
    return { type: "image", source: { type: "base64", media_type: part.mimeType, data: base64(part.data) } };
  if (part.mimeType === "application/pdf")
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64(part.data) } };
  if (part.mimeType.startsWith("text/"))
    return { type: "text", text: Buffer.from(part.data).toString("utf8") };
  return;
}
function convertParts(parts) {
  const blocks = [];
  let leadingMarker = false;
  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.value !== "")
          blocks.push({ type: "text", text: part.value });
        break;
      case "thinking": {
        const meta = part.metadata ?? {};
        if (typeof meta.redactedData === "string")
          blocks.push({ type: "redacted_thinking", data: meta.redactedData });
        else if (typeof meta._completeThinking === "string" && typeof meta.signature === "string" && meta.signature)
          blocks.push({ type: "thinking", thinking: meta._completeThinking, signature: meta.signature });
        break;
      }
      case "tool_call":
        blocks.push({ type: "tool_use", id: part.callId, name: part.name, input: typeof part.input === "object" && part.input !== null ? part.input : {} });
        break;
      case "tool_result": {
        const content = [];
        let cached = false;
        for (const inner of part.content) {
          if (inner.type === "text") {
            if (inner.value !== "")
              content.push({ type: "text", text: inner.value });
          } else if (isCacheMarker(inner))
            cached = true;
          else if (inner.type === "data") {
            const block2 = dataBlock(inner);
            if (block2)
              content.push(block2);
          }
        }
        const block = { type: "tool_result", tool_use_id: part.callId };
        if (content.length)
          block.content = content;
        if (part.isError)
          block.is_error = true;
        if (cached)
          block.cache_control = { type: "ephemeral" };
        blocks.push(block);
        break;
      }
      case "data":
        if (isCacheMarker(part)) {
          if (!markCache(blocks) && !blocks.length)
            leadingMarker = true;
        } else if (!isStatefulMarker(part)) {
          const block = dataBlock(part);
          if (block)
            blocks.push(block);
        }
        break;
    }
  }
  return { blocks, leadingMarker };
}
var MISSING_RESULT_TEXT = "No result was recorded for this tool call.";
function pairToolCalls(messages) {
  let pending = new Set;
  for (const message of messages) {
    if (message.role === "assistant") {
      pending = new Set(message.content.filter((block) => block.type === "tool_use").map((block) => String(block.id)));
      continue;
    }
    const answered = new Set;
    message.content = message.content.map((block) => {
      if (block.type !== "tool_result")
        return block;
      const id = String(block.tool_use_id);
      if (pending.has(id)) {
        answered.add(id);
        return block;
      }
      const text2 = block.content?.map((inner) => typeof inner.text === "string" ? inner.text : `[${inner.type}]`).join(`
`) ?? "";
      const orphan = { type: "text", text: `[Result of an earlier tool call ${id} whose request is no longer in the conversation]
${text2}` };
      if (block.cache_control)
        orphan.cache_control = block.cache_control;
      return orphan;
    });
    const missing = [...pending].filter((id) => !answered.has(id));
    if (missing.length)
      message.content.unshift(...missing.map((id) => ({ type: "tool_result", tool_use_id: id, is_error: true, content: [{ type: "text", text: MISSING_RESULT_TEXT }] })));
    pending = new Set;
  }
}
function convertMessages(messages) {
  const system = [];
  const merged = [];
  for (const message of messages) {
    if (message.role === "system") {
      let text2 = "";
      let cached = false;
      for (const part of message.parts) {
        if (part.type === "text")
          text2 += part.value;
        else if (isCacheMarker(part))
          cached = true;
      }
      if (text2) {
        const block = { type: "text", text: text2 };
        if (cached)
          block.cache_control = { type: "ephemeral" };
        system.push(block);
      } else if (cached && system.length)
        system.at(-1).cache_control = { type: "ephemeral" };
      continue;
    }
    const { blocks: content, leadingMarker } = convertParts(message.parts);
    if (leadingMarker) {
      const previous2 = merged.at(-1);
      if (previous2)
        markCache(previous2.content);
    }
    if (!content.length)
      continue;
    const previous = merged.at(-1);
    if (previous && previous.role === message.role)
      previous.content.push(...content);
    else
      merged.push({ role: message.role, content });
  }
  pairToolCalls(merged);
  return { system, messages: merged };
}
function applyCacheBreakpoints(body, ttl) {
  const ordered = [...body.tools ?? [], ...body.system ?? [], ...body.messages.flatMap((message) => message.content)];
  const marked = () => ordered.filter((block) => block.cache_control);
  const candidates = [
    body.system?.at(-1),
    body.messages.filter((message) => message.role === "user").at(-1)?.content.filter(supportsCacheControl).at(-1),
    body.tools?.at(-1)
  ];
  for (const candidate of candidates) {
    if (!candidate || candidate.cache_control)
      continue;
    if (marked().length >= MAX_CACHE_BREAKPOINTS)
      break;
    candidate.cache_control = { type: "ephemeral" };
  }
  let current = marked();
  while (current.length > MAX_CACHE_BREAKPOINTS) {
    delete current[0].cache_control;
    current = marked();
  }
  for (const block of current)
    block.cache_control = ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  return current.length;
}
function stripCacheControl(body) {
  for (const block of [...body.tools ?? [], ...body.system ?? [], ...body.messages.flatMap((message) => message.content)])
    delete block.cache_control;
}
function buildAnthropicBody(model, request) {
  const { system, messages } = convertMessages(request.messages);
  const body = {
    model: model.model,
    max_tokens: model.maxOutputTokens,
    stream: true,
    messages
  };
  if (system.length)
    body.system = system;
  if (request.tools.length) {
    body.tools = request.tools.map((tool) => {
      const block = { name: tool.name, input_schema: tool.inputSchema ?? { type: "object", properties: {} } };
      if (tool.description)
        block.description = tool.description;
      return block;
    });
    const thinkingOn = !!model.thinking && model.thinking.type !== "disabled";
    if (request.toolMode === "required" && model.forcedToolChoice && !thinkingOn)
      body.tool_choice = { type: "any" };
  }
  const requested = request.modelOptions.maxTokens ?? request.modelOptions.max_tokens;
  if (typeof requested === "number" && Number.isInteger(requested) && requested > 0)
    body.max_tokens = Math.min(requested, model.maxOutputTokens);
  if (model.thinking) {
    if (model.thinking.type === "adaptive") {
      body.thinking = { type: "adaptive", display: model.thinking.display ?? "summarized" };
    } else if (model.thinking.type === "enabled") {
      const budget = model.thinking.budgetTokens ?? 4096;
      body.thinking = { type: "enabled", budget_tokens: budget };
      if (body.max_tokens <= budget)
        body.max_tokens = Math.min(budget + 1024, Math.max(model.maxOutputTokens, budget + 1024));
    } else {
      body.thinking = { type: "disabled" };
    }
    if (model.thinking.effort)
      body.output_config = { effort: model.thinking.effort };
  }
  if (model.temperature !== undefined && (!model.thinking || model.thinking.type === "disabled"))
    body.temperature = model.temperature;
  if (model.cache.enabled)
    applyCacheBreakpoints(body, model.cache.ttl);
  else
    stripCacheControl(body);
  return body;
}
function usageFrom(raw, into) {
  if (typeof raw !== "object" || raw === null)
    return;
  const usage2 = raw;
  if (typeof usage2.input_tokens === "number")
    into.inputTokens = usage2.input_tokens;
  if (typeof usage2.output_tokens === "number")
    into.outputTokens = usage2.output_tokens;
  if (typeof usage2.cache_read_input_tokens === "number")
    into.cacheReadTokens = usage2.cache_read_input_tokens;
  if (typeof usage2.cache_creation_input_tokens === "number")
    into.cacheWriteTokens = usage2.cache_creation_input_tokens;
}
async function* anthropicStream(events) {
  const blocks = new Map;
  const usage2 = emptyUsage();
  let stopReason;
  let stopDetails;
  let finished = false;
  for await (const { data } of events) {
    const trimmed = data.trim();
    if (!trimmed)
      continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      throw new Error(`Anthropic sent a malformed stream event: ${trimmed.slice(0, 200)}`);
    }
    switch (event.type) {
      case "message_start":
        usageFrom(event.message?.usage, usage2);
        break;
      case "content_block_start": {
        const index = event.index;
        const block = event.content_block;
        if (block.type === "text") {
          blocks.set(index, { kind: "text" });
          if (typeof block.text === "string" && block.text)
            yield { type: "text", value: block.text };
        } else if (block.type === "thinking")
          blocks.set(index, { kind: "thinking", thinking: typeof block.thinking === "string" ? block.thinking : "", signature: "" });
        else if (block.type === "redacted_thinking") {
          blocks.set(index, { kind: "redacted" });
          yield { type: "thinking", value: "", metadata: { redactedData: block.data } };
        } else if (block.type === "tool_use")
          blocks.set(index, { kind: "tool_use", id: String(block.id), name: String(block.name), json: "" });
        break;
      }
      case "content_block_delta": {
        const pending = blocks.get(event.index);
        const delta = event.delta;
        if (!pending)
          break;
        if (delta.type === "text_delta" && pending.kind === "text") {
          if (typeof delta.text === "string" && delta.text)
            yield { type: "text", value: delta.text };
        } else if (delta.type === "thinking_delta" && pending.kind === "thinking") {
          const text2 = typeof delta.thinking === "string" ? delta.thinking : "";
          pending.thinking += text2;
          if (text2)
            yield { type: "thinking", value: text2 };
        } else if (delta.type === "signature_delta" && pending.kind === "thinking")
          pending.signature += typeof delta.signature === "string" ? delta.signature : "";
        else if (delta.type === "input_json_delta" && pending.kind === "tool_use")
          pending.json += typeof delta.partial_json === "string" ? delta.partial_json : "";
        break;
      }
      case "content_block_stop": {
        const index = event.index;
        const pending = blocks.get(index);
        blocks.delete(index);
        if (!pending)
          break;
        if (pending.kind === "tool_use") {
          let input = {};
          if (pending.json.trim()) {
            try {
              input = JSON.parse(pending.json);
            } catch {
              throw new Error(`The model returned invalid JSON for tool call ${pending.name}.`);
            }
          }
          yield { type: "tool_call", callId: pending.id, name: pending.name, input };
        } else if (pending.kind === "thinking" && pending.signature) {
          yield { type: "thinking", value: "", metadata: { signature: pending.signature, _completeThinking: pending.thinking } };
        }
        break;
      }
      case "message_delta":
        usageFrom(event.usage, usage2);
        {
          const delta = event.delta;
          if (typeof delta?.stop_reason === "string")
            stopReason = delta.stop_reason;
          if (delta?.stop_details)
            stopDetails = delta.stop_details;
        }
        break;
      case "message_stop":
        finished = true;
        break;
      case "error": {
        const error = event.error;
        throw new Error(`Anthropic stream error (${String(error?.type ?? "unknown")}): ${String(error?.message ?? "")}`);
      }
      default:
        break;
    }
    if (finished)
      break;
  }
  if (!finished && stopReason === undefined)
    throw new Error("The model stream ended before a message was completed.");
  yield { type: "usage", usage: usage2 };
  yield { type: "stop", reason: stopReason, details: stopDetails };
}

// extensions/ezil-models/src/endpoints.ts
var ANTHROPIC_VERSION = "2023-06-01";
function apiKindOf(provider) {
  return provider.type === "anthropic" || provider.type === "anthropic-foundry" ? "anthropic" : "openai";
}
function resolveEndpoint(provider, extraBetas = []) {
  const headers = { "content-type": "application/json", accept: "text/event-stream" };
  let url;
  if (provider.type === "ezil-gateway") {
    return { api: "anthropic", url: `${provider.baseUrl}/messages`, headers: { ...headers, authorization: `Bearer ${provider.apiKey ?? ""}` } };
  }
  switch (provider.type) {
    case "anthropic": {
      url = `${provider.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
      headers["x-api-key"] = provider.apiKey ?? "";
      headers["anthropic-version"] = ANTHROPIC_VERSION;
      break;
    }
    case "anthropic-foundry": {
      url = `${provider.baseUrl ?? `https://${provider.resource}.services.ai.azure.com/anthropic`}/v1/messages`;
      headers["x-api-key"] = provider.apiKey ?? "";
      headers["anthropic-version"] = ANTHROPIC_VERSION;
      break;
    }
    case "openai": {
      url = `${provider.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`;
      headers.authorization = `Bearer ${provider.apiKey ?? ""}`;
      break;
    }
    case "azure-openai": {
      url = `${provider.baseUrl ?? `https://${provider.resource}.openai.azure.com/openai/v1`}/chat/completions`;
      if (provider.apiVersion)
        url += `?api-version=${encodeURIComponent(provider.apiVersion)}`;
      headers["api-key"] = provider.apiKey ?? "";
      break;
    }
    case "openai-compatible": {
      url = `${provider.baseUrl}/chat/completions`;
      if (provider.apiKey)
        headers.authorization = `Bearer ${provider.apiKey}`;
      break;
    }
  }
  const betas = [...new Set([...provider.betas, ...extraBetas])];
  if (apiKindOf(provider) === "anthropic" && betas.length)
    headers["anthropic-beta"] = betas.join(",");
  for (const [name, value] of Object.entries(provider.headers))
    headers[name] = value;
  return { api: apiKindOf(provider), url, headers };
}
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// extensions/ezil-models/src/openai.ts
function userContent(parts) {
  const out = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.value !== "")
        out.push({ type: "text", text: part.value });
    } else if (part.type === "data" && !isCacheMarker(part) && !isStatefulMarker(part)) {
      if (IMAGE_MIME_TYPES.has(part.mimeType))
        out.push({ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${base64(part.data)}` } });
      else if (part.mimeType.startsWith("text/"))
        out.push({ type: "text", text: Buffer.from(part.data).toString("utf8") });
    }
  }
  return out;
}
function collapse(parts) {
  return parts.every((part) => part.type === "text") ? parts.map((part) => part.text).join("") : parts;
}
function convertMessages2(messages) {
  const out = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text2 = message.parts.filter((part) => part.type === "text").map((part) => part.value).join("");
      if (text2)
        out.push({ role: "system", content: text2 });
    } else if (message.role === "assistant") {
      let text2 = "";
      const toolCalls = [];
      for (const part of message.parts) {
        if (part.type === "text")
          text2 += part.value;
        else if (part.type === "tool_call")
          toolCalls.push({ id: part.callId, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } });
      }
      if (!text2 && !toolCalls.length)
        continue;
      const entry = { role: "assistant", content: text2 || null };
      if (toolCalls.length)
        entry.tool_calls = toolCalls;
      out.push(entry);
    } else {
      const rest = [];
      for (const part of message.parts) {
        if (part.type === "tool_result") {
          const text2 = part.content.map((inner) => inner.type === "text" ? inner.value : inner.type === "data" && inner.mimeType.startsWith("text/") ? Buffer.from(inner.data).toString("utf8") : inner.type === "data" && IMAGE_MIME_TYPES.has(inner.mimeType) ? "[image attached to tool result omitted]" : "").join("");
          out.push({ role: "tool", tool_call_id: part.callId, content: text2 });
        } else
          rest.push(part);
      }
      const content = userContent(rest);
      if (content.length)
        out.push({ role: "user", content: collapse(content) });
    }
  }
  return out;
}
var EFFORT_TO_OPENAI = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };
function buildOpenAIBody(model, request) {
  const body = {
    model: model.model,
    messages: convertMessages2(request.messages),
    stream: true
  };
  if (model.provider.includeUsage)
    body.stream_options = { include_usage: true };
  const field = model.provider.maxTokensField ?? (model.provider.type === "openai-compatible" ? "max_tokens" : "max_completion_tokens");
  let maxTokens = model.maxOutputTokens;
  const requested = request.modelOptions.maxTokens ?? request.modelOptions.max_tokens;
  if (typeof requested === "number" && Number.isInteger(requested) && requested > 0)
    maxTokens = Math.min(requested, model.maxOutputTokens);
  body[field] = maxTokens;
  if (request.tools.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema ?? { type: "object", properties: {} } }
    }));
    body.tool_choice = request.toolMode === "required" ? "required" : "auto";
  }
  if (model.thinking && model.thinking.type !== "disabled" && model.thinking.effort && model.provider.type !== "openai-compatible")
    body.reasoning_effort = EFFORT_TO_OPENAI[model.thinking.effort];
  if (model.temperature !== undefined && !body.reasoning_effort)
    body.temperature = model.temperature;
  return body;
}
function usageFrom2(raw, into) {
  if (typeof raw !== "object" || raw === null)
    return;
  const usage2 = raw;
  if (typeof usage2.prompt_tokens === "number")
    into.inputTokens = usage2.prompt_tokens;
  if (typeof usage2.completion_tokens === "number")
    into.outputTokens = usage2.completion_tokens;
  const details = usage2.prompt_tokens_details;
  if (typeof details?.cached_tokens === "number")
    into.cacheReadTokens = details.cached_tokens;
}
async function* openaiStream(events) {
  const calls = new Map;
  const usage2 = emptyUsage();
  let finishReason;
  let sawChunk = false;
  const flushCalls = function* () {
    for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let input = {};
      if (call.arguments.trim()) {
        try {
          input = JSON.parse(call.arguments);
        } catch {
          throw new Error(`The model returned invalid JSON for tool call ${call.name}.`);
        }
      }
      yield { type: "tool_call", callId: call.id || `call_${index}_${Date.now()}`, name: call.name, input };
    }
    calls.clear();
  };
  const indexFor = (id) => {
    if (typeof id === "string" && id) {
      for (const [index, call] of calls)
        if (call.id === id)
          return index;
      return calls.size;
    }
    return calls.size ? Math.max(...calls.keys()) : 0;
  };
  for await (const { data } of events) {
    const trimmed = data.trim();
    if (!trimmed)
      continue;
    if (trimmed === "[DONE]")
      break;
    let chunk;
    try {
      chunk = JSON.parse(trimmed);
    } catch {
      throw new Error(`Provider sent a malformed stream event: ${trimmed.slice(0, 200)}`);
    }
    if (chunk.error) {
      const error = chunk.error;
      throw new Error(`Provider stream error: ${String(error.message ?? JSON.stringify(error))}`);
    }
    sawChunk = true;
    if (chunk.usage)
      usageFrom2(chunk.usage, usage2);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content)
        yield { type: "text", value: delta.content };
      const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
      if (reasoning)
        yield { type: "thinking", value: reasoning };
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls) {
          const fn = raw.function ?? {};
          const index = typeof raw.index === "number" ? raw.index : indexFor(raw.id);
          const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
          if (typeof raw.id === "string" && raw.id)
            call.id = raw.id;
          if (typeof fn.name === "string" && fn.name)
            call.name += fn.name;
          if (typeof fn.arguments === "string")
            call.arguments += fn.arguments;
          calls.set(index, call);
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        finishReason = choice.finish_reason;
        yield* flushCalls();
      }
    }
  }
  if (!sawChunk)
    throw new Error("The model stream ended before any response was received.");
  yield* flushCalls();
  yield { type: "usage", usage: usage2 };
  yield { type: "stop", reason: finishReason };
}

// extensions/ezil-models/src/client.ts
class ProviderError extends Error {
  status;
  retryAfterSeconds;
  upstream;
  constructor(message, status, retryAfterSeconds, upstream) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.upstream = upstream;
    this.name = "ProviderError";
  }
}
function upstreamMessage(text2) {
  if (!text2)
    return;
  try {
    const parsed = JSON.parse(text2);
    const error = parsed.error ?? parsed;
    if (typeof error.message === "string")
      return error.type && typeof error.type === "string" ? `${error.type}: ${error.message}` : error.message;
    if (typeof error.code === "string")
      return error.code;
  } catch {}
  return text2.length > 400 ? `${text2.slice(0, 400)}...` : text2;
}
function describeHttpError(model, endpoint, status, retryAfter, bodyText) {
  const host = hostOf(endpoint.url);
  const upstream = upstreamMessage(bodyText);
  const where = `${model.providerName} (${host})`;
  const suffix = upstream ? ` Upstream said: ${upstream}` : "";
  const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
  switch (status) {
    case 401:
      return new ProviderError(`EZiL Models: ${where} rejected the API key (401). Check providers.${model.providerName}.apiKey in the models config.${suffix}`, status, undefined, upstream);
    case 402:
      return new ProviderError(`EZiL Models: ${where} reports a billing problem (402).${suffix}`, status, undefined, upstream);
    case 403:
      return new ProviderError(`EZiL Models: ${where} denied access (403). The key is valid but may not be allowed to use model "${model.model}".${suffix}`, status, undefined, upstream);
    case 404:
      return new ProviderError(`EZiL Models: ${where} has no model or deployment named "${model.model}" (404). Check models[].model and the endpoint URL.${suffix}`, status, undefined, upstream);
    case 408:
    case 409:
      return new ProviderError(`EZiL Models: ${where} timed out or conflicted (${status}); try again.${suffix}`, status, retryAfterSeconds, upstream);
    case 413:
      return new ProviderError(`EZiL Models: the request is too large for ${where} (413). Lower maxInputTokens for "${model.id}".${suffix}`, status, undefined, upstream);
    case 429:
      return new ProviderError(`EZiL Models: ${where} is rate limiting (429)${retryAfterSeconds !== undefined ? `; retry after ${retryAfterSeconds}s` : ""}.${suffix}`, status, retryAfterSeconds, upstream);
    case 529:
    case 503:
      return new ProviderError(`EZiL Models: ${where} is overloaded (${status}); try again in a moment.${suffix}`, status, retryAfterSeconds, upstream);
    default:
      if (status >= 500)
        return new ProviderError(`EZiL Models: ${where} failed with HTTP ${status}.${suffix}`, status, retryAfterSeconds, upstream);
      return new ProviderError(`EZiL Models: ${where} rejected the request (HTTP ${status}).${suffix}`, status, undefined, upstream);
  }
}
function buildBody(model, request) {
  if (model.provider.type === "ezil-gateway")
    return { endpoint: resolveEndpoint(model.provider), body: buildGatewayBody(model, request).body };
  const endpoint = resolveEndpoint(model.provider, model.thinking?.display === "updates" ? ["thinking-display-updates-2026-08-18"] : []);
  const body = endpoint.api === "anthropic" ? buildAnthropicBody(model, request) : buildOpenAIBody(model, request);
  return { endpoint, body };
}
async function* chat(model, request, options) {
  if (model.provider.type === "ezil-gateway") {
    yield* gatewayChat(model, request, { signal: options.signal, fetch: options.fetch, log: options.log, ...options.gateway });
    return;
  }
  const { endpoint, body } = buildBody(model, request);
  options.onRequest?.(endpoint.url, body);
  const doFetch = options.fetch ?? fetch;
  let response;
  try {
    response = await doFetch(endpoint.url, { method: "POST", headers: endpoint.headers, body: JSON.stringify(body), signal: options.signal, redirect: "error" });
  } catch (error) {
    if (options.signal.aborted)
      throw error;
    const cause = error.cause;
    const detail = cause?.code ?? cause?.message ?? error.message;
    throw new ProviderError(`EZiL Models: cannot reach ${model.providerName} at ${hostOf(endpoint.url)} (${detail}).`);
  }
  if (!response.ok) {
    const text2 = await response.text().catch(() => "");
    throw describeHttpError(model, endpoint, response.status, response.headers.get("retry-after"), text2);
  }
  if (!response.body)
    throw new ProviderError(`EZiL Models: ${model.providerName} returned an empty response body.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const text2 = await response.text().catch(() => "");
    const upstream = upstreamMessage(text2);
    throw new ProviderError(`EZiL Models: ${model.providerName} did not answer with an event stream (content-type ${contentType || "missing"}).${upstream ? ` Body: ${upstream}` : ""}`);
  }
  const stream = endpoint.api === "anthropic" ? anthropicStream(sseEvents(response.body)) : openaiStream(sseEvents(response.body));
  yield* stream;
}

// extensions/ezil-models/src/tokens.ts
var CHARS_PER_TOKEN = 3.4;
var IMAGE_TOKENS = 1600;
var MESSAGE_OVERHEAD = 4;
function estimateTextTokens(text2) {
  if (!text2)
    return 0;
  return Math.ceil(text2.length / CHARS_PER_TOKEN);
}
function estimatePartTokens(part) {
  switch (part.type) {
    case "text":
      return estimateTextTokens(part.value);
    case "thinking":
      return estimateTextTokens(part.value) + estimateTextTokens(String(part.metadata?._completeThinking ?? ""));
    case "tool_call":
      return estimateTextTokens(part.name) + estimateTextTokens(JSON.stringify(part.input ?? {})) + 8;
    case "tool_result":
      return part.content.reduce((sum, inner) => sum + estimatePartTokens(inner), 8);
    case "data":
      if (part.mimeType.startsWith("image/"))
        return IMAGE_TOKENS;
      if (part.mimeType.startsWith("text/"))
        return estimateTextTokens(Buffer.from(part.data).toString("utf8"));
      if (part.mimeType === "application/pdf")
        return Math.ceil(part.data.byteLength / 3);
      return 0;
  }
}
function estimateMessageTokens(message) {
  return message.parts.reduce((sum, part) => sum + estimatePartTokens(part), MESSAGE_OVERHEAD);
}

// extensions/ezil-models/src/provider.ts
var SYSTEM_ROLE = 3;
function thinkingCtor() {
  return vscode2.LanguageModelThinkingPart;
}
function isInstance(part, ctor) {
  return typeof ctor === "function" && part instanceof ctor;
}
function toNeutralPart(part) {
  if (typeof part !== "object" || part === null)
    return;
  const record2 = part;
  const name = record2.constructor?.name;
  if (isInstance(part, vscode2.LanguageModelToolCallPart) || typeof record2.callId === "string" && typeof record2.name === "string" && "input" in record2) {
    return { type: "tool_call", callId: record2.callId, name: record2.name, input: record2.input };
  }
  if (isInstance(part, vscode2.LanguageModelToolResultPart) || typeof record2.callId === "string" && Array.isArray(record2.content)) {
    const content = record2.content.map(toNeutralPart).filter((inner) => !!inner);
    return { type: "tool_result", callId: record2.callId, content, isError: record2.isError === true };
  }
  if (isInstance(part, vscode2.LanguageModelDataPart) || typeof record2.mimeType === "string" && record2.data instanceof Uint8Array) {
    return { type: "data", mimeType: record2.mimeType, data: record2.data };
  }
  if (record2.type === "thinking" || record2.type === "redacted_thinking" || isInstance(part, thinkingCtor()) || name === "LanguageModelThinkingPart" && "value" in record2) {
    const value = Array.isArray(record2.value) ? record2.value.join("") : String(record2.value ?? "");
    return { type: "thinking", value, id: typeof record2.id === "string" ? record2.id : undefined, metadata: record2.metadata };
  }
  if (isInstance(part, vscode2.LanguageModelTextPart) || typeof record2.value === "string") {
    return { type: "text", value: record2.value };
  }
  return;
}
function toNeutralRole(role) {
  if (role === vscode2.LanguageModelChatMessageRole.Assistant)
    return "assistant";
  if (role === SYSTEM_ROLE)
    return "system";
  return "user";
}
function toNeutralMessage(message) {
  const parts = message.content.map(toNeutralPart).filter((part) => !!part);
  const out = { role: toNeutralRole(message.role), parts };
  if (message.name)
    out.name = message.name;
  return out;
}
function toNeutralRequest(messages, options) {
  const tools = (options.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  return {
    messages: messages.map(toNeutralMessage),
    tools,
    toolMode: options.toolMode === vscode2.LanguageModelChatToolMode.Required ? "required" : "auto",
    modelOptions: options.modelOptions ?? {}
  };
}
function toInformation(model) {
  const info = {
    id: model.id,
    name: model.name,
    family: model.family,
    version: model.version,
    tooltip: model.tooltip ?? `${model.providerName} / ${model.model}`,
    detail: model.detail ?? model.providerName,
    maxInputTokens: model.provider.type === "ezil-gateway" ? gatewayInputTokens(model) : model.maxInputTokens,
    maxOutputTokens: model.provider.type === "ezil-gateway" ? gatewayOutputTokens(model) : model.maxOutputTokens,
    capabilities: { toolCalling: model.capabilities.toolCalling, imageInput: model.provider.type === "ezil-gateway" ? false : model.capabilities.imageInput }
  };
  info.isDefault = model.default;
  info.isUserSelectable = true;
  return info;
}
var LONG_BASE64 = /"data":\s*"([A-Za-z0-9+/=]{200,})"/g;
var LONG_DATA_URL = /"url":\s*"data:([^;"]+);base64,[A-Za-z0-9+/=]{200,}"/g;
function requestForLog(body, secrets) {
  const text2 = JSON.stringify(body, null, 1).replace(LONG_BASE64, (_match, data) => `"data": "<${data.length} base64 chars>"`).replace(LONG_DATA_URL, (_match, mime) => `"url": "data:${mime};base64,<omitted>"`);
  return redact(text2, secrets);
}
function isUtilityRequest(options) {
  return ["role", "requestInitiator"].some((key) => typeof options[key] === "string" && /(?:^|[./_-])(utility(?:Small)?|title|summary|summariz(?:e|ation)|progress)(?:$|[./_-])/i.test(options[key]));
}

class EZiLModelsProvider {
  host;
  changed = new vscode2.EventEmitter;
  onDidChangeLanguageModelChatInformation = this.changed.event;
  constructor(host) {
    this.host = host;
  }
  refresh() {
    this.changed.fire();
  }
  dispose() {
    this.changed.dispose();
  }
  async provideLanguageModelChatInformation(_options, token) {
    if (token.isCancellationRequested)
      return [];
    const controller = new AbortController;
    const cancel = token.onCancellationRequested(() => controller.abort());
    try {
      const models = this.host.models();
      const providers = [...new Set(models.filter((model) => model.provider.type === "ezil-gateway").map((model) => model.provider))];
      const catalog = new Map(await Promise.all(providers.map(async (provider) => [provider, await gatewayModels(provider, this.host.fetch ?? fetch, Date.now(), controller.signal)])));
      if (token.isCancellationRequested)
        return [];
      return models.filter((model) => catalog.get(model.provider)?.data.find((entry) => entry.id === model.model)?.enabled !== false).map((model) => toInformation(withGatewayModelLimits(model, catalog.get(model.provider))));
    } finally {
      cancel.dispose();
    }
  }
  resolve(model) {
    const found = this.host.models().find((candidate) => candidate.id === model.id);
    if (found)
      return found;
    const error = this.host.configError();
    throw new ProviderError(error ? `EZiL Models: the config could not be loaded. ${error}` : `EZiL Models: model "${model.id}" is no longer in the config file. Pick another model.`);
  }
  async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    let resolved = this.resolve(model);
    if (resolved.provider.type === "ezil-gateway" && isUtilityRequest(options.modelOptions ?? {})) {
      resolved = this.host.models().find((candidate) => candidate.provider.type === "ezil-gateway" && candidate.model === QWEN) ?? resolved;
    }
    const request = toNeutralRequest(messages, options);
    const controller = new AbortController;
    const cancellation = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested)
      controller.abort();
    const started = Date.now();
    const Thinking = thinkingCtor();
    let emittedText = false;
    try {
      controller.signal.throwIfAborted();
      if (resolved.provider.type === "ezil-gateway") {
        const catalog = await gatewayModels(resolved.provider, this.host.fetch ?? fetch, Date.now(), controller.signal);
        resolved = withGatewayModelLimits(resolved, catalog);
        controller.signal.throwIfAborted();
      }
      const events = chat(resolved, request, {
        signal: controller.signal,
        fetch: this.host.fetch,
        log: (line) => this.host.log(redact(line, this.host.secrets())),
        onRequest: (url, body) => {
          if (resolved.provider.type === "ezil-gateway")
            return;
          this.host.log(`[request] ${resolved.id} -> ${redact(url, this.host.secrets())} messages=${request.messages.length} tools=${request.tools.length} toolMode=${request.toolMode}${options.modelOptions?.requestInitiator ? ` initiator=${String(options.modelOptions.requestInitiator)}` : ""}`);
          if (this.host.logRequests())
            this.host.log(requestForLog(body, this.host.secrets()));
        }
      });
      for await (const event of events) {
        if (token.isCancellationRequested)
          break;
        switch (event.type) {
          case "text":
            emittedText = true;
            progress.report(new vscode2.LanguageModelTextPart(event.value));
            break;
          case "tool_call":
            progress.report(new vscode2.LanguageModelToolCallPart(event.callId, event.name, typeof event.input === "object" && event.input !== null ? event.input : {}));
            break;
          case "thinking":
            if (Thinking)
              progress.report(new Thinking(event.value, event.id, event.metadata));
            break;
          case "usage":
            this.host.recordUsage(resolved, event.usage, Date.now() - started);
            break;
          case "stop":
            if (event.reason === "refusal") {
              const details = event.details;
              const requestId = event.details?.requestId;
              const message = `The model declined this request${details?.category ? ` (${details.category})` : ""}.${details?.explanation ? ` ${details.explanation}` : ""}${requestId ? ` (request ${requestId})` : ""}`;
              if (emittedText)
                progress.report(new vscode2.LanguageModelTextPart(`

_${message}_`));
              else
                throw new ProviderError(`EZiL Models: ${message}`);
            } else if (event.reason === "max_tokens" || event.reason === "length") {
              if (resolved.provider.type === "ezil-gateway")
                break;
              this.host.log(`[warn] ${resolved.id}: output truncated at maxOutputTokens=${resolved.maxOutputTokens}`);
            }
            break;
        }
      }
    } catch (error) {
      if (controller.signal.aborted)
        return;
      const message = redact(error instanceof Error ? error.message : String(error), this.host.secrets());
      if (resolved.provider.type !== "ezil-gateway")
        this.host.log(`[error] ${resolved.id}: ${message}`);
      if (error instanceof GatewayError && ["first_byte_timeout", "stream_idle_timeout", "os_unreachable", "os_ai_unavailable", "upstream_timeout"].includes(error.code ?? "")) {
        Promise.resolve(vscode2.window.showErrorMessage(message, "Retry")).then((choice) => {
          if (choice === "Retry")
            return vscode2.commands.executeCommand("workbench.action.chat.retry");
        }).catch(() => {});
      }
      if (error instanceof ProviderError)
        throw new ProviderError(message, error.status, error.retryAfterSeconds, error.upstream && redact(error.upstream, this.host.secrets()));
      throw new Error(message.startsWith("EZiL Models") ? message : `EZiL Models: ${message}`);
    } finally {
      cancellation.dispose();
      this.host.requestFinished?.(resolved);
    }
  }
  async provideTokenCount(_model, value, _token) {
    if (this.resolve(_model).provider.type === "ezil-gateway")
      return gatewayTokenCount(typeof value === "string" ? value : toNeutralMessage(value));
    if (typeof value === "string")
      return estimateTextTokens(value);
    return estimateMessageTokens(toNeutralMessage(value));
  }
}

// extensions/ezil-models/src/extension.ts
var DEFAULT_CONFIG_PATH = "/etc/ezil/models.json";
var CONFIG_ENV = "EZIL_MODELS_CONFIG";
function resolveConfigPath(setting, env2 = process.env) {
  const fromEnv = env2[CONFIG_ENV]?.trim();
  if (fromEnv)
    return fromEnv;
  const fromSetting = setting?.trim();
  return fromSetting ? fromSetting : DEFAULT_CONFIG_PATH;
}

class ConfigStore {
  configPath;
  log;
  watchFs;
  current;
  lastText;
  lastError;
  watcher;
  debounce;
  poll;
  listeners = new Set;
  constructor(configPath, log, watchFs = fs.watch) {
    this.configPath = configPath;
    this.log = log;
    this.watchFs = watchFs;
  }
  get path() {
    return this.configPath;
  }
  models() {
    return this.current?.models ?? [];
  }
  secrets() {
    return this.current?.secrets ?? [];
  }
  error() {
    return this.lastError;
  }
  problems() {
    return this.current ? [...this.current.warnings, ...this.current.errors] : [];
  }
  onChange(listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  setPath(configPath) {
    if (configPath === this.configPath)
      return;
    this.configPath = configPath;
    this.current = undefined;
    this.lastText = undefined;
    this.watch();
    this.load();
  }
  load(ifChanged = false) {
    try {
      const text2 = fs.readFileSync(this.configPath, "utf8");
      if (ifChanged && text2 === this.lastText)
        return !this.lastError;
      this.lastText = text2;
      this.current = parseModelsConfig(text2, { source: this.configPath });
      this.lastError = undefined;
      this.log(`[config] loaded ${this.configPath}: ${this.current.models.length} model(s)${this.problems().length ? `, ${this.problems().length} entr${this.problems().length === 1 ? "y" : "ies"} not served (see below)` : ""}
${describeConfig(this.current)}`);
      if (!this.watcher && !this.poll)
        this.watch();
    } catch (error) {
      if (!(error instanceof ConfigError))
        this.lastText = undefined;
      this.lastError = error instanceof ConfigError ? error.message : error.code === "ENOENT" ? `${this.configPath} does not exist.` : `${this.configPath}: ${error.message}`;
      this.log(`[config] ${this.lastError}${this.current ? ` (keeping the ${this.current.models.length} model(s) loaded before)` : ""}`);
    }
    for (const listener of this.listeners)
      listener();
    return !this.lastError;
  }
  watch() {
    clearInterval(this.poll);
    this.poll = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    const directory = path.dirname(this.configPath);
    try {
      this.watcher = this.watchFs(directory, { persistent: false }, () => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.load(true), 250);
      });
      this.watcher.on("error", (error) => this.log(`[config] watcher error: ${error.message}`));
    } catch (error) {
      this.log(`[config] cannot watch ${directory}: ${error.message}`);
      if (["EMFILE", "ENOSPC", "EPERM"].includes(error.code ?? "")) {
        this.poll = setInterval(() => this.load(true), 1000);
        this.poll.unref();
      }
    }
  }
  dispose() {
    clearTimeout(this.debounce);
    clearInterval(this.poll);
    this.watcher?.close();
    this.listeners.clear();
  }
}

class UsageTracker {
  perModel = new Map;
  record(model, usage2, elapsedMs) {
    const record2 = this.perModel.get(model.id) ?? { requests: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    record2.requests += 1;
    record2.elapsedMs += elapsedMs;
    record2.inputTokens += usage2.inputTokens;
    record2.outputTokens += usage2.outputTokens;
    record2.cacheReadTokens += usage2.cacheReadTokens;
    record2.cacheWriteTokens += usage2.cacheWriteTokens;
    this.perModel.set(model.id, record2);
    return record2;
  }
  report() {
    if (!this.perModel.size)
      return "No requests yet.";
    const lines = ["model            requests   input   output  cache_read  cache_write   avg_ms"];
    for (const [id, record2] of this.perModel) {
      lines.push(`${id.padEnd(16)} ${String(record2.requests).padStart(8)} ${String(record2.inputTokens).padStart(7)} ${String(record2.outputTokens).padStart(8)} ${String(record2.cacheReadTokens).padStart(11)} ${String(record2.cacheWriteTokens).padStart(12)} ${String(Math.round(record2.elapsedMs / record2.requests)).padStart(8)}`);
    }
    return lines.join(`
`);
  }
}
var CONFIG_TEMPLATE = {
  providers: {
    ezil: {
      type: "ezil-gateway",
      baseUrl: "{env:EZIL_AI_BASE_URL}",
      apiKey: "{env:EZIL_AI_PROXY_TOKEN}"
    }
  },
  models: [
    {
      id: "qwen.qwen3-coder-next",
      model: "qwen.qwen3-coder-next",
      name: "Qwen3 Coder Next",
      provider: "ezil",
      family: "qwen",
      default: true,
      roles: [
        "default",
        "plan",
        "utility",
        "utilitySmall"
      ],
      stream: true,
      maxInputTokens: 131072,
      maxOutputTokens: 8192,
      capabilities: {
        toolCalling: true,
        imageInput: false
      }
    },
    {
      id: "us.moonshotai.kimi-k3",
      model: "us.moonshotai.kimi-k3",
      name: "Kimi K3 (no streaming)",
      provider: "ezil",
      family: "kimi",
      stream: false,
      maxInputTokens: 131072,
      maxOutputTokens: 4096,
      capabilities: {
        toolCalling: true,
        imageInput: false
      }
    }
  ]
};
function settingsSnippet(models) {
  const byRole = (role) => models.find((model) => model.roles.includes(role));
  const snippet = { "chat.allowAnonymousAccess": true, "chat.byokUtilityModelDefault": "mainAgent" };
  const main = byRole("default") ?? models.find((model) => model.default);
  if (main)
    snippet["chat.defaultModel"] = main.id;
  const plan = byRole("plan");
  if (plan)
    snippet["chat.planAgent.defaultModel"] = plan.id;
  const utility = byRole("utility");
  if (utility)
    snippet["chat.utilityModel"] = `ezil/${utility.id}`;
  const small = byRole("utilitySmall");
  if (small)
    snippet["chat.utilitySmallModel"] = `ezil/${small.id}`;
  return snippet;
}
async function activate(context) {
  const output = vscode3.window.createOutputChannel("EZiL Models");
  const log = (line) => output.appendLine(line.startsWith("{") ? line : `${new Date().toISOString()} ${line}`);
  const settings = () => vscode3.workspace.getConfiguration("ezilModels");
  const store = new ConfigStore(resolveConfigPath(settings().get("configPath")), log);
  const usage2 = new UsageTracker;
  const aiStatus = new EZiLAIStatus(() => store.models().find((model) => model.provider.type === "ezil-gateway")?.provider);
  const provider = new EZiLModelsProvider({
    models: () => store.models(),
    configError: () => store.error(),
    secrets: () => store.secrets(),
    logRequests: () => settings().get("logRequests") === true,
    log,
    recordUsage: (model, used, elapsedMs) => {
      usage2.record(model, used, elapsedMs);
      if (model.provider.type !== "ezil-gateway")
        log(`[usage] ${model.id} input=${used.inputTokens} output=${used.outputTokens} cache_read=${used.cacheReadTokens} cache_write=${used.cacheWriteTokens} ${elapsedMs}ms`);
    },
    requestFinished: (model) => {
      if (model.provider.type === "ezil-gateway")
        aiStatus.refresh();
    }
  });
  context.subscriptions.push(output, store, provider, aiStatus);
  context.subscriptions.push(store.onChange(() => {
    provider.refresh();
    aiStatus.refresh();
  }));
  store.watch();
  store.load();
  context.subscriptions.push(vscode3.lm.registerLanguageModelChatProvider("ezil", provider));
  provider.refresh();
  context.subscriptions.push(vscode3.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("ezilModels.configPath"))
      store.setPath(resolveConfigPath(settings().get("configPath")));
  }));
  const openConfig = async () => {
    if (!fs.existsSync(store.path)) {
      const create = await vscode3.window.showWarningMessage(`EZiL Models: ${store.path} does not exist.`, "Create from template", "Show output");
      if (create === "Show output") {
        output.show();
        return;
      }
      if (create !== "Create from template")
        return;
      try {
        fs.mkdirSync(path.dirname(store.path), { recursive: true });
        fs.writeFileSync(store.path, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}
`, { mode: 384, flag: "wx" });
      } catch (error) {
        vscode3.window.showErrorMessage(`EZiL Models: cannot create ${store.path} (${error.message}). Set ezilModels.configPath or ${CONFIG_ENV} to a writable location.`);
        return;
      }
    }
    const document = await vscode3.workspace.openTextDocument(vscode3.Uri.file(store.path));
    await vscode3.window.showTextDocument(document);
  };
  const reload = () => {
    forgetGatewayModels();
    const ok = store.load();
    const problems = store.problems().length;
    ok ? problems ? vscode3.window.showWarningMessage(`EZiL Models: loaded ${store.models().length} model(s) from ${store.path}; ${problems} entr${problems === 1 ? "y is" : "ies are"} not served.`, "Show output").then((choice) => {
      if (choice)
        output.show();
    }) : vscode3.window.showInformationMessage(`EZiL Models: loaded ${store.models().length} model(s) from ${store.path}.`) : vscode3.window.showErrorMessage(`EZiL Models: ${store.error()}`, "Show output").then((choice) => {
      if (choice)
        output.show();
    });
  };
  const showCredits = () => aiStatus.show();
  const showUsage = () => {
    log(`[usage report]
${usage2.report()}`);
    output.show();
  };
  const manage = async () => {
    const items = [
      { label: "$(go-to-file) Open config file", description: store.path, action: openConfig },
      { label: "$(refresh) Reload config", description: store.error() ? "last load failed" : `${store.models().length} model(s)`, action: reload },
      { label: "$(credit-card) Show AI credits", action: showCredits },
      { label: "$(graph) Show token usage", action: showUsage },
      { label: "$(clippy) Copy settings snippet", description: "chat.defaultModel / plan / utility for the configured roles", action: async () => {
        await vscode3.env.clipboard.writeText(JSON.stringify(settingsSnippet(store.models()), null, 2));
        vscode3.window.showInformationMessage("EZiL Models: settings snippet copied to the clipboard.");
      } }
    ];
    if (store.error())
      items.push({ label: "$(error) Config error", detail: store.error(), action: () => output.show() });
    for (const problem of store.problems())
      items.push({ label: `$(warning) ${problem.startsWith("providers.") && problem.includes(" skipped ") ? "Provider skipped" : "Invalid entry"}`, detail: problem, action: () => output.show() });
    if (store.models().length)
      items.push({ label: "Models", kind: vscode3.QuickPickItemKind.Separator });
    for (const model of store.models()) {
      items.push({
        label: `${model.default ? "$(star-full) " : ""}${model.name}`,
        description: `${model.id} -> ${model.providerName}/${model.model}`,
        detail: `${model.provider.type} · in ${model.maxInputTokens} / out ${model.maxOutputTokens}${model.thinking ? ` · thinking ${model.thinking.type}${model.thinking.effort ? `/${model.thinking.effort}` : ""}` : ""}${model.cache.enabled ? ` · cache ${model.cache.ttl}` : ""}${model.roles.length ? ` · roles ${model.roles.join(", ")}` : ""}`,
        action: () => {
          vscode3.window.showInformationMessage(`EZiL Models: set "chat.defaultModel": "${model.id}" to make ${model.name} the default.`);
        }
      });
    }
    const picked = await vscode3.window.showQuickPick(items, { title: "EZiL Models", placeHolder: "Manage the EZiL model provider" });
    await picked?.action?.();
  };
  context.subscriptions.push(vscode3.commands.registerCommand("ezil-models.manage", manage), vscode3.commands.registerCommand("ezil-models.reload", reload), vscode3.commands.registerCommand("ezil-models.showCredits", showCredits), vscode3.commands.registerCommand("ezil-models.showStatus", showCredits), vscode3.commands.registerCommand("ezil-models.showUsage", showUsage), vscode3.commands.registerCommand("ezil-models.openConfig", openConfig));
  log(`[activate] config path ${store.path}${process.env[CONFIG_ENV] ? ` (from ${CONFIG_ENV})` : ""}; proposals: languageModelThinkingPart=${"LanguageModelThinkingPart" in vscode3} languageModelSystem=${vscode3.LanguageModelChatMessageRole.System === 3}`);
}
function deactivate() {}
