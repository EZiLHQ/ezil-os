var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
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

// extensions/ezil-models/src/status-data.ts
var exports_status_data = {};
__export(exports_status_data, {
  statusView: () => statusView,
  readAIStatus: () => readAIStatus,
  localResetTime: () => localResetTime,
  credits: () => credits,
  AI_NOTICE: () => AI_NOTICE
});
module.exports = __toCommonJS(exports_status_data);

// extensions/ezil-models/src/types.ts
var IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// extensions/ezil-models/src/gateway-response.ts
var STOP_REASONS = new Set(["end_turn", "tool_use", "max_tokens", "stop_sequence", "refusal"]);

// extensions/ezil-models/src/gateway.ts
var MODELS_TTL_MS = 5 * 60000;
var MICRO_PER_CREDIT = 1e6;
var modelsCache = new Map;
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
function creditState(models, balance, alias) {
  const pick = (state, credits) => ({ state, text: state === "ok" && credits !== undefined ? `AI credits: ${credits} remaining` : CREDIT_STATE_TEXT[state], ...credits === undefined ? {} : { credits } });
  if (models?.killswitch)
    return pick(models.pause === "reconciliation" ? "paused_reconciliation" : "paused_operations");
  if (models && models.data.find((entry) => entry.id === alias)?.enabled === false)
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
var admissionGates = new Map;

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
  const [balance, usage, limits, models] = await Promise.all([
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
  return { balance, usage, limits, models };
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
  let text = window ? `EZiL AI · ${credits(window.remaining_micro)} credits left${reset ? ` · resets ${reset}` : ""}` : balance ? `EZiL AI · ${credits(balance.available_micro)} credits` : "EZiL AI · Credits unavailable";
  const limits = state.limits.value;
  const global = creditState(state.models.value ? { ...state.models.value, data: [] } : undefined, undefined, "");
  const paused = global.state === "paused_reconciliation" || global.state === "paused_operations";
  const attention = [state.balance, state.limits, state.models, state.usage].filter((result) => result.code).map(statusProblem).find((problem) => problem.attention);
  if (attention)
    text = `EZiL AI · ${attention.label}`;
  else if (paused)
    text = global.state === "paused_reconciliation" ? "EZiL AI · Paused · reconciling usage" : "EZiL AI · Paused";
  else if (limits?.pauses.some((p) => p.scope === "user" || p.scope === "account" || p.scope === "role"))
    text = "EZiL AI · Paused";
  else if (limits?.entitlement.required && limits.entitlement.basis === null)
    text = "EZiL AI · AI access needed";
  else {
    if (window && BigInt(window.remaining_micro) === 0n)
      text += " · window used";
    else if (limits?.policy.policy.daily_budget_micro !== undefined && limits.counters.day_micro >= limits.policy.policy.daily_budget_micro)
      text = "EZiL AI · Daily credit budget used";
    else if (limits?.policy.policy.monthly_budget_micro !== undefined && limits.counters.month_micro >= limits.policy.policy.monthly_budget_micro)
      text = "EZiL AI · Monthly credit budget used";
    else if (balance?.available_micro === 0 && balance.held_micro > 0)
      text = "EZiL AI · Credits held";
    else if (balance?.available_micro === 0)
      text = "EZiL AI · 0 credits";
    if (!limits)
      text += " · limits unavailable";
    if (!state.models.value)
      text += " · availability unknown";
    if (!state.usage.value)
      text += " · usage unavailable";
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
  return { text, lines };
}
