# Governance

How decisions get made in EZiL-OS, who makes them, and how somebody outside the
project becomes somebody inside it.

This describes what is true on 2026-09-04, which is a project with **one
maintainer** and an open door — not a structure it hopes to grow into. Where a
rule here has not been enforced by anything yet, it says so.

Three neighbouring documents own their own subjects and this one does not
duplicate them: conduct is [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), building
and submitting a change is [`CONTRIBUTING.md`](CONTRIBUTING.md), and reporting a
vulnerability is [`SECURITY.md`](SECURITY.md). What the project is trying to
build next, and the measurement that would settle each item, is
[`ROADMAP.md`](ROADMAP.md).

## Maintainers

| Person | GitHub | Role | Scope |
|---|---|---|---|
| MidhunAkash | [@MidhunAkashM](https://github.com/MidhunAkashM) | Lead maintainer | Everything. The only account with admin on `EZiLHQ/ezil-os`. |

That table is the whole list, and stating it plainly is the point. One other
person, [@Thanush-41](https://github.com/Thanush-41), is a member of the `EZiLHQ`
organisation with **read** access; they are not a maintainer and hold no merge
rights. Nobody else has any.

So the bus factor is one. The mitigations are that everything the project knows
is written down in this repository rather than held in one head
([`docs/RUNBOOK.md`](docs/RUNBOOK.md),
[`docs/PLATFORM-NOTES.md`](docs/PLATFORM-NOTES.md)), that the license is
AGPL-3.0 so a fork needs nobody's permission, and that the collaborator path
below is real rather than decorative.

## How decisions are made

**Lazy consensus, with a 72-hour window.** A proposal — a pull request, or an
issue that proposes a change — that has been open for 72 hours with no
unresolved objection is taken as agreed, and a maintainer may merge or act on
it. Anyone may object; an objection is not a veto, but it has to be answered
before the clock counts. "No objection" means nobody said no, not that nobody
noticed: a change that nobody reviewed is merged on the maintainer's own
judgement and the maintainer owns the result.

The 72 hours is a floor for changes that affect other people, not a delay
imposed on obvious ones. Fixing a typo, unbreaking CI, or landing a change
whose entire audience has already reviewed it does not need a waiting period.

Two kinds of change step outside that process:

- **Security findings never go through a public issue.**
  [`SECURITY.md`](SECURITY.md) is the route: a GitHub Security Advisory or
  email. A vulnerability is discussed privately, fixed privately, and disclosed
  when there is something for people to upgrade to. Opening a public issue for
  one is the failure mode this rule exists to prevent.
- **Licensing and provenance changes always need the lead maintainer**, with no
  lazy-consensus path around them. That is [`LICENSE`](LICENSE),
  [`NOTICE`](NOTICE), [`ATTRIBUTIONS.md`](ATTRIBUTIONS.md) and
  [`shell/PUTER-PROVENANCE.md`](shell/PUTER-PROVENANCE.md). This project is a
  modified fork of an AGPL-3.0 upstream and tracks that provenance file by file;
  under-crediting an upstream project is treated as a bug here, not a nitpick
  (the same rule [`CONTRIBUTING.md`](CONTRIBUTING.md) states for pull requests).

## What CODEOWNERS means here

[`.github/CODEOWNERS`](.github/CODEOWNERS) is **review routing, not a veto**. It
decides who GitHub asks for review when a path changes, so that a licensing file
or a workflow does not get merged without the person who cares about it being
told. It does not, on its own, stop a merge.

The comment at the top of that file currently says an owner's approval "is
required before merge". That overstates what will actually be enforced: the
branch ruleset described below deliberately does **not** require code-owner
review, because with one maintainer there is nobody to give it. Where the file
and the ruleset disagree, the ruleset is what runs.

## Becoming a collaborator

There is a path in, and it is deliberately based on merged work rather than on
asking:

1. **Contributor** — you open pull requests. Everyone starts here and most
   people stay here, which is fine.
2. **Triage** — after **three merged, non-trivial pull requests**, a maintainer
   offers you the triage role: label, close and reopen issues, request reviews,
   mark duplicates. Triage carries no write access to the code.
3. **Write** — after sustained review activity, meaning you have been reviewing
   other people's pull requests over time and your reviews have been sound, a
   maintainer offers write access.

"Non-trivial" means a change with a behavioural consequence and a test or a
measurement behind it. Three typo fixes are three welcome contributions and not
a path to triage.

Roles are offered by a maintainer and accepted, never claimed. A role that goes
unused for a long stretch may be handed back by agreement; nobody is removed for
being busy.

**Write access is not a way to push to `main`.** `main` will be
[protected by a ruleset](#merging-into-main) that requires a pull request for
every change — a maintainer's included. Write access means you
can merge one, not that you can bypass the checks.

## Merging into `main`

`main` will be protected by a GitHub repository ruleset: pull requests only,
linear history, no force-pushes, no branch deletion, and a set of required
status checks that must be green before merge — the CI jobs, the DCO sign-off
check, and CodeQL. That ruleset is row `G4` in
[`docs/TASKS.csv`](docs/TASKS.csv); as of 2026-09-04 it does not exist yet, and
`main` has no branch protection at all.

One consequence is worth stating plainly rather than discovering later: **a solo
maintainer cannot approve their own pull request.** GitHub does not offer the
Approve action to a pull request's own author, so there is nobody to give the
approval a rule would demand. So
the ruleset requires **zero approvals**, and the required checks — CI, DCO,
CodeQL — are the gate. That is not a lowered bar dressed up as a policy; it is
the honest one. A required approval count of one, on a project with one
maintainer, would mean either that nothing can ever merge or that the rule is
routinely bypassed, and a rule that is routinely bypassed is worse than no rule.

When there is a second maintainer, the approval count is the first thing to
raise, and raising it is itself a change to this document.

## Releases

A release is a **`v*` tag cut by a maintainer**. Nothing else creates one: not a
green build, not a deploy, not a merge to `main`.

Tagging triggers
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which deploys and
then runs the production suites against what it deployed.
[`CHANGELOG.md`](CHANGELOG.md) states the rule this project holds itself to — *a
green deploy that was never verified is not a release here* — and the pipeline
is arranged so that the verification, not the deploy, is what a release waits
on.

As of 2026-09-04 **no `v*` tag has ever been cut** (`git tag` is empty), so that
pipeline has never run. The first release is therefore also the first exercise
of this rule, and it should be treated accordingly.

## Funding

**EZiL-OS takes no funding and has no GitHub Sponsors tier, and there is
deliberately no `.github/FUNDING.yml`** — a funding button pointing at a handle
nobody watches is worse than no button at all.

## Automation, and reading what it did

Parts of this repository are built by automated workers, and the project's
position is that this is only acceptable if it is auditable. So the definitions,
the plan and the record are all committed, and anyone can read what model did
what:

- **The workers themselves** are committed definitions in
  [`.claude/agents/`](.claude/agents/) — one file per role, each naming the exact
  model and effort level it runs at, and each carrying the same mandatory rules
  about committing increments, owning only its assigned files, and refusing a
  brief it believes is wrong rather than working around it.
- **Their plan** is [`docs/TASKS.csv`](docs/TASKS.csv): every task, the files it
  is allowed to touch, what it depends on, which agent runs it, and the command
  that verifies it.
- **Their record** is [`docs/ORCHESTRATION-LOG.md`](docs/ORCHESTRATION-LOG.md),
  the narrative of what was dispatched, what landed, and what a worker refused —
  quoted, not paraphrased — and [`artifacts/runs/`](artifacts/runs/), one JSON
  artifact per task with the real evidence behind it.

A commit produced this way carries the DCO `Signed-off-by:` line of the
maintainer who dispatched the work, and the rule for this project is that it also
carries a `Co-Authored-By:` trailer naming the model. The sign-off is a human
certification under the
[Developer Certificate of Origin](https://developercertificate.org/), and it does
not become less human because a machine typed the diff: responsibility for what
ships rests with the maintainer who signed it off.
[`CONTRIBUTORS.md`](CONTRIBUTORS.md) says the same thing about authorship.

The trailer half of that rule is **not yet applied consistently** —
`git log --format='%h %(trailers:key=Co-Authored-By,valueonly)'` shows it on the
orchestrating session's own commits and missing from the workers'. Until that is
fixed, the complete record of which model did what is `artifacts/runs/` and the
log, not the trailer.

## Changing this document

This file is changed the way anything else is: a pull request, the 72-hour
window, and a maintainer merge. Changes to the maintainer table, the approval
count, or the licensing-and-provenance rule need the lead maintainer.
