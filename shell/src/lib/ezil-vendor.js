// ezil-vendor.js — EZiL-authored. Not Puter code.
//
// The bundled equivalent of the `lib_paths` list in upstream Puter's
// `src/gui/src/static-assets.js`. Upstream ships twelve <script> tags; EZiL
// ships four of them, in the same relative order, as bundle imports:
//
//   jquery       -> via ./ezil-jquery.js, which also publishes the globals
//   jquery-ui    -> reads the bare global `jQuery` at evaluation time
//   dragster     -> NOT upstream's plugin; an EZiL reimplementation. See the
//                   header of ./ezil-dragster.js for why it had to exist.
//   html-entities-> assigns window.html_encode / window.html_decode
//   isMobile     -> UMD; esbuild takes its CJS branch, so we publish it here
//
// NOT ported (see ../../PUTER-PROVENANCE.md): viselect, socket.io, qrcode,
// iro, fflate, FileSaver, timeago, jquery.dragster.
//
// Import order is load-bearing and is the only reason this file exists as a
// module rather than a line in boot.js.

import './ezil-jquery.js';
import './jquery-ui-1.13.2/jquery-ui.min.js';
import './ezil-dragster.js';
import './html-entities.js';
import isMobile from './isMobile.min.js';

globalThis.isMobile = isMobile;

export { isMobile };
