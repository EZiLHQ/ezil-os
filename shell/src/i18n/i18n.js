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
// MODIFIED BY EZIL 2026-07-31: dropped the ~40-locale `translations.js` barrel
// for a single `en` import (the other locales are not ported), and repointed
// the `docs`/`terms`/`privacy` link variables off puter.com — upstream's
// trademark policy forbids shipping the marks in a modified distribution.
// The bare `html_encode` global this file calls is still installed by
// `lib/html-entities.js`, which `lib/ezil-vendor.js` evaluates first.

import en from './translations/en.js';

const translations = { en };

window.listSupportedLanguages = () => Object.keys(translations).map(lang => translations[lang]);

const variables = {
    docs: 'https://ezil.org/docs',
    terms: 'https://ezil.org/terms',
    privacy: 'https://ezil.org/privacy',
};

function ReplacePlaceholders (str, arg_variables = {}) {
    const all_variables = { ...variables, ...arg_variables };
    str = str.replace(/{{link=(.*?)}}(.*?){{\/link}}/g, (_, key, text) => `<a href="${all_variables[key]}" target="_blank">${text}</a>`);
    str = str.replace(/{{(.*?)}}/g, (_, key) => all_variables[key]);
    return str;
}

window.i18n = function (key, replacements = [], encode_html = true) {
    let arg_variables = {};
    if ( Array.isArray(replacements) === false ) {
        if ( typeof replacements === 'object' ) {
            arg_variables = replacements;
            replacements = [];
        } else {
            replacements = [replacements];
        }
    }

    let language = translations[window.locale] ?? translations['en'];
    let str = language.dictionary[key] ?? translations['en'].dictionary[key];

    if ( ! str ) {
        str = key;
    }
    str = ReplacePlaceholders(str, arg_variables);
    if ( encode_html ) {
        str = html_encode(str);
        // html_encode doesn't render line breaks
        str = str.replace(/\n/g, '<br />');
    }
    // replace %% occurrences with the values in replacements
    // %% is for simple text replacements
    // %strong% is for <strong> tags
    // e.g. "Hello, %strong%" => "Hello, <strong>World</strong>"
    // e.g. "Hello, %%" => "Hello, World"
    // e.g. "Hello, %strong%, %%!" => "Hello, <strong>World</strong>, Universe!"
    for ( let i = 0; i < replacements.length; i++ ) {
        // sanitize the replacement
        replacements[i] = encode_html ? html_encode(replacements[i]) : replacements[i];
        // find first occurrence of %strong%
        let index = str.indexOf('%strong%');
        // find first occurrence of %%
        let index2 = str.indexOf('%%');
        // decide which one to replace
        if ( index === -1 && index2 === -1 ) {
            break;
        } else if ( index === -1 ) {
            str = str.replace('%%', replacements[i]);
        } else if ( index2 === -1 ) {
            str = str.replace('%strong%', `<strong>${ replacements[i] }</strong>`);
        } else if ( index < index2 ) {
            str = str.replace('%strong%', `<strong>${ replacements[i] }</strong>`);
        } else {
            str = str.replace('%%', replacements[i]);
        }
    }
    return str;
};

export default {};