export function injectBillingStyles (doc) {
    if ( doc.querySelector('style[data-ezil-billing="dialog"]') ) return;
    const style = doc.createElement('style');
    style.dataset.ezilBilling = 'dialog';
    style.textContent = `
.ezil-billing-popup, .ezil-billing-bar {
    --ezil-billing-surface: #161616;
    --ezil-billing-text: rgba(245,245,244,.95);
    --ezil-billing-secondary: rgba(245,245,244,.65);
    --ezil-billing-tertiary: rgba(245,245,244,.45);
    --ezil-billing-border: rgba(245,245,244,.12);
    --ezil-billing-primary: #00adb5;
    --ezil-billing-primary-text: #06181a;
    --ezil-billing-warning: #f2b950;
    --ezil-billing-error: #f87171;
    box-sizing: border-box; color: var(--ezil-billing-text); font: inherit; font-size: 13px; font-variant-numeric: tabular-nums;
}
.ezil-billing-popup {
    position: fixed; inset: 0; margin: auto; width: min(440px, calc(100vw - 32px));
    max-height: 90vh; overflow: auto; padding: 24px; background: var(--ezil-billing-surface);
    border: 1px solid var(--ezil-billing-border); border-radius: 12px; z-index: 2147483647;
}
.ezil-billing-popup::backdrop { background: rgba(22,22,22,.6); }
.ezil-billing-header { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
.ezil-billing-headline { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.4; }
.ezil-billing-subline { margin: 8px 0 20px; color: var(--ezil-billing-secondary); line-height: 1.5; }
.ezil-billing-balances { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); margin: 0 0 16px; border: 1px solid var(--ezil-billing-border); border-radius: 6px; }
.ezil-billing-bucket { min-width: 0; padding: 12px; }
.ezil-billing-bucket + .ezil-billing-bucket { border-left: 1px solid var(--ezil-billing-border); }
.ezil-billing-bucket dt { color: var(--ezil-billing-secondary); font-size: 12px; }
.ezil-billing-amount { margin: 6px 0; font-size: 22px; font-weight: 600; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.ezil-billing-note { margin: 0; color: var(--ezil-billing-tertiary); font-size: 11px; line-height: 1.4; }
.ezil-billing-cards { display: grid; gap: 8px; }
.ezil-billing-button, .ezil-billing-card { font: inherit; color: inherit; border: 1px solid var(--ezil-billing-border); border-radius: 6px; background: transparent; cursor: pointer; }
.ezil-billing-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 12px; }
.ezil-billing-button:hover, .ezil-billing-card:hover { background: rgba(245,245,244,.06); }
.ezil-billing-button:focus-visible, .ezil-billing-card:focus-visible { outline: 2px solid var(--ezil-billing-primary); outline-offset: 3px; }
.ezil-billing-button:disabled, .ezil-billing-card:disabled { opacity: .45; cursor: default; }
.ezil-billing-dismiss { border: 0; padding: 0 4px; font-size: 20px; line-height: 22px; }
.ezil-billing-card { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 4px 8px; padding: 12px; text-align: left; }
.ezil-billing-card-primary { border-color: var(--ezil-billing-primary); }
.ezil-billing-card-title { font-weight: 600; }
.ezil-billing-card-detail { grid-column: 1; color: var(--ezil-billing-secondary); font-size: 12px; line-height: 1.4; }
.ezil-billing-card-arrow { grid-column: 2; grid-row: 1 / 3; align-self: center; }
.ezil-billing-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.ezil-billing-primary { background: var(--ezil-billing-primary); color: var(--ezil-billing-primary-text); border-color: var(--ezil-billing-primary); }
.ezil-billing-primary:hover { background: var(--ezil-billing-primary); }
.ezil-billing-status { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; color: var(--ezil-billing-secondary); line-height: 1.5; }
.ezil-billing-status:empty { display: none; }
.ezil-billing-payment-note { margin: 8px 0 0; color: var(--ezil-billing-secondary); line-height: 1.5; }
.ezil-billing-icon { width: 16px; height: 16px; flex: 0 0 16px; }
.ezil-billing-spinner { animation: ezil-billing-spin 1s linear infinite; }
.ezil-billing-bar { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 4px 10px; border-radius: 6px; background: rgba(248,113,113,.12); color: var(--ezil-billing-error); }
.ezil-billing-bar[hidden] { display: none; }
.ezil-billing-bar-warning { background: rgba(242,185,80,.12); color: var(--ezil-billing-warning); }
.ezil-billing-bar-message { flex: 1; min-width: 0; line-height: 1.4; }
.ezil-billing-bar .ezil-billing-button { margin-left: auto; flex-shrink: 0; padding: 4px 8px; border-color: currentColor; }
.ezil-billing-countdown { font-variant-numeric: tabular-nums; }
@keyframes ezil-billing-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ezil-billing-spinner { animation: none; } }
@media (max-width: 440px) { .ezil-billing-popup { padding: 20px; } }
`;
    (doc.head ?? doc.documentElement).append(style);
}

export function billingIcon (doc, name) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'ezil-billing-icon');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', name === 'refresh'
        ? 'M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9'
        : 'M12 3 2 21h20L12 3ZM12 9v5m0 3v.1');
    svg.append(path);
    return svg;
}
