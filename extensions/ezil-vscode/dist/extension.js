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

// src/extension.ts
var exports_extension = {};
__export(exports_extension, {
  deactivate: () => deactivate,
  activate: () => activate
});
module.exports = __toCommonJS(exports_extension);
var vscode2 = __toESM(require("vscode"));

// src/broker.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
function inside(root, path) {
  const rel = import_node_path.relative(root, path);
  return rel === "" || rel !== ".." && !rel.startsWith("../") && !import_node_path.isAbsolute(rel);
}
function noSymlinks(path) {
  for (let cursor = path;; cursor = import_node_path.dirname(cursor)) {
    if (import_node_fs.lstatSync(cursor).isSymbolicLink())
      throw new Error("broker_unavailable");
    if (import_node_path.dirname(cursor) === cursor)
      return;
  }
}
function loopbackOrigin(value) {
  return typeof value === "string" && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value) && new URL(value).origin === value;
}
function readBroker(path, folders, now = Date.now()) {
  if (!path || !import_node_path.isAbsolute(path))
    throw new Error("broker_unavailable");
  noSymlinks(path);
  const fd = import_node_fs.openSync(path, import_node_fs.constants.O_RDONLY | import_node_fs.constants.O_NOFOLLOW);
  try {
    const st = import_node_fs.fstatSync(fd);
    if (!st.isFile() || st.size > 4096 || (st.mode & 63) !== 0 || st.nlink !== 1 || process.getuid && st.uid !== process.getuid())
      throw new Error("broker_unavailable");
    if (folders.length !== 1 || !import_node_path.isAbsolute(folders[0]) || inside(folders[0], path))
      throw new Error("broker_unavailable");
    noSymlinks(folders[0]);
    if (!import_node_fs.lstatSync(folders[0]).isDirectory())
      throw new Error("broker_unavailable");
    const value = JSON.parse(import_node_fs.readFileSync(fd, "utf8"));
    if (!value || value.contractVersion !== 1)
      throw new Error("broker_unavailable");
    if ("url" in value) {
      if (Object.keys(value).some((key) => !["contractVersion", "url", "capability", "operations", "formats"].includes(key)) || !loopbackOrigin(value.url) || !/^[A-Za-z0-9_-]{43,128}$/.test(value.capability) || !Array.isArray(value.operations) || !value.operations.includes("models") || value.operations.some((op) => op !== "models" && op !== "chat") || !Array.isArray(value.formats) || value.formats.some((format) => format !== "text/event-stream" && format !== "application/vnd.amazon.eventstream"))
        throw new Error("broker_unavailable");
      return value;
    }
    if (!loopbackOrigin(value.origin) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.workspaceId) || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !Number.isFinite(value.expiresAt) || value.expiresAt <= now || !import_node_path.isAbsolute(value.dataRoot) || !import_node_path.isAbsolute(value.workspacePath))
      throw new Error("broker_unavailable");
    const dataRoot = import_node_path.resolve(value.dataRoot);
    const expected = import_node_path.resolve(value.workspacePath);
    const managed = [
      import_node_path.resolve(dataRoot, "workspaces", value.workspaceId, "files"),
      import_node_path.resolve(dataRoot, "native-v1", "workspaces", value.workspaceId, "files")
    ];
    if (!managed.includes(expected) || !inside(dataRoot, path) || inside(expected, path) || import_node_path.resolve(folders[0]) !== expected)
      throw new Error("broker_unavailable");
    noSymlinks(dataRoot);
    noSymlinks(expected);
    return value;
  } catch {
    throw new Error("broker_unavailable");
  } finally {
    import_node_fs.closeSync(fd);
  }
}
function parsePort(input) {
  if (!/^[0-9]{4,5}$/.test(input))
    return;
  const port = Number(input);
  return port >= 1024 && port <= 65535 ? port : undefined;
}
async function sendOperation(descriptor, operation) {
  const keys = Object.keys(operation).sort().join(",");
  const readiness = operation.op === "editor.readiness" && keys === "op,state" && (operation.state === "active" || operation.state === "unknown");
  const preview = (operation.op === "preview.register" || operation.op === "preview.unregister") && keys === "op,port" && Number.isInteger(operation.port) && Number(operation.port) >= 1024 && Number(operation.port) <= 65535;
  if (!readiness && !preview)
    throw new Error("broker_unavailable");
  const response = await fetch(`${descriptor.origin}/api/native/operations`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/json", origin: descriptor.origin, authorization: `Bearer ${descriptor.token}` },
    body: JSON.stringify({ ...operation, workspaceId: descriptor.workspaceId })
  });
  if (!response.ok)
    throw new Error("broker_unavailable");
  const value = await response.json();
  if (value.ok !== true)
    throw new Error("broker_unavailable");
}
async function readModels(descriptor) {
  if (!descriptor.operations.includes("models"))
    throw new Error("broker_unavailable");
  const response = await fetch(`${descriptor.url}/v1/models`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${descriptor.capability}` }
  });
  if (!response.ok)
    throw new Error("broker_unavailable");
  const value = await response.json();
  if (!Array.isArray(value.models) || value.models.length > 100 || value.models.some((model) => typeof model !== "string" || !/^[a-zA-Z0-9._:-]{1,200}$/.test(model)))
    throw new Error("broker_unavailable");
  return value.models;
}

// src/model-provider.ts
var vscode = __toESM(require("vscode"));
var OUTPUT_LIMIT = 8192;
function textContent(message) {
  const parts = [];
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart)
      parts.push(part.value);
    else
      throw new Error("EZiL BYOK currently accepts text messages only.");
  }
  return parts.join("");
}
function requestBody(model, messages, options) {
  if (options.tools?.length)
    throw new Error("This configured EZiL provider does not advertise tool calling.");
  const requested = options.modelOptions?.maxTokens;
  const maxTokens = Number.isInteger(requested) && requested > 0 ? Math.min(requested, OUTPUT_LIMIT) : Math.min(model.maxOutputTokens, 4096);
  return {
    model: model.id,
    messages: messages.map((message) => {
      if (message.role !== vscode.LanguageModelChatMessageRole.User && message.role !== vscode.LanguageModelChatMessageRole.Assistant)
        throw new Error("Unsupported chat role.");
      return { role: message.role === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant", content: textContent(message) };
    }),
    maxTokens
  };
}
function crc32(value) {
  let crc = 4294967295;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0;bit < 8; bit++)
      crc = crc >>> 1 ^ 3988292384 & -(crc & 1);
  }
  return (crc ^ 4294967295) >>> 0;
}
function bedrockEvent(frame) {
  if (frame.length < 16 || frame.readUInt32BE(0) !== frame.length)
    throw new Error("Invalid Bedrock event stream frame.");
  const headerBytes = frame.readUInt32BE(4);
  if (headerBytes > frame.length - 16 || frame.readUInt32BE(8) !== crc32(frame.subarray(0, 8)) || frame.readUInt32BE(frame.length - 4) !== crc32(frame.subarray(0, -4)))
    throw new Error("Invalid Bedrock event stream checksum.");
  let offset = 12;
  const end = offset + headerBytes;
  let type;
  while (offset < end) {
    const nameBytes = frame[offset++];
    if (!nameBytes || offset + nameBytes + 1 > end)
      throw new Error("Invalid Bedrock event stream headers.");
    const name = frame.subarray(offset, offset + nameBytes).toString("utf8");
    offset += nameBytes;
    const valueType = frame[offset++];
    if (valueType === undefined)
      throw new Error("Invalid Bedrock event stream headers.");
    if (valueType === 0 || valueType === 1)
      continue;
    const widths = { 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };
    if (valueType === 6 || valueType === 7) {
      if (offset + 2 > end)
        throw new Error("Invalid Bedrock event stream headers.");
      const length = frame.readUInt16BE(offset);
      offset += 2;
      if (offset + length > end)
        throw new Error("Invalid Bedrock event stream headers.");
      if (name === ":event-type" && valueType === 7)
        type = frame.subarray(offset, offset + length).toString("utf8");
      offset += length;
    } else {
      const width = widths[valueType];
      if (!width || offset + width > end)
        throw new Error("Invalid Bedrock event stream headers.");
      offset += width;
    }
  }
  if (offset !== end)
    throw new Error("Invalid Bedrock event stream headers.");
  const raw = frame.subarray(end, frame.length - 4).toString("utf8");
  return { type, payload: raw ? JSON.parse(raw) : {} };
}
async function consumeSSE(body, emit) {
  const reader = body.getReader();
  const decoder = new TextDecoder;
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer = (buffer + decoder.decode(value, { stream: !done })).replaceAll(`\r
`, `
`);
    let split;
    while ((split = buffer.indexOf(`

`)) >= 0) {
      const event = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of event.split(`
`)) {
        if (!line.startsWith("data:"))
          continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]")
          continue;
        const value2 = JSON.parse(data);
        const text = value2?.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text)
          emit(new vscode.LanguageModelTextPart(text));
      }
    }
    if (done)
      break;
  }
  if (buffer.trim() && buffer.trim() !== "data: [DONE]")
    throw new Error("Incomplete Azure response stream.");
}
async function consumeBedrock(body, emit) {
  const reader = body.getReader();
  let buffer = Buffer.alloc(0);
  while (true) {
    const { done, value } = await reader.read();
    if (value)
      buffer = Buffer.concat([buffer, Buffer.from(value)]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (length < 16 || length > 1024 * 1024)
        throw new Error("Invalid Bedrock event stream frame.");
      if (buffer.length < length)
        break;
      const event = bedrockEvent(buffer.subarray(0, length));
      buffer = buffer.subarray(length);
      if (event.type?.endsWith("Exception"))
        throw new Error("Bedrock response failed.");
      if (event.type === "contentBlockDelta") {
        const text = event.payload?.delta?.text;
        if (typeof text === "string" && text)
          emit(new vscode.LanguageModelTextPart(text));
      }
    }
    if (done)
      break;
  }
  if (buffer.length)
    throw new Error("Incomplete Bedrock response stream.");
}
async function streamChat(descriptor, body, emit, token) {
  const controller = new AbortController;
  const cancellation = token.onCancellationRequested(() => controller.abort());
  if (token.isCancellationRequested)
    controller.abort();
  try {
    const response = await fetch(`${descriptor.url}/v1/chat`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { authorization: `Bearer ${descriptor.capability}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok || !response.body)
      throw new Error("EZiL model broker is unavailable.");
    const type = response.headers.get("content-type")?.split(";", 1)[0];
    if (type === "text/event-stream")
      await consumeSSE(response.body, emit);
    else if (type === "application/vnd.amazon.eventstream")
      await consumeBedrock(response.body, emit);
    else
      throw new Error("Unsupported provider response format.");
  } finally {
    cancellation.dispose();
  }
}

