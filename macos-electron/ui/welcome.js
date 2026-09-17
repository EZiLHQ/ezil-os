'use strict';
const $ = id => document.getElementById(id);
let pending = false;
async function request(input) {
  if (pending) return;
  pending = true; $('status').textContent = 'Getting things ready…';
  document.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try { const value = await window.ezilNative.request(input); await refresh(); $('status').textContent = 'Ready.'; return value; }
  catch (error) { $('status').textContent = error.message; }
  finally { pending = false; document.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
}
function button(label, op, id) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => request({ op, id }); return b; }
async function refresh() {
  const state = await window.ezilNative.request({ op: 'status' });
  $('guest').hidden = state.guest; $('workspaces').hidden = !state.guest;
  $('list').replaceChildren();
  for (const workspace of state.workspaces) {
    const row = document.createElement('article'), title = document.createElement('h3'); title.textContent = workspace.name; row.append(title);
    for (const [label, op] of [['Open desktop', 'open'], ['Browser', 'browser'], ['VS Code', 'editor'], ['Stop editor', 'stopEditor'], ['Remove', 'remove']]) row.append(button(label, op, workspace.id));
    $('list').append(row);
  }
  const connector = state.connector?.readiness === 'available' && state.connector?.preview === 'available'
    ? ' The EZiL connector is ready for editor status and loopback previews.'
    : ' The EZiL connector is unavailable; the desktop and browser still work.';
  const modelProvider = state.connector?.modelProvider === 'available' ? ' EZiL BYOK is available in the VS Code model picker.' : '';
  $('editor').textContent = (state.editor === 'available' ? 'Verified Microsoft VS Code 1.109 or newer is available.' : 'Microsoft VS Code 1.109 or newer is not installed or could not be verified. Your desktop and browser are available.') + connector + modelProvider;
  $('provider').textContent = state.provider.configured ? 'A provider is connected.' : 'No provider connected.';
  $('usage').textContent = `Provider requests: ${state.usage.requests} · Completed: ${state.usage.completed} · Failed: ${state.usage.failed}\nReceived bytes: ${state.usage.responseBytes}. Token and cost totals are not estimated.`;
  $('diagnostics').textContent = state.diagnostics.map(d => `${d.at} ${d.code}`).join('\n') || 'No issues recorded.';
}
$('guest').onclick = () => request({ op: 'guest' });
for (const op of ['create', 'import']) $(op).onclick = async () => {
  const workspace = await request({ op, name: $('name').value });
  if (workspace) await request({ op: 'open', id: workspace.id });
};
$('installer').onclick = () => request({ op: 'installer' });
document.querySelectorAll('[data-provider]').forEach(b => { b.onclick = () => request({ op: 'provider', action: b.dataset.provider }); });
refresh().then(() => { $('status').textContent = 'Ready.'; }).catch(() => { $('status').textContent = 'Unable to load Settings.'; });
