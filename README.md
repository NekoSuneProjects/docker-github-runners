# Neko GitHub Docker Runner

A lightweight self-hosted GitHub Actions runner focused on building and pushing Docker images.

It runs natively on:

- Linux AMD64 / x86_64
- Linux ARM64 / aarch64

The runner image is intentionally kept small so it can be rebuilt quickly.

## What is installed in the runner

- GitHub Actions self-hosted runner
- Docker CLI
- Docker Buildx
- Docker Compose plugin
- Git
- Git LFS
- curl
- jq
- SSH client
- basic archive/runtime utilities required by Actions

## What is NOT installed

The following heavy build environments were deliberately removed for now:

- GCC / G++ build toolchains
- Clang / LLVM
- CMake / Ninja / Meson
- Linux cross-compilers
- MinGW / Windows cross-compilers
- Rust
- Go
- system Node.js/npm/yarn/pnpm
- Java / Maven / Gradle
- .NET SDKs
- Python development environments
- Ruby development tools
- PHP / Composer development tools
- QEMU packages inside the runner image

Your application dependencies should normally be installed **inside the Docker image being built**, not inside this GitHub runner.

GitHub JavaScript Actions still work because the official Actions runner package carries the runtime it needs.

## Multi-platform Docker images

The runner is designed to work with:

```yaml
- uses: docker/setup-qemu-action@v3
  with:
    platforms: amd64,arm64

- uses: docker/setup-buildx-action@v3
```

QEMU/binfmt is installed on the Docker host by the GitHub Action when required, so the runner container does not need the large QEMU package set baked into it.

Example:

```yaml
jobs:
  docker:
    runs-on:
      - self-hosted
      - linux
      - docker
      - buildx

    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-qemu-action@v3
        with:
          platforms: amd64,arm64

      - uses: docker/setup-buildx-action@v3

      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ghcr.io/YOUR_ORG/YOUR_IMAGE:latest
```

Default custom runner labels are:

```text
docker
buildx
multiarch
builder
```

GitHub also automatically adds the normal `self-hosted`, OS, and real architecture labels.

## Automatic Docker socket permissions

Compose mounts:

```text
/var/run/docker.sock
```

The runner automatically reads the socket GID on startup, finds or creates a matching group inside the container, adds the `runner` account to it, verifies read/write access, and then drops root privileges.

You do not need to manually configure `DOCKER_GID`.

## GitHub runner updates

`start.sh` checks for the latest stable `actions/runner` release whenever the container starts.

The startup updater:

1. detects AMD64 or ARM64
2. checks the current installed runner version
3. downloads the matching latest stable release when required
4. validates the archive and SHA256 when GitHub exposes a digest
5. updates the runner files
6. registers with GitHub
7. starts accepting jobs

GitHub's own runner auto-update mechanism remains enabled too.

## Organization / multiple repositories

For one runner shared by repositories in an organization:

```env
RUNNER_SCOPE=organization
GITHUB_ORG=YOUR_GITHUB_ORG
```

Typical runner labels:

```env
LABELS=docker,buildx,multiarch,builder
```

## Dashboard control plane and credential broker

The recommended architecture keeps all long-lived GitHub credentials on the central dashboard.

```text
GitHub App private key / PAT
          │
          ▼
  Central Dashboard
  - discovers allowed orgs/repos
  - mints App installation tokens
  - talks to GitHub runner APIs
  - removes stale registrations
  - synchronizes labels
  - creates runner registration tokens
          │
          │ HTTPS + DASHBOARD_NODE_SHARED_SECRET
          ▼
      Worker nodes
  - no GitHub App private key
  - no PAT
  - no installation token
  - receive only short-lived runner registration tokens
  - execute workflow jobs
```

Remote nodes therefore need only the dashboard URL, a node authentication secret, and their local capacity settings. GitHub organization/repository selection is centralized on the dashboard.

## GitHub authentication modes

The fleet supports two authentication modes:

```env
GITHUB_AUTH_MODE=token
ACCESS_TOKEN=github_pat_...
```

or the recommended multi-account GitHub App mode:

```env
GITHUB_AUTH_MODE=app
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_BASE64=...
```

In App mode the dashboard signs GitHub App JWTs, discovers installations, mints/caches installation access tokens, and performs GitHub runner-management API calls. Worker nodes receive only short-lived runner registration tokens. The App private key, PATs, and installation tokens never leave the dashboard.

See [GITHUB-APP.md](GITHUB-APP.md) for App creation, permissions, installation and configuration.

## Multi-organization physical nodes

Remote nodes can now serve multiple GitHub organizations without deploying one node stack per organization.