class EZiLModelProvider {
  descriptorPath;
  folders;
  constructor(descriptorPath, folders) {
    this.descriptorPath = descriptorPath;
    this.folders = folders;
  }
  descriptor() {
    const value = readBroker(this.descriptorPath(), this.folders());
    if (!("url" in value))
      throw new Error("EZiL model broker is unavailable.");
    return value;
  }
  async provideLanguageModelChatInformation(_options, token) {
    if (token.isCancellationRequested)
      return [];
    const models = await readModels(this.descriptor());
    return models.map((id) => ({ id, name: id, family: id, version: "configured", maxInputTokens: 8192, maxOutputTokens: OUTPUT_LIMIT, capabilities: { imageInput: false, toolCalling: false } }));
  }
  async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    await streamChat(this.descriptor(), requestBody(model, messages, options), (part) => progress.report(part), token);
  }
  async provideTokenCount(_model, value, _token) {
    const text = typeof value === "string" ? value : textContent(value);
    return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
  }
}

// src/extension.ts
var heartbeat;
var report;
var ports = new Set;
async function activate(context) {
  if (!vscode2.workspace.isTrusted)
    return;
  const folders = () => (vscode2.workspace.workspaceFolders ?? []).map((folder) => folder.uri.scheme === "file" ? folder.uri.fsPath : "");
  if (process.env.EZIL_AI_BROKER_FILE) {
    context.subscriptions.push(vscode2.lm.registerLanguageModelChatProvider("ezil", new EZiLModelProvider(() => process.env.EZIL_AI_BROKER_FILE, folders)));
    context.subscriptions.push(vscode2.commands.registerCommand("ezil.listModels", async () => {
      try {
        const descriptor = readBroker(process.env.EZIL_AI_BROKER_FILE, folders());
        if (!("url" in descriptor))
          throw new Error("model_broker_unavailable");
        const models = await readModels(descriptor);
        vscode2.window.showInformationMessage(models.length ? `EZiL broker models: ${models.join(", ")}` : "No EZiL broker models are configured.");
      } catch {
        vscode2.window.showInformationMessage("EZiL model broker is unavailable.");
      }
    }));
  }
  if (!process.env.EZIL_BROKER_FILE)
    return;
  try {
    if ("url" in readBroker(process.env.EZIL_BROKER_FILE, folders()))
      throw new Error("connector_unavailable");
  } catch {
    vscode2.window.showInformationMessage("EZiL connector is unavailable. You can keep using VS Code.");
    return;
  }
  report = async (operation) => {
    const descriptor = readBroker(process.env.EZIL_BROKER_FILE, folders());
    if (!("origin" in descriptor))
      throw new Error("connector_unavailable");
    await sendOperation(descriptor, operation);
  };
  const refresh = async () => {
    await report?.({ op: "editor.readiness", state: "active" });
    for (const port of ports)
      await report?.({ op: "preview.register", port });
  };
  try {
    await refresh();
  } catch {
    vscode2.window.showInformationMessage("EZiL connector is unavailable. You can keep using VS Code.");
  }
  let refreshing = false;
  heartbeat = setInterval(() => {
    if (refreshing)
      return;
    refreshing = true;
    refresh().catch(() => {}).finally(() => {
      refreshing = false;
    });
  }, 15000);
  for (const register of [true, false])
    context.subscriptions.push(vscode2.commands.registerCommand(register ? "ezil.registerPreview" : "ezil.unregisterPreview", async () => {
      const input = await vscode2.window.showInputBox({
        title: register ? "Register loopback preview" : "Unregister loopback preview",
        prompt: "Port on 127.0.0.1 (1024–65535)",
        validateInput: (text) => parsePort(text) === undefined ? "Enter a port from 1024 to 65535." : undefined
      });
      if (input === undefined)
        return;
      const port = parsePort(input);
      if (port === undefined)
        return;
      try {
        await report?.({ op: register ? "preview.register" : "preview.unregister", port });
        if (register)
          ports.add(port);
        else
          ports.delete(port);
        vscode2.window.showInformationMessage(register ? "Loopback preview registered." : "Loopback preview unregistered.");
      } catch {
        vscode2.window.showInformationMessage("EZiL connector is unavailable. Please reopen this workspace from EZiL OS.");
      }
    }));
  context.subscriptions.push({ dispose: () => {
    clearInterval(heartbeat);
  } });
}
async function deactivate() {
  clearInterval(heartbeat);
  try {
    for (const port of ports)
      await report?.({ op: "preview.unregister", port });
    await report?.({ op: "editor.readiness", state: "unknown" });
  } catch {}
  ports.clear();
  report = undefined;
}
