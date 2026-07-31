// ezil-jquery.js — EZiL-authored. Not Puter code.
//
// Upstream Puter loads jQuery as a *classic* <script> (see upstream
// `src/gui/src/static-assets.js`), so `window.$` and `window.jQuery` exist as
// real globals by the time any UI module runs. EZiL bundles everything into a
// single esbuild IIFE instead, and esbuild detects jQuery's UMD `module.exports`
// branch — which makes jQuery run in `noGlobal` mode and NOT publish itself.
//
// So we publish it. This file exists only for that, and it must be a separate
// module from `ezil-vendor.js`: ES `import` declarations are hoisted, so a
// global assigned in a module *body* lands after every sibling import has
// already evaluated. jQuery UI reads the bare global `jQuery` at evaluation
// time, so the assignment has to happen inside a module that jQuery UI's
// importer lists *before* it.

import jQuery from './jquery-3.6.1/jquery-3.6.1.min.js';

globalThis.jQuery = jQuery;
globalThis.$ = jQuery;

export default jQuery;
