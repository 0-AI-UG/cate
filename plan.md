# Cate Cloud: EC2 Remote Workspaces

## Summary

Cate Cloud will provide paid, remotely hosted development workspaces for users
who do not want multiple terminal CLIs, agents, worktrees, and development
servers consuming local resources.

The initial architecture uses one EBS-backed EC2 instance per cloud workspace.
AWS supplies VM isolation, lifecycle, storage, and networking. Cate supplies the
workspace control plane, durable runtime connection, security policy, billing,
and user experience.

This is intentionally narrower than building a PaaS. Cate will not operate a
hypervisor, host scheduler, distributed volume system, or bare-metal fleet.

```text
Cate desktop
    |
    +-- HTTPS --> Cate Cloud API
    |                +-- Authentication
    |                +-- Workspace lifecycle
    |                +-- PostgreSQL
    |                +-- Provisioning workers
    |                +-- Billing ledger
    |                +-- AWS EC2/EBS APIs
    |
    +-- WSS ----> Cate regional gateway
                          |
                          | outbound mTLS connection
                          v
                EC2 workspace instance
                +------------------------+
                | cate-runner            |
                |   +-- cate-runtime     |
                |       +-- PTYs         |
                |       +-- agents       |
                |       +-- git          |
                |       +-- tunnels      |
                |                        |
                | encrypted EBS data     |
                +------------------------+
```

## Product model

The product must distinguish three concepts:

- **Cloud workspace:** Durable machine identity, filesystem, repository,
  worktrees, settings, and billing owner.
- **Workspace run:** Time during which the EC2 instance is running.
- **Client connection:** A Cate desktop currently attached to the workspace.

| User action | EC2 state | Processes | Files | Compute billing |
| --- | --- | --- | --- | --- |
| Close Cate | Running | Continue | Persist | Continues |
| Lose network | Running | Continue | Persist | Continues |
| Reconnect | Running | Reattach | Persist | Continues |
| Stop workspace | Stopped | Terminated | Persist | Stops |
| Start workspace | Running | Restart | Persist | Starts |
| Pause workspace, later | Hibernated | Frozen | Persist | Stops |
| Delete workspace | Terminated | Terminated | Deleted after retention | Stops |

For v1:

- Disconnecting never stops a workspace.
- Stop performs a normal shutdown and loses process state.
- Auto-stop is disabled.
- Hibernation is deferred until the ordinary lifecycle is reliable.

AWS does not charge EC2 compute while an EBS-backed instance is stopped,
although attached EBS storage remains billable. Running instances are billed
per second with a one-minute minimum. See the
[EC2 instance lifecycle documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html).

## AWS infrastructure

Use separate AWS accounts for the production control plane and workspace data
plane.

### Per region

- One VPC for workspace instances
- Private subnets in at least two Availability Zones
- Outbound NAT or a controlled egress proxy
- Workspace security group with no inbound rules
- Regional gateway service
- ECS/Fargate for the API, workers, and gateways
- RDS PostgreSQL
- S3 for exports and supplemental backups
- EventBridge and SQS for EC2 state events
- ECR for runner images
- CloudWatch for infrastructure metrics

Workspace instances must not be able to reach the production database or
control-plane network. The control plane interacts with them only through the
outbound runner connection.

### Per workspace

Each workspace receives:

- One On-Demand EC2 instance
- An encrypted 12-20 GB root EBS volume
- An encrypted gp3 workspace volume, initially 30-50 GB
- No public inbound ports
- No SSH service
- No instance IAM role
- No AWS credentials
- A stable workspace ID and generation stored as EC2 tags
- IMDSv2 required
- A non-root `cate` user
- `cate-runner` as a root-owned systemd service

Use x86-64 initially for CLI compatibility. Benchmark a burstable 2-vCPU/4-GB
instance against a predictable 2-vCPU/8-GB general-purpose instance before
selecting the paid tiers. Do not use Spot instances for the initial product.

## Storage

Use separate root and workspace volumes:

```text
root EBS
  /usr/local/bin/cate-runner
  operating system
  system packages
  disposable caches

workspace EBS
  /home/cate
  /workspace
  repositories
  worktrees
  .cate state
  agent sessions
  user-level tools
```

This separates durable customer data from the base operating-system image and
allows a workspace to be rebuilt onto a patched AMI without copying its
repository.

