import type { PreviewState } from './state';
import { previewScript } from './script.generated';

function escape(value: string): string {
    return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
/** Only call with a validated mint origin. The loading/error page permits no frames. */
export function previewHtml(cspSource: string, nonce: string, state: PreviewState, origin = '', mintedUrl = '', agentAvailable = false): string {
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; frame-src ${origin || "'none'"}; base-uri 'none'; form-action 'none'`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><title>App Preview</title>
<style>
body { margin:0; color:var(--vscode-foreground); background:var(--vscode-editor-background); font-family:var(--vscode-font-family); }
.toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:6px; padding:8px; border-bottom:1px solid var(--vscode-panel-border); }
button, select { min-width:32px; min-height:32px; color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); border:1px solid var(--vscode-contrastBorder, transparent); border-radius:3px; cursor:pointer; }
button:focus-visible, select:focus-visible { outline:2px solid var(--vscode-focusBorder); outline-offset:2px; }
button[aria-pressed="true"] { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
button:disabled { opacity:.45; cursor:default; }
#address { flex:1 1 220px; overflow-wrap:anywhere; font-size:12px; }
#status { min-height:20px; padding:6px 10px; font-size:12px; }
#stage { overflow:auto; height:calc(100vh - 115px); display:flex; justify-content:center; align-items:flex-start; }
iframe { border:0; background:white; flex-shrink:0; }
</style></head><body>
<div class="toolbar" role="toolbar" aria-label="Preview controls">
<button id="back" aria-label="Back" disabled>←</button><button id="forward" aria-label="Forward" disabled>→</button>
<button id="reload">Reload</button><span id="address" aria-label="Preview address"></span>
<button id="external">Open in browser</button>
<label>Viewport <select id="viewport"><option value="responsive">Responsive</option><option value="390x844">390×844</option><option value="768x1024">768×1024</option><option value="1280x800">1280×800</option></select></label>
<button id="interact" aria-pressed="true">Interact</button><button id="select" aria-pressed="false">Select</button>
<button id="share" aria-pressed="false" disabled${agentAvailable ? '' : ' hidden'}>Share with Agent</button>
<button id="retry" hidden>Retry</button></div>
<div id="status" role="status" aria-live="polite">Starting preview…</div>
<div id="stage"><iframe id="app" title="Live app preview" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads" data-origin="${escape(origin)}" data-url="${escape(mintedUrl)}" data-path="${escape(state.path)}" data-viewport="${escape(state.viewport)}"></iframe></div>
<script nonce="${nonce}">${previewScript.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
