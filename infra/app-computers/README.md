# Application computer foundation

This CDK stack defines shared pilot resources for future AWS-backed EZiL-OS computers. It synthesizes one VPC/public subnet, an inbound-closed security group, an immutable ECR image repository, a host-only instance role/profile, and a launch template. It creates **no computer, data volume, snapshot, tunnel, or public application service**. Existing Cloudflare computers are unaffected.

The public subnet provides outbound HTTPS for the Cloudflare Tunnel, ECR, and SSM without a NAT gateway that bills while all computers are stopped. The security group has no inbound rules. It permits outbound TCP 443 and candidate TURN port 3478 over UDP/TCP; actual Cloudflare Realtime TURN connectivity, eight-hour media sessions, and the host firewall must pass the pilot before deployment. Application containers need their own approved egress controls. The host role can pull approved images and use SSM; it has no EC2/EBS lifecycle permission. IMDSv2 is required with hop limit 1 because only host processes should use instance credentials. Container networks must additionally block the metadata endpoint.

The approved Linux/amd64 supervisor AMI ID is a required deployment parameter. Verify its root device name is `/dev/xvda` and that it starts the authenticated supervisor with a fail-closed mount dependency. The launch template makes the 30 GiB root gp3 volume encrypted and disposable. The lifecycle controller must separately create a 50 GiB encrypted gp3 **data volume per computer**, set `DeleteOnTermination=false`, tag and record its exact ID/AZ, fence the old writer, observe detach, and mount it before Browser, Code, or apps start. It must also provide daily encrypted snapshots with seven recovery points and an application-consistent hook for database state. Neither the template nor a successful synth proves that lifecycle behavior.

Run locally:

```sh
cd infra/app-computers
npm ci
npm run typecheck
npm test
npm run synth
```

Do not deploy this stack until the controller, supervisor AMI, scoped deployment identity, approved region/account, TURN path, and spending ceiling have been reviewed. A production CDK change requires a synth and `cdk diff` against the actual account; no hotswap or express deployment. ECR images, retained EBS capacity, snapshots, public IPv4 while instances run, and logs can incur charges even when computer compute is stopped. The shared VPC has no NAT gateway charge.

References: [EBS volumes](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volumes.html), [preserving volumes on termination](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/preserving-volumes-on-termination.html), [EBS encryption](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-encryption.html), and [EBS pricing](https://aws.amazon.com/ebs/pricing/).
