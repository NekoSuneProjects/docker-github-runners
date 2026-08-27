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
docker compose logs -f github-builder
docker compose logs -f dashboard
docker compose logs -f node-agent
```

Verify Docker access from the runner:

```bash
docker compose exec github-builder docker version
```

You should see both the Docker Client and Server sections.

## Updating an existing installation

Because the runner image has changed significantly, rebuild it once after pulling:

```bash
git pull
docker compose down
docker compose build --no-cache github-builder
docker compose up -d --force-recreate
```

After this first lean rebuild, later builds should be substantially quicker than the previous all-in-one toolchain image.

## Security

Access to `/var/run/docker.sock` effectively grants workflows powerful control over the Docker host. Only allow trusted repositories and trusted workflow changes to target these self-hosted runners.

The dashboard itself does not mount the Docker socket. It only reads GitHub API data, dashboard state, and read-only runner diagnostic data.
