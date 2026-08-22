# EZiL branding overlay for the pinned, project-owned `ezil-neko-vscode`
# image (built by /data/openclaw/projects/ezil/EBuilder/infra/neko-standalone
# from upstream m1k1o/neko @ d74052bb / m1k1o/neko-apps @ 049931d7, both
# Apache-2.0 — see ATTRIBUTIONS.md §2).
#
# Why this exists: the neko Go server bakes its whole HTML5 client bundle
# into /var/www at upstream build time (Vue app, hashed JS/CSS chunk names).
# Re-running that whole Vue build just to swap a handful of static files
# would pull in a large upstream toolchain for no benefit — every asset this
# task cares about (wordmark, favicons, tile icons, mask icon, PWA manifest,
# the chat notification sound, and the handful of user-visible strings in
# index.html) is a plain static file or a small, surgical whole-file
# replacement, so this Dockerfile takes the already-built, already-verified
# upstream image as its base and overlays EZiL's files on top of it. Nothing
# under /usr/bin/neko, /etc/neko, or the compiled JS/CSS in /var/www/js and
# /var/www/css is touched — only the static branding assets and index.html's
# markup (title/theme-color/text; every <script>/<link> tag and hashed
# filename is byte-identical to upstream) change.
#
# No EZiL logo graphic exists anywhere in this repository as of this commit
# (verified: app/public/*.svg and app/src/app/favicon.ico are the unmodified
# Next.js starter assets — file/globe/vercel/next/window icons and the
# default Next.js favicon, not an EZiL mark). Per the approved plan, this
# overlay therefore ships NEUTRAL/BLANK placeholders — solid tiles in EZiL's
# real, already-established palette (shell/src/css/ezil-tokens.css:
# --color-charcoal #161616 / --color-teal #00adb5) and empty SVGs for the
# wordmark/mask-icon — rather than inventing a logo mark. Swap the files
# under www/ for real EZiL brand assets the moment they exist; nothing else
# in this Dockerfile or in worker/Dockerfile needs to change.
#
# Build (from the repo root):
#   docker build -t ezil-neko-vscode:d74052bb-049931d7-ezil-brand2 \
#     -f worker/assets/neko-branding/Dockerfile worker/assets/neko-branding
#
# Then point worker/Dockerfile's `ARG NEKO_IMAGE` default at the resulting
# tag. THE OVERLAY SUFFIX MUST BE BUMPED EVERY TIME THE CONTENT OF www/
# CHANGES, and worker/Dockerfile's `ARG NEKO_IMAGE` must be bumped with it in
# the same commit. The two are a pair: the base tag is a content pin, so
# rebuilding new content under an old suffix would make `-ezil-brand1` mean
# two different images, and bumping only one of the two files silently ships
# the OLD overlay with no error anywhere. The suffix went 1 -> 2 when
# www/ezil-mobile.js and the <script> tag that loads it were added.
ARG BASE_NEKO_IMAGE=ezil-neko-vscode:d74052bb-049931d7
FROM ${BASE_NEKO_IMAGE}

# Favicons / PWA / tile icons — solid EZiL charcoal (#161616), sized to each
# original asset's ACTUAL pixel dimensions (verified with `file`, not
# assumed from the upstream filenames — several upstream mstile-*.png files
# are NOT the size their filename claims).
COPY www/favicon-16x16.png          /var/www/favicon-16x16.png
COPY www/favicon-32x32.png          /var/www/favicon-32x32.png
COPY www/apple-touch-icon.png       /var/www/apple-touch-icon.png
COPY www/android-chrome-192x192.png /var/www/android-chrome-192x192.png
COPY www/android-chrome-512x512.png /var/www/android-chrome-512x512.png
COPY www/mstile-70x70.png           /var/www/mstile-70x70.png
COPY www/mstile-144x144.png         /var/www/mstile-144x144.png
COPY www/mstile-150x150.png         /var/www/mstile-150x150.png
COPY www/mstile-310x150.png         /var/www/mstile-310x150.png
COPY www/mstile-310x310.png         /var/www/mstile-310x310.png

# Blank/neutral mask icon and PWA manifest/tile config (see header comment).
COPY www/safari-pinned-tab.svg      /var/www/safari-pinned-tab.svg
COPY www/site.webmanifest           /var/www/site.webmanifest
COPY www/browserconfig.xml          /var/www/browserconfig.xml

# The n.eko wordmark/mascot referenced by the compiled JS bundle
# (js/app.4919abb0.js: `e.exports=n.p+"img/logo.800bec71.svg"`) — replaced
# in place, SAME hashed filename, so the bundle's own reference needs no
# edit. Confirmed by inspection to be n.eko's cat-silhouette mark (the path
# data literally draws a cat/paw shape) — this is the "n.eko logo" this task
# is about. Blanked out per the no-invented-logo instruction.
COPY www/logo.svg                   /var/www/img/logo.800bec71.svg

# The literal "n.eko sound": js/app.4919abb0.js plays this file verbatim via
# `new Audio("chat.mp3").play()` on the chat plugin's `newMessage` event when
# the (user-toggleable, chat_sound) setting is on. Replaced with a
# same-format (MP3) but digitally silent file — see
# worker/assets/neko-branding/README.md for how the silence was verified —
# so no third-party jingle can ever be heard regardless of who/what triggers
# the chat plugin.
COPY www/chat-silent.mp3            /var/www/chat.mp3

