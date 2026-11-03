# universe-repo-open-v1: pinned vectors

Contract: `docs/contracts/universe-repo-open-v1.md` (contractVersion `1.0.3`).
Canonical vectors: `docs/contracts/universe-repo-open-v1.vectors.json` in EZiL-OS.

Pinned vectors sha256: `88bf93b15afdf25962eb8990ca6e6598f08cd704e30fae2f6c5ac0b603e9ad7c`

Pinned gateway extract sha256: `d72f92e0e59658b17b11eb38163fb3f8e2065cbcbc92d284ab6c2fb78e2ae9e4`

## Check (EZiL-OS)

```sh
node docs/contracts/universe-repo-open-v1.check.mjs
/root/.bun/bin/bun docs/contracts/universe-repo-open-v1.check.mjs
```

Exit 0 means every vector case passed, the vectors file's sha256 equals the first line above, and the derived gateway extract's sha256 equals the second. The script has no dependencies and makes no network call. Its reference functions are the executable reading of the contract: a lane test that disagrees with one of them is a bug in the lane or a contract change for the lead, never a reason to edit the vectors.

## Copies in other repositories

EZiL-Works and universe-2.0 (private) each commit a byte-identical copy of the full vectors:

```
contracts/universe-repo-open-v1.vectors.json      (at the repository root)
```

EZiL CLI is public, so it never receives the full vectors (they name the production and preview database hosts). It commits only the gateway extract, which check.mjs derives from a fixed key list (`gatewayExtract` in the vectors) and which carries no database, Supabase or IP host:

```sh
node docs/contracts/universe-repo-open-v1.check.mjs --emit-gateway-extract > "<EZiL CLI>/contracts/universe-repo-open-v1.gateway.json"
```

The command writes the extract to stdout only when every check passes (status lines go to stderr). Check the copy's sha256 against the second pinned line before committing it.

1. Copy the bytes; never reformat. Add `contracts/universe-repo-open-v1.vectors.json -text` (EZiL CLI: `contracts/universe-repo-open-v1.gateway.json -text`) to `.gitattributes` so EOL normalisation cannot change the hash.
2. Add one test that reads the copy and asserts its sha256 equals the matching pinned value above. The test FAILS (never skips) when the file is missing or differs.
   - Works: a `bun:test` file under the owning lane's paths, run by `./tools/test.sh`.
   - Universe: a PHPUnit unit test reading `base_path('../contracts/universe-repo-open-v1.vectors.json')` (`tools/test.sh` mounts the repo root at /var/www).
   - EZiL CLI: a `bun:test` file under `apps/git-gateway/src/`, asserting the gateway extract's sha256.
3. Tests that need a constant or case read it from the copy. Code that must hold a constant at runtime (PHP, Python, Worker bundles) keeps its own literal and a test compares it to the copy.
4. Expand `${repeat:<char>:<count>}` before using any string. Grant-shaped strings are never written literally, so secret scanners stay quiet.
5. Regex sources are JavaScript. PHP: wrap as `\A…\z` (PHP `$` also matches before a final newline). Python: `re.fullmatch`. Every regex has a trailing-newline invalid case that catches the mistake.

## Who changes it

Only the lead. Before the first seed commit into another repository, the lead may correct the vectors without a version bump (nothing consumes them yet). After it, a change bumps `contractVersion`, reruns the check, updates both sha256 lines above, and replaces every copy (vectors and gateway extract) in the same change. Lane workers never edit the vectors, a copy, the extract, or this file; a disagreement goes to the lead.