```env
GITHUB_ORGS=auto
RUNNER_NAME_PREFIX=uk-vps-02
```

`GITHUB_ORGS=auto` discovers active organizations where the authenticated GitHub user has the organization admin role. You can also use an explicit comma-separated list.

The dashboard tells each node-agent which organization/repository runner registrations to maintain, but all runners on the same physical node share **one execution slot**. If Org A is already running a job and GitHub assigns a job from Org B, Org B waits in the job-start hook until Org A completes. This prevents two organizations from building on the same VPS/Pi at the same time.

Use `GITHUB_ORG_INCLUDE` and `GITHUB_ORG_EXCLUDE` to filter automatic discovery.

Personal accounts are supported too. GitHub does not provide a personal-account-wide self-hosted runner scope, so the fleet discovers repositories owned by the authenticated user and creates a repository-scoped runner for each one:

```env
GITHUB_PERSONAL_REPOS=auto
GITHUB_PERSONAL_REPO_INCLUDE=
GITHUB_PERSONAL_REPO_EXCLUDE=
GITHUB_PERSONAL_INCLUDE_ARCHIVED=false
```

Organization runners and personal repository runners all use the same physical-node job lock, so the node still executes only one workflow job at a time regardless of which account owns the repository.

## Automatic node sizing and workload routing

Fleet nodes automatically classify their physical host from CPU and RAM and add runner labels that workflows can target:

```text
small   -> neko-size-small,  neko-lite
medium  -> neko-size-medium, neko-build
large   -> neko-size-large,  neko-build, neko-heavy
GPU     -> neko-gpu
all     -> neko-any
```

Default classification is:

```text
small:  CPU <= 2 OR RAM <= 4 GB
large:  CPU >= 8 AND RAM >= 16 GB
medium: everything in between
```

GPU capability is detected from the host Docker runtime's NVIDIA support. You can override detection with `NODE_CAPACITY_CLASS=small|medium|large` and `NODE_GPU=true|false`.

GitHub selects a self-hosted runner before workflow steps execute, so the workflow must state the workload class it needs. The fleet also actively synchronizes these custom labels into GitHub Settings → Actions → Runners on every reconcile cycle, so changing a node from small to medium/large or enabling GPU updates the visible GitHub runner labels automatically. For example:

```yaml
jobs:
  ping-api:
    runs-on: [self-hosted, neko-lite]
    steps:
      - run: curl -f https://example.com/health

  build-app:
    runs-on: [self-hosted, neko-build]
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t app .

  huge-build:
    runs-on: [self-hosted, neko-heavy]
    steps:
      - uses: actions/checkout@v4
      - run: docker buildx build --platform linux/amd64,linux/arm64 .

  gpu-job:
    runs-on: [self-hosted, neko-gpu]
    steps:
      - run: docker run --rm --gpus all nvidia/cuda:latest nvidia-smi
```

That keeps curl/API/check jobs on small VPS nodes and prevents heavy/GPU workflows from landing on undersized machines.

### GitHub runner label synchronization

The node-agent does not rely only on the labels passed during runner registration. On every fleet reconcile it asks the dashboard broker to synchronize the real GitHub runner's **custom label set** through the GitHub Actions API.

That means the labels visible in:

```text
Repository or Organization
→ Settings
→ Actions
→ Runners
→ Runner details
```

stay synchronized with the physical server.

Examples:

```text
Small VPS:
self-hosted
linux
x64
docker
buildx
multiarch
builder
neko-any
neko-size-small
neko-lite
```

```text
Medium VPS:
self-hosted
linux
x64
docker
buildx
multiarch
builder
neko-any
neko-size-medium
neko-build
```

```text
Large VPS:
self-hosted
linux
x64
docker
buildx
multiarch
builder
neko-any
neko-size-large
neko-build
neko-heavy
```

A GPU-capable node also receives:

```text
neko-gpu
```

If a node changes size class, GPU support changes, or the configured base labels change, the next fleet reconcile replaces the GitHub custom labels with the new desired set. Stale custom labels are therefore removed automatically.

GitHub's built-in labels such as `self-hosted`, `linux`, `x64`, and `arm64` remain managed by GitHub and are not replaced by the custom-label synchronization.

### Choosing a runner class in workflows

Use the routing labels in `runs-on`.

Lightweight API calls, webhooks, curl checks, and simple scripts:

```yaml
jobs:
  health-check:
    runs-on: [self-hosted, neko-lite]
    steps:
      - run: curl -fsS https://example.com/health
```

Normal builds and Docker builds:

```yaml
jobs:
  build:
    runs-on: [self-hosted, neko-build]
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t my-app .
```

