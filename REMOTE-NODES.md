# Remote Nodes

The dashboard can aggregate multiple self-hosted GitHub runner machines into one private view.

## Architecture

```text
Remote VPS / Pi A ─┐
Remote VPS / Pi B ─┼─ outbound HTTPS ─► Central Neko Runner Dashboard
Remote VPS / Pi C ─┘
```

Remote nodes do **not** need an inbound web port. The `node-agent` sends a heartbeat to the central dashboard every few seconds.

Each heartbeat contains:

- unique node ID and display name
- runner name and labels
- hostname / OS / architecture / kernel
- host uptime
- CPU count and load averages
- host memory usage
- latest bounded GitHub runner diagnostic log tail

The dashboard also uses the GitHub API for global runner status, busy/idle state, workflow jobs, workflow steps, and GitHub Actions logs.

## 1. Central dashboard

Generate a node secret:

```bash
openssl rand -hex 32
```

Put it in the central `.env`:

```env
DASHBOARD_NODE_SHARED_SECRET=YOUR_64_HEX_SECRET
NODE_ID=central-builder
NODE_NAME=Central GitHub Builder
NODE_LOCATION=Primary VPS
```

Then recreate the stack:

```bash
docker compose down
docker compose build
docker compose up -d --force-recreate
```

The dashboard stores the latest node state in the persistent `dashboard-data` Docker volume.

## 2. Additional runner node

On another AMD64 or ARM64 Linux machine, clone this repository and create its environment file:

```bash
cp .env.node.example .env
```

Remote nodes are intentionally credential-free. GitHub App/PAT credentials and org/repository selection are configured only on the central dashboard.

Remote node configuration:

```env
CENTRAL_DASHBOARD_URL=https://runner-dashboard.example.com
DASHBOARD_NODE_SHARED_SECRET=THE_SAME_SECRET_AS_THE_CENTRAL_DASHBOARD

RUNNER_NAME_PREFIX=uk-vps-02

CENTRAL_DASHBOARD_URL=https://runner-dashboard.example.com
DASHBOARD_NODE_SHARED_SECRET=THE_SAME_SECRET_AS_THE_CENTRAL_DASHBOARD

NODE_ID=uk-vps-02
NODE_NAME=UK Builder 02
NODE_LOCATION=London
```

`NODE_ID` must be unique for every machine.

Each node can classify itself automatically:

```env
NODE_CAPACITY_CLASS=auto
NODE_GPU=auto
```

The fleet adds routing labels according to the detected host:

```text
small  -> neko-lite
medium -> neko-build
large  -> neko-build, neko-heavy
GPU    -> neko-gpu
```

Use those labels in `runs-on` so lightweight jobs use small nodes and builds/GPU jobs use the appropriate larger hosts. The node-agent also pushes the current custom label set to GitHub's runner settings on every reconcile, replacing stale custom labels automatically. GitHub runner selection happens before the workflow steps execute, so this explicit workload label is required for reliable routing.

### Verify the labels in GitHub

After the node-agent reconciles, open the runner in:

```text
GitHub
→ Settings
→ Actions
→ Runners
→ select the runner
```

A small node should include:

```text
neko-any
neko-size-small
neko-lite
```

A medium node should include:

```text
neko-any
neko-size-medium
neko-build
```

A large node should include:

```text
neko-any
neko-size-large
neko-build
neko-heavy
```

GPU-capable nodes additionally include:

```text
neko-gpu
```

Base custom labels such as `docker`, `buildx`, `multiarch`, and `builder` are synchronized at the same time.

The synchronization replaces GitHub's complete custom-label set for the runner. This is intentional: if a server is reclassified from large to small, stale labels such as `neko-heavy` are removed automatically.

GitHub's built-in runner labels (`self-hosted`, operating system, and architecture) are not part of this custom-label replacement.

### Workflow examples

Small/light work:

```yaml
runs-on: [self-hosted, neko-lite]
```

Normal build work:

```yaml
runs-on: [self-hosted, neko-build]
```

Large/heavy work:

```yaml
runs-on: [self-hosted, neko-heavy]
```

GPU work:

```yaml
runs-on: [self-hosted, neko-gpu]
```

Large GPU work:

```yaml
runs-on: [self-hosted, neko-heavy, neko-gpu]
```

Because all organization and personal-repository runners on one physical server still share the node execution lock, these labels control **which physical server GitHub selects**, while the shared lock still limits that server to one active job at a time.

Start the remote stack:

```bash
docker compose -f docker-compose.node.yml up -d
```

Watch the agent:

```bash
docker compose -f docker-compose.node.yml logs -f node-agent
```

A healthy node prints heartbeats similar to:

```text
heartbeat ok: uk-vps-02 -> https://runner-dashboard.example.com (memory 41.2%, load 0.38)
```

## Security

Use HTTPS for `CENTRAL_DASHBOARD_URL` when nodes report over the Internet.

The node agent authenticates with `DASHBOARD_NODE_SHARED_SECRET`. This is separate from the browser dashboard login and should be a different random secret from `DASHBOARD_SESSION_SECRET`.

The agent does not need the dashboard login password and does not receive the dashboard's GitHub token.

The node agent mounts the Docker socket because fleet mode creates, starts, repairs, and removes the per-organization runner containers. Treat the node-agent as host-privileged infrastructure and only use trusted runner images/workflows.

## Offline detection

The central dashboard defaults to:

```env
DASHBOARD_NODE_OFFLINE_SECONDS=45
NODE_HEARTBEAT_SECONDS=15
```

So a node normally becomes visibly offline after about three missed heartbeats.

## Images

The GitHub workflow publishes three multi-architecture images:

```text
ghcr.io/nekosuneprojects/docker-github-runners:latest
ghcr.io/nekosuneprojects/docker-github-runners-dashboard:latest
ghcr.io/nekosuneprojects/docker-github-runners-node-agent:latest
```

Each image is built for:

```text
linux/amd64
linux/arm64
```
