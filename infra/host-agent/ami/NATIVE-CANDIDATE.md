# Private native Host candidate payload

The normal Image Builder component installs the public Host, OCI prerequisites
and desktop lower images. The separate `imagebuilder-native-component.yaml` is
for a reviewed candidate recipe following that base component. Its build role
needs read access to exactly one private object, the retained reviewed archive
named by its SHA-256. The current build role admits only
`ami/host-agent-*.tgz`. Review the candidate recipe and the exact additional
object grant before building. Keep the archive separate from the public agent
source bundle. Keep upload and download custody within the approved artifact
scope.

The component downloads to a root-private staging directory. It installs
only the pinned archive, inventory, runtime manifest and rootfs template at
`/opt/ezil-native`. It verifies the separately installed public Host driver.
The pinned `runtime/node` must execute directly as Node 24.15.0 with ABI 137 and
the same `/proc/self/exe` and `process.execPath`. The archived loader wrapper
remains unused by the driver. The Claude entry point must report version
2.1.310. Validation reads the installed bytes again and checks that private
download staging was removed.

The install receipt is `/opt/ezil-native/candidate-install.json` and is root-only.
The existing Host configuration keeps its prior settings and gains the exact
runtime, manifest and template pins with native admission disabled. This
component is independent of the candidate distribution, environment pointer
and production promotion workflows.

The target's boot, guard, enrollment and placement determine qualification.
The pinned Gateway CA and SPKI, approved native resource layout and signed
placement receipt belong to the reviewed target configuration and
qualification process. The image build creates no witness, lease, workspace
copy, enrollment data or control key. Review the candidate image validation and
single-target transition receipts before using that target's qualification
command.

For a single-computer pilot, the Host release must include the inert
`ezil-native-qualification.timer` and service. The candidate configuration
must scope `nativeQualificationComputerId` to the exact approved computer.
Enable that timer only in the pilot candidate after reviewing its trusted
Host configuration. The matching OS app scope requires that computer UUID,
the canonical owner UUID and the new exact EC2 instance ID observed in
current placement. The regular Host build and this payload component do
not enable the timer.

The isolated candidate synth uses the existing AMI config shape with
`"nativeCandidate": true` as an explicit opt-in. Supply a reviewed absolute
config to `EZIL_AMI_CONFIG` and run `npm run synth:ami` from
`infra/app-computers`. Synthesis uses offline inputs. The result names a
separate `-native-candidate` stack, build role/profile, component recipe,
pipeline and private image distribution. It derives the exact runtime key in
the namespace-owned asset bucket and grants that candidate build role
`s3:GetObject` only for that additional object. The ordinary AgentSrc and ECR
inputs keep their existing rules. Asset custody is a separate approval.
