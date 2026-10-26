// Explicit shell entry intent. Browser's internal app id remains `desktop`.
// Paths/project parameters stay in the URL; no arbitrary URL is used as an iframe target.
const ALIASES = Object.freeze({ browser: 'desktop' });
const SECTIONS = new Set(['account', 'usage', 'billing', 'computers', 'system', 'appearance', 'about', 'troubleshoot']);
export function parseAppLink(search, apps) {
    const params = new URLSearchParams(search);
    // Ambiguous duplicate targets must never choose a different app by parser order.
    if (params.getAll('app').length > 1 || params.getAll('settings').length > 1) return null;
    const requested = params.get('app');
    const section = params.get('settings');
    const id = requested ? (Object.hasOwn(ALIASES, requested) ? ALIASES[requested] : requested)
        : SECTIONS.has(section) ? 'settings' : null;
    if (!id || !apps.some(app => app.id === id)) return null;
    return { id, ...(id === 'settings' && SECTIONS.has(section) ? { initialTab: section } : {}) };
}
