# Protocol3 local native artifact receipt

Source d19bcc1e7fe0d1e87ab033dbd55283f39c1a18d0, tree41c6eef53bc249ef8aa395468b6cb84433fd1f76. Based on native harness38ea45b4 plus B51c4f9cd0335f9483fb13d3d475f087e565874f9 cherry-picked -x as58343d16, then per-run Chromium executable/args support. No mutable B files copied.

Bounded independent review of B51c4f9cd: effort flag admission now precedes any storage/key consumption, including stale protocol3 lease evidence. Disabled effort mutation retries refuse; read-only get_control remains reconciliation path. Protocol2 returns actual legacy model readback; protocol3 retains mismatch uncertainty. Legacy create/configure classification is explicitly selected by request protocol. No new blocker found in this correction; this does not independently approve my provider/harness code.

Combined checks: extension typecheck PASS; provider-effort/provider/effort/chat-bridge-client/chat-bridge-mixed-version:115pass,0fail,691assertions; real workbench-source fake-service suite46pass,0fail,0skipped. Harness syntax passes. Root's separate actual PG81 result remains80PASS/1FAIL at the time of this receipt, stale kind:start assertion pending B reconciliation/ownership test. No claim of all-PG-green, native persistence or live acceptance.

Bun1.3.14 build-vsix.sh and --check both passed. Tracked VSIX rebuilt in this explicit artifact commit; no source/binary mismatch hidden.

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| ezil-models-0.1.0.vsix | 96002 | 031da7d59b03b06900e2f3d0b2c2f839521fe754716befb51503afc037fa3ac2 |
| embedded dist/extension.js | 269416 | 9de3bc13bb9280037140af109daebe70b8ce29be726c6d881f4c04cc10b9dbe4 |
| embedded package.json | 4835 | 96c845e8f66bb74cc84230189cac7c1f41f73a3b50a736d352a56f6952bbb83d |
| provider-native-source.tar.gz | 35375 | 9b76e1fbb095eb1aa67240389b7729e50df9b9fb8ef31bc46936d9d07dd1f3a1 |

Artifact directory: /data/openclaw/projects/ezil/artifacts/native-protocol3-build-20261111. manifest.json records all ten overlay file hashes, source/tree, VSIX and embedded bytes; extension/ contains exact extracted package/JS. Overlay archive contains final provider.ts, final chat-bridge.js and eight native harness/config/doc files. It is not a complete checkout: use with reviewed base/patch inputs. Test logs retained there.

Native driver supports EZIL_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium and EZIL_CHROMIUM_ARGS_JSON per run. No sandbox-disabling flags by default; explicit disposable-environment acknowledgment required for those flags. Code and fixture may run in internal container, browser outside via localhost forwards. Bare extracted-Code runner remains supported. e2e/CHAT-BRIDGE-EFFORT-NATIVE.md has exact parameters. No native process, Docker, OS service, SQL, live image/host/PR/deploy/paid call or dependency installation occurred.
