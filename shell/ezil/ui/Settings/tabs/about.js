// tabs/about.js — EZiL-authored. Not Puter code.
//
// Version, the AGPL notice, and a source link. This is not decorative: it is
// what discharges AGPL-3.0 §13 for this shell. §13 (the "Affero" clause)
// requires that a user interacting with this software REMOTELY, over a
// network, be given an opportunity to receive the Corresponding Source — the
// obligation a plain AGPL notice in a README does not reach, because a
// browser user of a hosted EZiL OS never sees the README. Putting the offer
// inside the running application is what makes it reachable by the people
// the clause is actually for.
//
// All facts below are read from files already checked into this repository,
// not invented for this tab:
//   - the version is `shell.version` (`ezil/boot.js`'s own `shell` object) —
//     one number, not duplicated here.
//   - the contact address is the repository's own published legal contact,
//     `NOTICE` line 2: "Copyright (C) 2026 EZiL <contact@ezil.work>".
//   - the modified-from-Puter sentence is TRADEMARK.md's REQUIRED wording
//     (quoted in `PUTER-PROVENANCE.md`'s "trademark position" section):
//     "This software is a modified version of Puter software and is not
//     endorsed by Puter Technologies Inc."
//
// There is no dedicated `/source` download route in this app (checked: no
// such route exists under `app/src/app/api` or `app/public`, and adding one
// is outside this task's owned files — `shell/ezil/ui/Settings/**`,
// `shell/ezil/apps/registry.js`, `shell/PUTER-PROVENANCE.md` only). So the
// "how to get the source" offer here is the honest one available without
// touching a file this task does not own: the published contact address,
// plus the two documents (`NOTICE`, `ATTRIBUTIONS.md`) that already exist in
// the repository and are the authoritative record of what this build
// contains. A future task can turn that into an actual download endpoint;
// this tab does not pretend one exists today.

const ABOUT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 8v.01"/></svg>';

const AGPL_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';
const PUTER_URL = 'https://github.com/HeyPuter/puter';
const CONTACT_EMAIL = 'contact@ezil.work'; // NOTICE, line 2 — see header.

function shellVersion () {
    const v = globalThis.ezil?.version;
    return (typeof v === 'number' || typeof v === 'string') ? String(v) : '1';
}

export default {
    id: 'about',
    label: 'About',
    icon: ABOUT_ICON,

    html () {
        return `
            <div class="ezil-settings-about">
                <h3>EZiL OS</h3>
                <p class="ezil-settings-about-version">Shell version ${html_encode(shellVersion())}</p>

                <section class="ezil-settings-section">
                    <h4>Licence</h4>
                    <p>
                        EZiL OS is licensed under the
                        <a href="${AGPL_URL}" target="_blank" rel="noopener noreferrer">GNU Affero General
                        Public License v3.0</a> (AGPL-3.0-only). If you interact with this software over a
                        network, you are entitled to receive its complete corresponding source code,
                        including EZiL's modifications.
                    </p>
                    <p>
                        This shell is a modified fork of
                        <a href="${PUTER_URL}" target="_blank" rel="noopener noreferrer">Puter</a>
                        (also AGPL-3.0-only). <strong>This software is a modified version of Puter software
                        and is not endorsed by Puter Technologies Inc.</strong> Puter is a trademark of
                        Puter Technologies Inc.; EZiL OS is not affiliated with, sponsored by, or endorsed
                        by Puter Technologies Inc., and carries none of its logos or marks. The file-by-file
                        record of what was taken from Puter and what changed is this repository's
                        <code>shell/PUTER-PROVENANCE.md</code>.
                    </p>
                </section>

                <section class="ezil-settings-section">
                    <h4>Source</h4>
                    <p>
                        To request a copy of this deployment's complete corresponding source, contact
                        <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. This repository's own
                        <code>NOTICE</code> and <code>ATTRIBUTIONS.md</code> are the authoritative record of
                        what it contains and under which licences.
                    </p>
                </section>
            </div>`;
    },
};