Large compiles or expensive multi-architecture builds:

```yaml
jobs:
  heavy-build:
    runs-on: [self-hosted, neko-heavy]
    steps:
      - uses: actions/checkout@v4
      - run: docker buildx build --platform linux/amd64,linux/arm64 .
```

GPU workloads:

```yaml
jobs:
  gpu-build:
    runs-on: [self-hosted, neko-gpu]
    steps:
      - run: nvidia-smi
```

You can combine labels when a workload needs more than one capability:

```yaml
runs-on: [self-hosted, neko-heavy, neko-gpu]
```

This requires a large GPU-capable runner instead of any GPU node.

### Capacity overrides

Automatic detection can be overridden per physical node:

```env
NODE_CAPACITY_CLASS=auto
NODE_GPU=auto
```

Valid manual values are:

```env
NODE_CAPACITY_CLASS=small
NODE_CAPACITY_CLASS=medium
NODE_CAPACITY_CLASS=large

NODE_GPU=true
NODE_GPU=false
```

Thresholds can also be changed:

```env
NODE_SMALL_MAX_CPU=2
NODE_SMALL_MAX_RAM_GB=4
NODE_LARGE_MIN_CPU=8
NODE_LARGE_MIN_RAM_GB=16
```

## Central dashboard

The main Compose stack also contains the private Neko Runner Dashboard.

It can show:

- online/offline/busy GitHub runners
- active workflow jobs
- recent workflow runs
- repository, branch and actor
- individual jobs and steps
- failed steps
- searchable GitHub Actions logs
- local runner diagnostic logs
- connected remote build nodes
- node CPU/load/memory/uptime information
- remote node runner log tails

Dashboard login is controlled through `.env` and uses a signed HttpOnly session cookie.

Example:

```env
DASHBOARD_AUTH_REQUIRED=true
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=
DASHBOARD_PASSWORD_SHA256=YOUR_SHA256_PASSWORD
DASHBOARD_SESSION_SECRET=YOUR_RANDOM_SESSION_SECRET
DASHBOARD_SESSION_TTL_HOURS=12
DASHBOARD_COOKIE_SECURE=true
```

Generate a password hash with:

```bash
printf '%s' 'YOUR_PASSWORD' | sha256sum | cut -d' ' -f1
```

Generate a session secret with:

```bash
openssl rand -hex 32
```

By default the dashboard binds to:

```text
127.0.0.1:8080
```

so you can place Nginx Proxy Manager, Caddy, or another HTTPS reverse proxy in front of it.

## Multiple remote build nodes

The central dashboard supports additional runner machines.

Remote nodes use:

```text
docker-compose.node.yml
.env.node.example
```

Each remote node runs:

```text
GitHub runner
    +
node-agent
```

The node agent makes an outbound connection to the central dashboard, so you do not need to expose an inbound agent port on each remote server.

Configure the same node secret on the central dashboard and every permitted node:

```env
DASHBOARD_NODE_SHARED_SECRET=YOUR_SEPARATE_RANDOM_SECRET
```

Each machine must have a unique ID:

```env
NODE_ID=uk-vps-02
NODE_NAME=UK Builder 02
NODE_LOCATION=UK
```

See `REMOTE-NODES.md` for remote setup.

## Images published by this repository

The included GitHub workflow publishes AMD64 + ARM64 versions of:

```text
ghcr.io/nekosuneprojects/docker-github-runners:latest
ghcr.io/nekosuneprojects/docker-github-runners-dashboard:latest
ghcr.io/nekosuneprojects/docker-github-runners-node-agent:latest
```

The build workflow currently disables SBOM/provenance generation and uses a smaller GitHub Actions cache export to keep bootstrap builds quicker.

## Initial setup

```bash
cp .env.example .env
```

Edit `.env`, then:

```bash
docker compose build
docker compose up -d
```

Logs:

```bash
docker compose logs -f dashboard
docker compose logs -f node-agent
```

The node-agent dynamically creates the broker-managed runner containers. List them with:

```bash
docker ps --filter label=neko.runner.managed=true
```

## Updating an existing installation

After pulling broker/control-plane changes, recreate the dashboard and node-agent:

```bash
git pull
docker compose down
docker compose build --no-cache dashboard node-agent
docker compose up -d --force-recreate
```

The node-agent will reconcile and recreate the required runner containers automatically.

## Security

Access to `/var/run/docker.sock` effectively grants workflows powerful control over the Docker host. Only allow trusted repositories and trusted workflow changes to target these self-hosted runners.

The dashboard itself does not mount the Docker socket. It only reads GitHub API data, dashboard state, and read-only runner diagnostic data.
