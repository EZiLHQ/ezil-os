/**
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
// MODIFIED BY EZIL 2026-07-31: extracted `window.uuidv4` from upstream
// `src/gui/src/helpers.js` (3,623 lines, upstream commit 5a15719, lines
// 220-223) into a file of its own. The function body is unchanged.
//
// This is the ONLY thing cherry-picked out of helpers.js. The brief also named
// `scale_window`, `update_window_layout` and `html_encode`, but none of the
// three actually live there:
//   - `window.scale_window`        is defined in UIWindow.js (upstream L3736)
//   - `window.update_window_layout` is defined in UIWindow.js (upstream L3851)
//     -- both therefore came across free with the whole-file UIWindow port
//   - `window.html_encode`         is installed by lib/html-entities.js
// The rest of helpers.js is the file manager, upload/zip/tar, auth and the
// Puter API client, and is not ported.

/**
 * Generates a UUID (Universally Unique Identifier) using the version 4 format,
 * which are random UUIDs. It uses the crypto API to generate the random numbers.
 *
 * @returns {string} A version 4 UUID
 */
export const uuidv4 = () => {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
};

window.uuidv4 = uuidv4;

export default uuidv4;
