// EZiL-authored. The store browses the current shell's tools; it does not
// create installation records or confer authority to run a repository.
import UIWindow from '../../src/UI/UIWindow.js';

const INFORMATION = {
    desktop: {
        category: 'Productivity', computer: true,
        summary: 'A browser that lives on your EZiL computer.',
        description: 'Browse the web in a dedicated window on your computer. Keep your workspace and browsing together inside EZiL-OS.',
        requirements: 'A connected computer with its Browser service configured.',
        access: 'Uses the browser session on your computer. Website accounts and permissions are managed by each website.',
    },
    code: {
        category: 'Development', computer: true,
        summary: 'Your editor, terminal, and projects in one place.',
        description: 'Open your computer’s development environment to edit code, work with projects, and use the integrated terminal.',
        requirements: 'A connected computer with its Code service configured.',
        access: 'Can read and change files in your computer’s development workspace.',
    },
    preview: {
        category: 'Development', computer: true,
        summary: 'See the app you’re building, right beside your code.',
        description: 'Open a running web application from your computer in an EZiL window. Preview uses your existing project and development server.',
        requirements: 'A connected computer and a running, supported web preview.',
        access: 'Displays your project’s web application. Its own data and account permissions still apply.',
    },
    settings: {
        category: 'System',
        summary: 'Make this computer feel like yours.',
        description: 'Manage your computers, personalize the desktop, and find system information and troubleshooting tools.',
        requirements: 'Included with EZiL-OS. No additional setup is needed.',
        access: 'Manages your EZiL computers and desktop preferences through your signed-in account.',
    },
    'secure-browser': {
        category: 'Productivity', opensExternally: true,
        summary: 'Open the native secure browser on your Mac.',
        description: 'Launch the secure browser through the native EZiL desktop integration.',
        requirements: 'The EZiL native macOS application.',
        access: 'Uses the native browser and its website permissions.',
    },
};

const RETICLE = {
    id: 'reticle', name: 'Reticle', category: 'Development', included: false,
    summary: 'Connect your development apps to Reticle.',
    description: 'The planned Reticle integration will bring projects, connected sessions, and runs into a dedicated EZiL window backed by the Reticle daemon.',
    requirements: 'Not available to install yet. The daemon and project connection workflow must be integrated and validated first.',
    access: 'The planned integration will require an explicit connection to a selected project before changing its configuration.',
    source: 'https://github.com/reticlehq/reticle',
};

const CATEGORIES = ['All apps', 'Productivity', 'Development', 'System'];
const glyph = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const SEARCH = glyph('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>');
const GRID = glyph('<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>');
const LIBRARY = glyph('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>');
const ARROW = glyph('<path d="M5 12h14m-5-5 5 5-5 5"/>');

function icon (app, extra = '') {
    return app.icon
        ? `<img class="ezil-store-icon ${extra}" src="${html_encode(app.icon)}" alt="" draggable="false">`
        : `<span class="ezil-store-icon ezil-store-monogram ${extra}" aria-hidden="true">R</span>`;
}

function badge (app) {
    return `<span class="ezil-store-badge ${app.included ? '' : 'ezil-store-badge-planned'}">${app.included ? 'Included' : 'Planned'}</span>`;
}

function openButton (app) {
    return app.included
        ? `<button type="button" class="ezil-store-open" data-action="open" data-id="${app.id}" aria-label="Open ${html_encode(app.name)}">Open</button>`
        : '<span class="ezil-store-unavailable">Not available yet</span>';
}

function card (app) {
    return `<article class="ezil-store-card" data-catalog-app="${app.id}">
        <div class="ezil-store-card-heading">${icon(app)}<div><h3>${html_encode(app.name)}</h3><span class="ezil-store-category">${app.category}</span></div>${badge(app)}</div>
        <p>${html_encode(app.summary)}</p>
        <div class="ezil-store-card-actions"><button type="button" class="ezil-store-details" data-action="details" data-id="${app.id}" aria-label="Details for ${html_encode(app.name)}">Details ${ARROW}</button>${openButton(app)}</div>
    </article>`;
}