# index.html: byte-identical to upstream except for <title>, the three
# theme-color/TileColor/mask-icon accent values, the noscript fallback
# string, and removal of the "self hosted virtual browser (m1k1o/neko)"
# attribution paragraph (Apache-2.0 requires no on-screen credit — see
# ATTRIBUTIONS.md §2 — the project-level file already carries full upstream
# attribution). Every <script>/<link> tag and hashed filename is unchanged,
# so the compiled Vue bundle's DOM/module expectations are unaffected.
# 🔴 index.html IS EDITED IN PLACE, NEVER REPLACED — and that is the whole
# lesson of 2026-08-22. This line used to be:
#
#     COPY www/index.html  /var/www/index.html
#
# A whole-file replacement, which necessarily pins the CONTENT-HASHED asset
# names of whichever base build it was captured from:
#     css/app.8dceb2fa.css · js/app.4919abb0.js · js/app-legacy.4a0d07b4.js
#
# The Vue build is NOT reproducible. Rebuilding the pinned base from the same
# pinned SHAs produced css/app.497e53ca.css and js/app.48a1d8f5.js — different
# hashes, same source. So the moment the base was rebuilt, every asset in the
# pinned index.html 404'd, the neko client never loaded, no RTCPeerConnection
# was ever constructed, and production served a desktop window with no video
# at all. Measured: `pcCount: 0`, and the browser refusing the stylesheet
# because a 404 body arrives as `text/plain`.
#
# It "worked" for months only because nobody had rebuilt the base. The pin was
# a landmine armed by the first rebuild, which is exactly when someone is least
# able to tell a new bug from an old one.
#
# So: take the base image's OWN index.html — whose hashes are correct by
# construction — and apply only the seven textual edits this overlay actually
# wants. The `www/index.html` file is kept in the repo as the readable record
# of what those edits produce, and is asserted against below, but it is no
# longer what ships.
RUN set -eux; \
    f=/var/www/index.html; \
    sed -i 's|<title>n\.eko</title>|<title>EZiL OS</title>|' "$f"; \
    sed -i 's|href="safari-pinned-tab.svg" color="#19bd9c"|href="safari-pinned-tab.svg" color="#00adb5"|' "$f"; \
    sed -i 's|name="msapplication-TileColor" content="#19bd9c"|name="msapplication-TileColor" content="#00adb5"|' "$f"; \
    sed -i 's|name="theme-color" content="#19bd9c"|name="theme-color" content="#161616"|' "$f"; \
    sed -i 's|<strong>We.re sorry but n\.eko[^<]*</strong>|<strong>This app requires JavaScript to be enabled.</strong>|' "$f"; \
    sed -i 's|<p>A self hosted virtual browser[^<]*<a[^>]*>[^<]*</a>[^<]*</p>||' "$f"; \
    sed -i 's|</head>|<script defer="defer" src="ezil-mobile.js"></script></head>|' "$f"; \
    # Every edit asserted, so a silent no-op from an upstream wording change is
    # a failed build rather than an unbranded image nobody notices.
    grep -q '<title>EZiL OS</title>' "$f"; \
    grep -q 'content="#161616"' "$f"; \
    grep -q 'color="#00adb5"' "$f"; \
    grep -q 'src="ezil-mobile.js"' "$f"; \
    ! grep -q 'n\.eko' "$f"; \
    ! grep -q 'm1k1o/neko' "$f"; \
    # 🔴 THE GUARD THAT WOULD HAVE CAUGHT THE PIN. Every hashed asset the page
    # references must exist in this image. With the old COPY this assertion
    # fails instantly; with the in-place edit it can only fail if upstream
    # changes its markup shape.
    for a in $(grep -oE '(js|css)/[A-Za-z0-9._-]+\.(js|css)' "$f" | sort -u); do \
      test -s "/var/www/$a" || { echo "ERROR: index.html references /var/www/$a which does not exist in this image" >&2; exit 1; }; \
    done; \
    echo "index.html branded in place; all referenced assets present"

# The mobile on-screen-keyboard affordance, referenced by exactly one added
# <script> tag in the index.html above (every pre-existing <script>/<link> tag
# and hashed filename in that file is still byte-identical to upstream). It is
# a separate file, not an inline blob, so it stays readable and diffable and so
# index.html's own diff against upstream remains one line. It runs in the
# desktop's origin — the only place with DOM access to the compiled client —
# and it is a hard no-op unless the device reports real touch capability. See
# the file's header comment for what the upstream bundle already provides and
# what this repairs.
COPY www/ezil-mobile.js             /var/www/ezil-mobile.js

# Build-time verification: fail the image build (not just a later manual
# check) if any of the strings this overlay is supposed to remove are still
# present in the file it patches.
RUN if grep -qi "n\.eko" /var/www/index.html; then \
      echo "ERROR: index.html still references n.eko after branding overlay" >&2; \
      exit 1; \
    fi \
  && if grep -q "19bd9c" /var/www/index.html; then \
      echo "ERROR: index.html still has n.eko's teal accent color" >&2; \
      exit 1; \
    fi \
  && if grep -qi "n\.eko" /var/www/site.webmanifest; then \
      echo "ERROR: site.webmanifest still references n.eko after branding overlay" >&2; \
      exit 1; \
    fi \
  && test -s /var/www/img/logo.800bec71.svg \
  && test -s /var/www/chat.mp3 \
  && test -s /var/www/ezil-mobile.js \
  && if ! grep -q 'src="ezil-mobile.js"' /var/www/index.html; then \
      echo "ERROR: index.html does not load ezil-mobile.js" >&2; \
      exit 1; \
    fi
