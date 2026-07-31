/*
 * Copyright (C) 2024-present Puter Technologies Inc.
 *
 * This file is part of Puter.
 *
 * Puter is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
// MODIFIED BY EZIL 2026-07-31: dropped the Component path; kept the HTML path.
//
// This file was expected to come across verbatim. It cannot: upstream's 47
// lines import `util/Placeholder.js` and `UI/Components/JustHTML.js`, and
// JustHTML is `def(class JustHTML extends Component ...)` -- which drags in
// `util/Component.js` (223 lines of shadow-DOM web-component base class) and
// the global `def()`/`use()` class registry from `init_sync.js`. That registry
// exists to expose classes to Puter's *service scripts* and extension loader,
// which is exactly the machinery this fork does not ship (see the LOCAL CODE
// ONLY rule and shell/build-shell.sh's note on why webpack was dropped).
//
// So `options.component` is gone and `options.html` -- the only branch the EZiL
// shell needs -- is passed straight through to UIWindow's `body_content`. If a
// later wave wants real components, port Component.js deliberately rather than
// resurrecting this import chain by accident. Passing `component` now throws
// rather than silently rendering an empty window.

import UIWindow from './UIWindow.js';

/**
 * @typedef {Object} UIComponentWindowOptions
 * @property {string} [html] HTML string to render in the window
 */

/**
 * Render a UIWindow whose body is an HTML string.
 * @param {UIComponentWindowOptions} options
 */
export default async function UIComponentWindow (options) {
    if ( options.component ) {
        throw new Error(
            '[ezil-os:shell] UIComponentWindow: `options.component` is not supported. '
            + "Puter's Component/def()/use() registry is not ported - pass `options.html`. "
            + 'See shell/PUTER-PROVENANCE.md.',
        );
    }

    return await UIWindow({
        ...options,

        body_content: options.html ?? '',
    });
}
