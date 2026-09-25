# Private Reticle build and acceptance

This is one reviewed recipe for Reticle commit
`39cc34a84bfb78023154c9f4e99c61f3cbe8fc19`. It produces a local Linux/amd64 image
and verifies real Reticle operations against its React example. It does not
publish a marketplace release, provision AWS, sign provenance, or provide the
finished Reticle integration window.

Prerequisites: Node 24, npm, Git, Docker with BuildKit and Linux/amd64 support,
and sufficient local disk/memory for one 4 GiB builder and two 768 MiB test
containers. Run from the EZiL checkout. No `app/.env` or cloud credentials are
needed. Never mount credentials or a Docker socket into the builder.

```sh
npm --prefix supervisor ci --ignore-scripts
reticle_task="$(mktemp -d /tmp/ezil-reticle.XXXXXX)"
git clone --filter=blob:none --no-checkout https://github.com/reticlehq/reticle.git "$reticle_task/source"
git -C "$reticle_task/source" fetch origin 39cc34a84bfb78023154c9f4e99c61f3cbe8fc19
node supervisor/reticle/build.mjs "$reticle_task/source" "$reticle_task/build"
```

The output directory must not already exist and must be outside EZiL. The
recipe archives only the pinned commit, ignoring local changes and untracked
files. It prepares pnpm 10.33.2 before installing the server and React fixture
workspace closures with the frozen lockfile and lifecycle hooks disabled.
Package retrieval uses network access for this public recipe. Compilation,
packaging, and the import check run without network, as UID 1000 with bounded
CPU, memory, processes, and a 15-minute total deadline. There is no dependency
cache shared with other jobs. Private-source intake still requires the planned
egress controls and credential-isolation validation.

Packaging uses pnpm's injected-workspace deployment mode; the legacy offline
mode re-resolves peer metadata and failed during validation. The original
source lockfile is checked before and after building. The independent artifact
verifier checks bounded contents, license files, the expected package/entry
point, and symlink containment. It rejects native `.node` modules and special
files without executing the artifact. Its digest binds paths, modes, links,
and file contents. `build.json` records source/lock pins, recipe hash, artifact
digest, image IDs, and the retained fixture work volume. It is unsigned local
build evidence, not trusted release provenance.

Run acceptance using the recorded images and workspace:

```sh
npm --prefix supervisor/reticle/acceptance ci --ignore-scripts
npm --prefix supervisor/reticle/acceptance exec -- playwright install chromium
export EZIL_RETICLE_IMAGE="$(node -e 'console.log(require(process.argv[1]).runtimeImage)' "$reticle_task/build/build.json")"
export EZIL_RETICLE_BUILDER_IMAGE="$(node -e 'console.log(require(process.argv[1]).builderImage)' "$reticle_task/build/build.json")"
export EZIL_RETICLE_WORK_VOLUME="$(node -e 'console.log(require(process.argv[1]).workVolume)' "$reticle_task/build/build.json")"
export EZIL_RETICLE_EVIDENCE_DIR="$reticle_task/evidence"
npm --prefix supervisor/reticle/acceptance test
```

The suite creates two fresh computer volumes and permanent separate internal
networks. Named-volume mounts use `volume-nocopy`: Docker must not overwrite a
fresh directory's provisioned ownership with the image's root-owned directory.
Trusted fixed-destination TCP proxies expose random loopback ports for the
local browser; applications have no public network. These proxies are test
infrastructure, not the production Cloudflare authorization path.

Acceptance checks:

- Anonymous and cross-installation credentials fail; own credentials work.
- Containers cannot reach metadata, public internet, or the other computer.
- The real `reticle_look`/`reticle_act.click` tools change the rendered counter
  from 0 to 1, confirmed through both Reticle and Playwright.
- Observed stop/start and replacement retain the private pairing token and
  acknowledged journal bytes, then perform the real operation again using the
  same image. `.git`, renames, and deletions remain intact.
- The other computer has no first-computer sessions or files. Startup with
  missing mounts fails.

The suite always removes its own runtime containers, networks, and data
volumes. Missing prerequisites and cleanup failures fail the command instead
of skipping tests. Screenshots and `result.json` remain in the evidence
directory, without pairing tokens or private file contents.

The successful build retains its local image, artifact, logs, and fixture
work volume so reopening can use the same artifact. When finished, remove
only the volume and images identified by that build's `build.json`; do not
run a broad Docker prune. Failed builds remove their job containers/volume.

The fixture explicitly authorizes instrumentation as part of this private
test. User projects need a separate Connect action. Production instrumentation
must use an approved HTTPS/WSS address and the supported explicit
`reticle.connect({ url, token, allowNonLocalhost: true })` path with Vite's
automatic injection disabled; browser `localhost` is only correct here because
the test browser and loopback proxies run on the same developer machine.

EC2/EBS recovery, power-loss durability, billing cessation, production launch
authorization, public hosting rights, and the actual OS window remain separate
acceptance gates.