/** Dependencies come from the registry so the store cannot bypass resolve(). */
export async function openAppStoreWindow (ctx = {}) {
    const catalog = Object.entries(INFORMATION).flatMap(([id, information]) => {
        const app = ctx.apps?.find(item => item.id === id);
        return app ? [{ ...information, id, name: app.name, icon: app.icon, included: true }] : [];
    });
    catalog.push(RETICLE);
    const included = catalog.filter(app => app.included);
    const state = { view: 'discover', category: 'All apps', query: '', detail: null };
    const events = new AbortController();
    let closed = false;
    const width = Math.min(1080, window.innerWidth - 40);
    const height = Math.min(740, window.innerHeight - 100);
    const el = await UIWindow({
        title: 'App Store', app: 'app-store', icon: ctx.icon,
        width, height, left: `${(window.innerWidth - width) / 2}px`,
        top: `${Math.max(16, (window.innerHeight - height - 64) / 2)}px`,
        is_resizable: true, is_maximized: false, has_head: true,
        single_instance: true, show_in_taskbar: true, is_droppable: false, selectable_body: true,
        window_class: 'ezil-store-window', body_css: { padding: '0', overflow: 'hidden' },
        on_close: () => { closed = true; events.abort(); },
        body_content: `<div class="ezil-store"><div class="ezil-store-layout">
            <aside class="ezil-store-sidebar">
                <div class="ezil-store-brand"><img src="${html_encode(ctx.icon ?? '')}" alt=""><span>App Store<small>EZiL-OS</small></span></div>
                <nav aria-label="App Store"><button type="button" data-view="discover" aria-pressed="true">${GRID} Discover</button><button type="button" data-view="yours" aria-pressed="false">${LIBRARY} Your apps <span class="ezil-store-nav-count">${included.length}</span></button></nav>
                <p class="ezil-store-sidebar-note">A home for your tools.<br><span>More possibilities ahead.</span></p>
            </aside>
            <div class="ezil-store-main">
                <header class="ezil-store-toolbar"><label class="ezil-store-search">${SEARCH}<input type="search" aria-label="Search apps" placeholder="Search apps" maxlength="120" autocomplete="off" spellcheck="false"><button type="button" data-action="clear" aria-label="Clear search" hidden>×</button></label><span class="ezil-store-computer" title="${html_encode(ctx.computer?.name ?? 'Your computer')}">${LIBRARY}<span>${html_encode(ctx.computer?.name ?? 'Your computer')}</span></span></header>
                <div class="ezil-store-content"></div>
                <div class="ezil-store-status" role="status" aria-live="polite"></div>
            </div>
        </div></div>`,
    });
    if (!el) return null;
    const content = el.querySelector('.ezil-store-content');
    const search = el.querySelector('input[type="search"]');
    const status = el.querySelector('.ezil-store-status');
    const pending = new Set();

    function render () {
        el.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)));
        el.querySelector('[data-action="clear"]').hidden = !state.query;
        status.textContent = '';
        const app = catalog.find(item => item.id === state.detail);
        if (app) {
            const needsSetup = app.computer && ctx.desktopState?.configured !== true && ctx.desktopState?.provider !== 'native-macos';
            content.innerHTML = `<button type="button" class="ezil-store-back" data-action="back">← Back to ${state.view === 'yours' ? 'your apps' : 'Discover'}</button>
                <div class="ezil-store-detail-heading">${icon(app)}<div>${badge(app)}<h1 tabindex="-1">${html_encode(app.name)}</h1><p>${html_encode(app.summary)}</p></div></div>
                <div class="ezil-store-detail-action">${openButton(app)}<span>${app.included ? 'Included with EZiL-OS' : 'Planned integration · Installation is not available'}</span></div>
                ${needsSetup ? '<p class="ezil-store-notice">This computer needs to be connected before this app can run. Opening it will show the current setup status.</p>' : ''}
                <dl class="ezil-store-facts"><div><dt>Category</dt><dd>${app.category}</dd></div><div><dt>${app.included ? 'Provided by' : 'Source'}</dt><dd>${app.included ? 'EZiL-OS' : 'reticlehq / reticle'}</dd></div><div><dt>Availability</dt><dd>${app.included ? 'Built-in tool' : 'Not released'}</dd></div></dl>
                <section class="ezil-store-detail-section"><h2>About this app</h2><p>${html_encode(app.description)}</p></section>
                <section class="ezil-store-detail-section"><h2>What you need</h2><p>${html_encode(app.requirements)}</p></section>
                <section class="ezil-store-detail-section"><h2>Access &amp; data</h2><p>${html_encode(app.access)}</p></section>
                ${app.source ? `<a class="ezil-store-source" href="${app.source}" target="_blank" rel="noopener noreferrer">View source on GitHub ↗</a>` : ''}`;
        } else {
            const query = state.query.trim().toLocaleLowerCase();
            const apps = catalog.filter(item => (state.view !== 'yours' || item.included)
                && (state.category === 'All apps' || state.category === item.category)
                && `${item.name} ${item.category} ${item.summary}`.toLocaleLowerCase().includes(query));
            content.innerHTML = `<div class="ezil-store-page-heading"><h1 tabindex="-1">${state.view === 'yours' ? 'Your apps' : 'Discover'}</h1><p>${state.view === 'yours' ? 'The tools included with your EZiL computer.' : 'Find a little more possibility.'}</p></div>
                ${state.view === 'discover' && !query && state.category === 'All apps' ? `<section class="ezil-store-hero"><div><span class="ezil-store-eyebrow">INCLUDED WITH EZiL-OS</span><h2>Good tools.<br>One place.</h2><p>Browse, build, and make it yours.</p><button type="button" data-action="yours">Explore your apps ${ARROW}</button></div><div class="ezil-store-hero-art" aria-hidden="true">${included.slice(0, 3).map(app => icon(app)).join('')}</div></section>` : ''}
                <div class="ezil-store-categories" role="group" aria-label="App categories">${CATEGORIES.map(category => `<button type="button" data-category="${category}" aria-pressed="${category === state.category}">${category}</button>`).join('')}</div>
                <div class="ezil-store-section-heading"><h2>${query ? 'Search results' : state.view === 'yours' ? 'Included apps' : 'Explore apps'}</h2><span role="status">${apps.length} ${apps.length === 1 ? 'app' : 'apps'}</span></div>
                ${apps.length ? `<div class="ezil-store-grid">${apps.map(card).join('')}</div>` : `<div class="ezil-store-empty">${SEARCH}<h2>No apps found</h2><p>Try a different search or category.</p><button type="button" class="ezil-store-open" data-action="reset">Clear filters</button></div>`}
                <p class="ezil-store-footer">More apps are on the way. Repository installations are not available yet.</p>`;
        }
        content.querySelectorAll('[data-action="open"]').forEach(button => {
            button.disabled = pending.has(button.dataset.id);
            if (button.disabled) button.textContent = 'Opening…';
        });
    }

    function goBack () {
        const id = state.detail;
        state.detail = null;
        render();
        content.querySelector(`[data-action="details"][data-id="${id}"]`)?.focus();
    }

    function changeView (view) {
        Object.assign(state, { view, category: 'All apps', query: '', detail: null });
        search.value = '';
        render();
        content.scrollTop = 0;
        content.querySelector('h1')?.focus();
    }

    search.addEventListener('input', () => {
        state.query = search.value;
        state.detail = null;
        render();
        content.scrollTop = 0;
    }, { signal: events.signal });

    el.addEventListener('keydown', event => {
        if (event.key === 'Escape' && state.detail && event.target !== search) {
            event.stopPropagation();
            goBack();
        }
    }, { signal: events.signal });

    el.addEventListener('click', async event => {
        const button = event.target.closest('button');
        if (!button || !el.contains(button)) return;
        if (button.dataset.view) return changeView(button.dataset.view);
        if (button.dataset.category) {
            state.category = button.dataset.category;
            render();
            content.querySelector(`[data-category="${state.category}"]`)?.focus();
            return;
        }
        switch (button.dataset.action) {
            case 'yours': return changeView('yours');
            case 'back': return goBack();
            case 'clear':
            case 'reset':
                state.query = ''; state.category = 'All apps'; state.detail = null; search.value = '';
                render(); search.focus(); return;
            case 'details':
                state.detail = button.dataset.id;
                render(); content.scrollTop = 0; content.querySelector('h1')?.focus(); return;
            case 'open': {
                const app = catalog.find(item => item.id === button.dataset.id && item.included);
                if (!app || pending.has(app.id)) return;
                pending.add(app.id);
                button.disabled = true; button.textContent = 'Opening…';
                try {
                    const opened = await ctx.launchApp(app.id);
                    if (!opened && !app.opensExternally && !closed) status.textContent = `Could not open ${app.name}. Try opening it from the launcher.`;
                } catch {
                    if (!closed) status.textContent = `Could not open ${app.name}. Please try again.`;
                } finally {
                    pending.delete(app.id);
                    if (!closed) content.querySelectorAll(`[data-action="open"][data-id="${app.id}"]`).forEach(item => {
                        item.disabled = false; item.textContent = 'Open';
                    });
                }
            }
        }
    }, { signal: events.signal });

    render();
    return el;
}
