'use strict';
const $ = id => document.getElementById(id);
async function action(action, rest = {}) {
  try {
    const state = await window.ezilNative.request({ op: 'browserAction', action, ...rest });
    $('tabs').replaceChildren();
    state.tabs.forEach((tab, index) => {
      const select = document.createElement('button'); select.textContent = `${index === state.active ? '• ' : ''}${tab.title}`; select.onclick = () => void windowAction('select', { tab: index });
      const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label', `Close ${tab.title}`); close.onclick = () => void windowAction('close', { tab: index });
      $('tabs').append(select, close);
    });
    if (document.activeElement !== $('url')) $('url').value = state.tabs[state.active]?.url || '';
    $('back').disabled = !state.back; $('forward').disabled = !state.forward;
    if (action !== 'state') $('status').textContent = '';
  } catch (error) { $('status').textContent = error.message; }
}
const windowAction = action;
for (const op of ['back', 'forward', 'reload', 'new', 'devtools']) $(op).onclick = () => action(op);
$('navigation').onsubmit = event => { event.preventDefault(); action('navigate', { url: $('url').value }); };
action('state'); setInterval(() => action('state'), 1500);
