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
var vscode = __toESM(require("vscode"));

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
    const expected = import_node_path.resolve(value.workspacePath);
    if (inside(value.dataRoot, path) || import_node_path.resolve(folders[0]) !== expected)
      throw new Error("broker_unavailable");
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

// src/extension.ts
var heartbeat;
var report;
var ports = new Set;
async function activate(context) {
  if (!process.env.EZIL_BROKER_FILE || !vscode.workspace.isTrusted)
    return;
  const folders = () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.scheme === "file" ? folder.uri.fsPath : "");
  context.subscriptions.push(vscode.commands.registerCommand("ezil.listModels", async () => {
    try {
      const descriptor = readBroker(process.env.EZIL_BROKER_FILE, folders());
      if (!("url" in descriptor))
        throw new Error("model_broker_unavailable");
      const models = await readModels(descriptor);
      vscode.window.showInformationMessage(models.length ? `EZiL broker models: ${models.join(", ")}` : "No EZiL broker models are configured.");
    } catch {
      vscode.window.showInformationMessage("EZiL model broker is unavailable.");
    }
  }));
  try {
    if ("url" in readBroker(process.env.EZIL_BROKER_FILE, folders()))
      return;
  } catch {
    vscode.window.showInformationMessage("EZiL connector is unavailable. You can keep using VS Code.");
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
    vscode.window.showInformationMessage("EZiL connector is unavailable. You can keep using VS Code.");
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
    context.subscriptions.push(vscode.commands.registerCommand(register ? "ezil.registerPreview" : "ezil.unregisterPreview", async () => {
      const input = await vscode.window.showInputBox({
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
        vscode.window.showInformationMessage(register ? "Loopback preview registered." : "Loopback preview unregistered.");
      } catch {
        vscode.window.showInformationMessage("EZiL connector is unavailable. Please reopen this workspace from EZiL OS.");
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