Enable EBS encryption by default. EBS encryption covers data at rest, disk
traffic between EC2 and EBS, snapshots, and volumes restored from those
snapshots. See
[How EBS encryption works](https://docs.aws.amazon.com/ebs/latest/userguide/how-ebs-encryption-works.html).

### Backup policy

- Daily incremental EBS snapshot of the workspace volume
- Snapshot before destructive resize or migration
- Initial retention of seven daily and four weekly snapshots
- Optional repository export to S3
- Regular restore drills into a new instance
- Explicit deletion workflow for volumes, snapshots, and exports

Use one KMS key per environment initially. Per-customer keys can be an
enterprise feature.

## `cate-runner`

The runner is the data-plane supervisor. It must:

1. Enrol the EC2 instance with the control plane.
2. Obtain a short-lived runner certificate.
3. Establish an outbound mTLS WebSocket to the regional gateway.
4. Launch and supervise `cate-runtime`.
5. Keep the runtime pipe open while no desktop is connected.
6. Buffer bounded PTY output for reconnect.
7. Report health, runtime version, disk usage, PTY count, and active processes.
8. Accept shutdown and update commands from the control plane.
9. Reconnect to another gateway after gateway failure.
10. Never log terminal contents or environment variables.

For enrolment, the runner submits its signed EC2 instance-identity document.
The control plane verifies:

- AWS signature
- AWS account and region
- Instance ID
- Expected workspace tags
- Current workspace generation
- Instance state

It then issues a short-lived certificate. The certificate and private key are
root-owned. Do not pass a permanent bootstrap secret through EC2 user data.

## Gateway

The gateway connects the desktop to a runner without exposing the VM.

Responsibilities:

- Validate Cate user access tokens
- Validate one-use connection tickets
- Match desktop and runner by workspace and generation
- Forward runtime protocol frames
- Enforce one interactive writer
- Carry port-preview traffic
- Apply byte and connection limits
- Reconnect runners after gateway failure
- Avoid retaining or logging payload contents

A connection ticket must:

- Expire after 30-60 seconds
- Be single-use
- Be bound to user, organization, workspace, generation, and client ID
- Grant either interactive or read-only access

The gateway should not interpret filesystem or terminal operations. It forwards
the existing Cate runtime protocol.

## Durable terminal behavior

The current daemon exits and kills all child processes when its stdin closes.
The runner fixes the network-disconnect case by owning that stdin permanently.

A protocol extension is still required to recover after an application restart:

- `pty.list`
- `pty.attach(ptyId, afterSequence)`
- `pty.detach`
- Sequence numbers on output
- Bounded scrollback per PTY
- Runtime generation in the handshake
- Existing-session metadata: cwd, dimensions, and process state
- Explicit takeover of an existing writer

Recommended limits:

- 4 MB scrollback per terminal
- 64 MB maximum buffered output per workspace
- Discard oldest output first
- Use sequence numbers to communicate any lost interval

| Failure | Expected behavior |
| --- | --- |
| Desktop network interruption | Existing RPC client reconnects |
| Gateway restart | Runner and desktop reconnect; processes continue |
| Cate application restart | Panels attach to persisted PTY IDs |
| EC2 reboot | PTYs are gone; panels open replacement shells |
| Explicit workspace stop | PTYs are gone; files remain |
| EC2 host failure | Instance restarts from EBS; processes are gone |

For Cate Agent panels, v1 can resume from the persisted agent session file after
a full application restart. Reattaching to an already-running in-flight agent
turn is a later protocol extension.

## Runtime distribution and compatibility

Do not bake a single `cate-runtime` version permanently into every AMI.

- Bake a stable runner and base runtime into the AMI.
- Store signed, versioned runtime bundles in S3 or a public release bucket.
- Let the runner download the version requested by the desktop.
- Cache recent compatible versions locally.
- Verify signature and SHA-256 before execution.
- Support at least the current and previous desktop runtime versions.
- Roll out runner updates independently from desktop releases.

The existing `RuntimeTransport` abstraction remains the integration boundary.
Add an `Ec2ManagedTransport` without changing filesystem, git, terminal, and
editor consumers.

## Cate desktop changes

### Shared types

Add a cloud connection type:

```ts
type RuntimeConnection =
  | ExistingConnections
  | {
      kind: 'cloud'
      runtimeId: string
      cloudWorkspaceId: string
      region: string
      remotePath: '/workspace'
    }
```

Cloud connection records must remain secret-free.

Add a cloud infrastructure phase separate from `RuntimePhase`:

```ts
type CloudWorkspacePhase =
  | 'provisioning'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'failed'
  | 'deleting'
```

A running VM may have a disconnected runtime channel, and a stopped VM is not an
unreachable host. These states must not be combined.

### Main process

Add:

- `Ec2ManagedTransport`
- Cloud authentication and token storage
- Cate Cloud API client
- Short-lived connection-ticket retrieval
- Runner/gateway reconnect logic
- Cloud workspace IPC handlers
- PTY attach support

### Renderer

Add:

- Cate account login
- Cloud workspace creation
- Repository picker
- Region and machine-size selection
- Start and stop controls
- Running-cost indicator
- Runtime reconnect state
- Usage and budget page
- Delete, export, and restore flows

Keep SSH and WSL as separate bring-your-own-host options.

## Repository access

Use a GitHub App rather than customer personal access tokens.

1. User installs the Cate GitHub App for selected repositories.
2. Control plane creates the workspace.
3. Runner requests a short-lived installation token.
4. Repository is cloned into `/workspace`.
5. A Cate credential helper requests fresh tokens for later fetch and push
   operations.

Do not save installation tokens in `.git/config`, shell history, or EBS.

For v1:

- GitHub repositories only
- HTTPS clone and push only
- One primary repository per workspace
- Worktrees managed normally inside the workspace volume

GitLab, SSH remotes, deploy keys, and arbitrary repository hosts follow later.

## AI and CLI credentials

### Service-minted credentials

Examples include GitHub App installation tokens.

- Mint on demand
- Keep lifetimes short
- Avoid persistence
- Refresh through the runner

### User-provided credentials

Examples include OpenAI, Anthropic, npm, and private registry credentials.

For v1:

- Cate desktop remains the credential authority.
- Deliver secrets after connection.
- Store them in a root-created tmpfs owned by `cate`.
- Remove them when the workspace stops.
- Require Cate to reconnect and inject credentials after a normal restart.

Running user code can read credentials intended for that user. The security
promise is tenant isolation, not isolation between a user's agent and that
user's credentials.

An opt-in cloud vault can be added later for unattended starts.

## Port previews

Do not add inbound security-group rules for development servers.

1. Cate detects a listening port.
2. User selects **Open preview**.
3. Gateway opens a tunnel through the runner.
4. BrowserPanel receives a Cate-authenticated URL.
5. Gateway checks workspace membership on every connection.

Preview defaults:

- Private
- Short-lived
- HTTPS at the gateway
- WebSocket-compatible
- Rate-limited
- Revoked when the workspace stops

Public sharing is a separate future feature with explicit confirmation and
expiry.

## Control plane

Recommended components:

- TypeScript API service
- PostgreSQL
- SQS provisioning queue
- Reconciliation workers
- EventBridge instance-state consumer
- Stripe integration
- AWS provider module

Core tables:

```text
users
organizations
memberships
cloud_workspaces
workspace_members
workspace_instances
workspace_generations
connection_tickets
usage_segments
provider_operations
snapshots
audit_events
billing_customers
```

Important workspace fields:

```text
id
organization_id
region
availability_zone
instance_id
instance_type
root_volume_id
data_volume_id
desired_state
observed_state
generation
runtime_version
last_runner_heartbeat_at
started_at
stopped_at
deleted_at
```

Every mutating provider operation must be idempotent:

- Stable operation IDs
- EC2 `ClientToken` where supported
- Database uniqueness constraints
- Desired/observed state reconciliation
- Retry with bounded backoff
- Periodic `DescribeInstances` reconciliation

An EC2 API timeout must not be interpreted as proof that the operation failed.

## Billing

Internally meter:

- Running instance seconds by Cate size
- Allocated EBS GB-hours
- Snapshot GB-months
- Internet egress
- Optional preview egress

Authoritative compute lifecycle:

1. Open a usage segment when EC2 becomes `running`.
2. Close it on `stopping`, `stopped`, or `terminated`.
3. Consume EventBridge events for responsiveness.
4. Reconcile against EC2 every minute.
5. Make ledger events idempotent.
6. Send aggregated usage to Stripe.

AWS Cost Explorer and invoices are for COGS reconciliation, not real-time
customer billing.

Expose product-level sizes rather than EC2 instance names:

```text
Standard: 2 vCPU / 4 GB / 30 GB
Large:    2 vCPU / 8 GB / 50 GB
Compute:  4 vCPU / 8 GB / 50 GB
```

Show users:

- Current running rate
- Included monthly hours
- Overage
- Storage usage
- Monthly spending limit

Never silently stop a running agent at a budget threshold. Send warnings and let
users choose whether their cap is advisory or enforced.

## Security

Minimum launch posture:

- Workspace instances in a separate AWS account from the control plane
- No instance IAM role
- No inbound security-group rules
- IMDSv2 required
- No Docker socket
- Non-root user without sudo
- Encrypted EBS by default
- Per-workspace mTLS runner certificate
- Cross-workspace access denied
- SMTP blocked
- Private and control-plane CIDRs unreachable
- PID and file-descriptor limits
- Disk quotas and alarms
- No terminal-content logging
- Abuse reporting and immediate suspension tooling
- Payment verification before provisioning

Security groups are allow-only, so advanced egress filtering requires a proxy,
Route 53 DNS Firewall, or AWS Network Firewall rather than security groups alone.

## Quotas and capacity

New AWS accounts often begin with only five Standard On-Demand vCPUs per region.
Request quota increases well before inviting users. See
[EC2 instance type quotas](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html).

Track:

- Regional On-Demand vCPU quota
- Running and stopped instance counts
- EBS volume and snapshot quotas
- Public/NAT egress capacity
- Subnet IP space
- Gateway connections
- Provisioning failure rate
- Instance-type availability

Support Availability Zone fallback. Region fallback requires user consent
because it changes latency and data residency.

## Delivery milestones

### Milestone 1: Vertical slice

Scope:

- One AWS region and Availability Zone
- Hard-coded instance type
- Public GitHub repository
- Create, start, connect, stop, and delete
- EBS persistence
- Basic terminal and filesystem access
- Manual admin-only provisioning

Success criteria:

- A repository survives stop and start.
- Terminal commands execute through the managed transport.
- Stopping closes the compute usage segment.
- No inbound instance ports exist.

### Milestone 2: Durable terminals

Scope:

- Runner supervision
- Gateway reconnect
- PTY list and attach
- Scrollback sequence numbers
- Desktop restart recovery
- Workspace status UI

Success criteria:

- Ten terminal CLIs survive a 30-minute desktop disconnect.
- A gateway restart loses no processes.
- Reconnection neither duplicates nor silently reorders buffered output.

### Milestone 3: Paid private beta

Scope:

- Cate login
- GitHub App
- Private repositories
- Machine-size selection
- Secret injection
- Port previews
- Usage ledger and Stripe
- Spend alerts
- Encrypted snapshots
- Admin suspension tooling

Success criteria:

- Provider usage and Cate's ledger reconcile within an agreed tolerance.
- A user cannot access another workspace, preview, volume, or runner.
- Delete removes the instance, active volume, credentials, and scheduled
  backups according to policy.

### Milestone 4: Production hardening

Scope:

- Multi-AZ gateways and control plane
- Second AWS region
- AMI and runtime canary rollout
- Automated backups and restore drills
- Quota monitoring
- Capacity fallback
- Abuse detection
- Incident runbooks
- Load and chaos testing
- Optional hibernation

Success criteria:

- 100 concurrent workspace starts do not create duplicate instances.
- Gateway failover completes without terminating PTYs.
- A failed AMI rollout can be rolled back without touching workspace data.
- Control-plane compromise does not yield shell access through a reusable
  instance credential.

## Explicitly out of scope for v1

- Kubernetes
- Fargate workspace tasks
- Spot instances
- GPU workspaces
- Windows workspaces
- Docker-in-Docker
- Root or sudo access
- Team co-editing
- Public port sharing
- Arbitrary custom AMIs
- Automatic idle stopping
- Hibernation
- Multi-cloud scheduling
- Self-hosted hypervisors

## Initial commercial-quality goal

A user can create an EC2-backed workspace, run several CLI agents, close Cate,
reconnect later to the same PTYs, and stop the workspace knowing compute billing
has ended while the repository and worktrees remain intact.
