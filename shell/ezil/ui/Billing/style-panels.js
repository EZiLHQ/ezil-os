const styles = `
.ezil-billing-wallet-badge, .ezil-billing-wallet-popover, .ezil-billing-compute {
    --ezil-billing-surface: #161616;
    --ezil-billing-card: #1f1f1f;
    --ezil-billing-text: rgba(245, 245, 244, 1);
    --ezil-billing-secondary: rgba(245, 245, 244, .7);
    --ezil-billing-tertiary: rgba(245, 245, 244, .55);
    --ezil-billing-border: rgba(245, 245, 244, .15);
    --ezil-billing-primary: #00adb5;
    --ezil-billing-primary-text: #06181a;
    --ezil-billing-radius: 6px;
    color: var(--ezil-billing-text);
    font: inherit;
    font-size: 13px;
    line-height: 1.5;
    box-sizing: border-box;
}
.ezil-billing-money { font-variant-numeric: tabular-nums; }
.ezil-billing-sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
.ezil-billing-wallet-badge {
    display: inline-flex; flex-direction: column; gap: 4px;
    padding: 6px 10px; background: var(--ezil-billing-card);
    border: 1px solid var(--ezil-billing-border);
    border-radius: var(--ezil-billing-radius); cursor: pointer;
}
.ezil-billing-wallet-badge:disabled { cursor: default; }
.ezil-billing-wallet-badge:focus-visible, .ezil-billing-button:focus-visible,
.ezil-billing-compute-card:focus-visible {
    outline: 2px solid var(--ezil-billing-primary); outline-offset: 3px;
}
.ezil-billing-progress {
    display: block; height: 5px; width: 100%; overflow: hidden;
    background: rgba(245, 245, 244, .1); border-radius: var(--ezil-billing-radius);
}
.ezil-billing-wallet-badge .ezil-billing-progress { height: 3px; }
.ezil-billing-progress-fill { display: block; height: 100%; background: var(--ezil-billing-primary); }
.ezil-billing-wallet-popover {
    position: fixed; z-index: 100000; width: 280px; max-width: calc(100vw - 16px);
    padding: 16px; background: var(--ezil-billing-surface);
    border: 1px solid var(--ezil-billing-border); border-radius: var(--ezil-billing-radius);
    max-height: calc(100vh - 16px); overflow-y: auto;
}
.ezil-billing-wallet-row { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; }
.ezil-billing-wallet-row + .ezil-billing-wallet-row { margin-top: 16px; }
.ezil-billing-wallet-row .ezil-billing-progress, .ezil-billing-wallet-note { grid-column: 1 / -1; }
.ezil-billing-wallet-label { color: var(--ezil-billing-secondary); font-size: 12px; }
.ezil-billing-wallet-row .ezil-billing-money { font-weight: 600; }
.ezil-billing-wallet-note { color: var(--ezil-billing-tertiary); font-size: 11px; }
.ezil-billing-wallet-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.ezil-billing-button {
    padding: 6px 12px; border: 1px solid var(--ezil-billing-border);
    border-radius: var(--ezil-billing-radius); background: rgba(245, 245, 244, .04);
    color: var(--ezil-billing-text); font: inherit; font-size: 12px; cursor: pointer;
}
.ezil-billing-button:hover:not(:disabled) { background: rgba(245, 245, 244, .1); }
.ezil-billing-button-primary, .ezil-billing-button-primary:hover:not(:disabled) {
    background: var(--ezil-billing-primary); color: var(--ezil-billing-primary-text);
    border-color: var(--ezil-billing-primary); font-weight: 600;
}
.ezil-billing-button:disabled { opacity: .6; cursor: default; }
.ezil-billing-compute { container-type: inline-size; }
.ezil-billing-compute .ezil-billing-compute-title { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
.ezil-billing-compute .ezil-billing-compute-description { margin: 0 0 16px; color: var(--ezil-billing-secondary); }
.ezil-billing-compute-banner {
    display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 12px;
    background: var(--ezil-billing-card); border: 1px solid var(--ezil-billing-border);
    border-radius: var(--ezil-billing-radius);
}
.ezil-billing-compute-banner[hidden] { display: none; }
.ezil-billing-compute-banner-copy { flex: 1; }
.ezil-billing-compute-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.ezil-billing-compute-card {
    display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 16px;
    border: 1px solid var(--ezil-billing-border); border-radius: var(--ezil-billing-radius);
    background: var(--ezil-billing-card); color: var(--ezil-billing-text);
    font: inherit; text-align: left; cursor: pointer;
}
.ezil-billing-compute-card[aria-checked="true"] { box-shadow: inset 0 0 0 2px var(--ezil-billing-primary); }
.ezil-billing-compute-card:disabled { cursor: default; }
.ezil-billing-compute-card-locked { opacity: .6; }
.ezil-billing-compute-card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-weight: 600; }
.ezil-billing-compute-current {
    padding: 2px 8px; border-radius: 999px; color: var(--ezil-billing-primary);
    background: rgba(0, 173, 181, .12); font-size: 11px;
}
.ezil-billing-compute-specs { display: grid; gap: 6px; }
.ezil-billing-compute-spec, .ezil-billing-compute-reason { display: flex; align-items: center; gap: 8px; }
.ezil-billing-compute-spec { color: var(--ezil-billing-secondary); }
.ezil-billing-compute-reason { font-size: 12px; }
.ezil-billing-icon { width: 14px; height: 14px; flex: none; }
.ezil-billing-compute .ezil-billing-compute-status { color: var(--ezil-billing-secondary); margin: 12px 0 0; }
.ezil-billing-compute-status:empty { display: none; }
@media (max-width: 519px) { .ezil-billing-compute-grid { grid-template-columns: 1fr; } }
@container (max-width: 519px) { .ezil-billing-compute-grid { grid-template-columns: 1fr; } }
`;

export function ensurePanelStyles (doc) {
    if ( doc.querySelector('style[data-ezil-billing="panels"]') ) return;
    const style = doc.createElement('style');
    style.dataset.ezilBilling = 'panels';
    style.textContent = styles;
    (doc.head ?? doc.documentElement).append(style);
}

const icons = {
    lock: 'M4 7h8v7H4z M5 7V4a3 3 0 0 1 6 0v3',
    cpu: 'M4 4h8v8H4z M6 6h4v4H6z M6 1v3m4-3v3M6 12v3m4-3v3M1 6h3m-3 4h3m8-4h3m-3 4h3',
    memory: 'M2 4h12v8H2z M5 6v3m3-3v3m3-3v3M4 12v2m4-2v2m4-2v2',
    disk: 'M4 2h8l2 8v4H2v-4z M2 10h12 M10 12h2',
};

export function panelIcon (doc, name) {
    const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'ezil-billing-icon');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('width', '14');
    icon.setAttribute('height', '14');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.25');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', icons[name]);
    icon.append(path);
    return icon;
}
