# Neko GitHub Multi-Platform Runner

A self-hosted GitHub Actions runner image designed to run natively on:

- Linux AMD64
- Linux ARM64

It also includes toolchains for producing:

- Linux AMD64 builds
- Linux ARM64 builds
- Windows x64 cross-compiled binaries
- Docker multi-platform AMD64 + ARM64 images

## Included build tools

- Docker CLI
- Docker Compose
- Docker Buildx
- GCC / G++
- Clang / LLVM
- CMake
- Ninja
- Meson
- Make / Autotools
- MinGW-w64
- ARM64 and AMD64 Linux cross-compilers
- QEMU user emulation
- Rust
- Go
- Node.js 24
- npm / yarn / pnpm
- Python 3
- Java 17
- Java 21
- Maven
- Gradle
- .NET 8
- .NET 10
- Ruby
- PHP / Composer
- Git LFS

## Runner dashboard

The Compose stack includes a web dashboard for monitoring the organization and
self-hosted workers without having to jump between GitHub Actions pages.

The dashboard shows:

- total, online, idle, and busy self-hosted workers
- worker names, operating systems, labels, and current busy state
- queued and running jobs with the runner they are assigned to
- recent workflow runs across multiple repositories
- build status, branch, actor, workflow name, run number, and timestamps
- individual jobs and every GitHub Actions step
- failed steps highlighted separately
- GitHub workflow log archives with errors and warnings highlighted
- log searching and an `Errors only` filter
- local GitHub runner `_diag` logs from the backend while the runner is active
- automatic dashboard refresh

By default it is exposed only on the host loopback interface:

```text
http://127.0.0.1:8080
```

This is intentional so it can be placed behind Nginx Proxy Manager, Caddy, a
Cloudflare Tunnel, or another authenticated reverse proxy.

Dashboard `.env` options:

```env
DASHBOARD_BIND=127.0.0.1
DASHBOARD_PORT=8080
DASHBOARD_REPOS=
DASHBOARD_MAX_REPOS=12
DASHBOARD_REFRESH_SECONDS=10
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD
```

`DASHBOARD_REPOS` can contain a comma-separated list such as:

```env
DASHBOARD_REPOS=docker-github-runners,CastNexus,NekoLive
```

When it is blank, the dashboard automatically monitors the most recently
pushed repositories in `GITHUB_ORG` up to `DASHBOARD_MAX_REPOS`.

The dashboard can reuse `ACCESS_TOKEN`, or you can provide a separate read-only
token:

```env
GITHUB_DASHBOARD_TOKEN=github_pat_XXXXXXXXXXXXXXXXXXXXXXXX
```

For a fine-grained token, the runner registration needs the organization
`Self-hosted runners: Read and write` permission. To read workflow runs, jobs,
and downloadable logs, also give the selected repositories `Actions: Read`.

Workflow logs can contain sensitive output, so enable dashboard Basic Auth or
keep it behind an authenticated reverse proxy before exposing it publicly.

## Automatic Docker socket permissions

You do **not** need to manually configure a Docker group ID.

The container mounts:

```text
/var/run/docker.sock
```

At startup it automatically:

1. Reads the GID of the mounted Docker socket.
2. Finds or creates a matching group inside the container.
3. Adds the `runner` user to that group.
4. Verifies the runner can read and write the Docker socket.
5. Drops root privileges.
6. Starts the GitHub Actions runner as the non-root `runner` user.

For example, if one host uses Docker GID `988` and another uses `992`, the
same image works on both without changing `.env`.

## GitHub runner updates

On every container startup, `start.sh` checks the latest stable `actions/runner`
release.

If a newer runner exists:

1. Detects host architecture.
2. Downloads the matching x64 or arm64 runner archive.
3. Verifies SHA256 if GitHub exposes an asset digest.
4. Validates the archive.
5. Replaces runner binaries.
6. Re-checks the installed version.
7. Registers with GitHub.
8. Starts accepting jobs.

GitHub's built-in runner auto-updater is still enabled.

## Multiple repositories

The recommended configuration is organization scope:

```env
RUNNER_SCOPE=organization
GITHUB_ORG=YOUR_GITHUB_ORG
```

One organization-level runner can be made available to multiple repositories.

If repositories belong to different users or organizations, run multiple
containers from this same image and register each container at the appropriate
repository or organization scope.

## Setup

Copy:

```bash
cp .env.example .env
```

Edit `.env` and insert your GitHub token and organization.

No `DOCKER_GID` value is required.

Build:

```bash
docker compose build
```

Start the runner and dashboard:

```bash
docker compose up -d
```

Runner logs:

```bash
docker compose logs -f github-builder
```

Dashboard logs:

```bash
docker compose logs -f dashboard
```

A successful runner startup should include output similar to:

```text
Docker Socket Auto Configuration
Docker socket: /var/run/docker.sock
Socket GID:    988
Adding runner to docker
...
Docker Socket Permission Check
✓ Docker socket permissions are available to runner
```

## Updating an existing installation

After pulling changes to this repository, recreate the containers:

```bash
git pull
docker compose down
docker compose build --no-cache
docker compose up -d --force-recreate
```

Then verify Docker access:

```bash
docker compose exec github-builder docker version
```

You should see both the Docker `Client` and `Server` sections.

Check dashboard health:

```bash
curl -u "$DASHBOARD_USERNAME:$DASHBOARD_PASSWORD" http://127.0.0.1:8080/api/health
```

## Build one image for AMD64 and ARM64

Create a Buildx builder:

```bash
docker buildx create \
  --name neko-multiarch \
  --driver docker-container \
  --use
```

Bootstrap:

```bash
docker buildx inspect --bootstrap
```

On an ARM64 Raspberry Pi, register QEMU support on the Docker host:

```bash
docker run \
  --privileged \
  --rm \
  tonistiigi/binfmt \
  --install amd64,arm64
```

Then publish both platforms:

```bash
docker buildx bake --push
```

Or:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/YOUR_ORG/github-builder-runner:latest \
  --push \
  .
```

## Workflow labels

Example:

```yaml
jobs:
  build:
    runs-on:
      - self-hosted
      - linux
      - crossbuild

    steps:
      - uses: actions/checkout@v4
      - run: docker version
```

The automatic GitHub labels still identify the real host architecture. The
`crossbuild` label means the runner also contains cross-compilation tooling.

## Go examples

Linux AMD64:

```bash
GOOS=linux GOARCH=amd64 go build -o dist/app-linux-amd64
```

Linux ARM64:

```bash
GOOS=linux GOARCH=arm64 go build -o dist/app-linux-arm64
```

Windows AMD64:

```bash
GOOS=windows GOARCH=amd64 go build -o dist/app-windows-amd64.exe
```

Windows ARM64:

```bash
GOOS=windows GOARCH=arm64 go build -o dist/app-windows-arm64.exe
```

## C/C++ Windows cross-build

```bash
x86_64-w64-mingw32-g++ \
  main.cpp \
  -static \
  -static-libgcc \
  -static-libstdc++ \
  -o program-windows-x64.exe
```

## C/C++ Linux cross-builds

AMD64:

```bash
x86_64-linux-gnu-g++ main.cpp -o program-linux-amd64
```

ARM64:

```bash
aarch64-linux-gnu-g++ main.cpp -o program-linux-arm64
```

## Rust

Linux AMD64:

```bash
cargo build --release --target x86_64-unknown-linux-gnu
```

Linux ARM64:

```bash
cargo build --release --target aarch64-unknown-linux-gnu
```

Windows AMD64:

```bash
cargo build --release --target x86_64-pc-windows-gnu
```

## .NET

Linux x64:

```bash
dotnet publish -c Release -r linux-x64 --self-contained true -o dist/linux-x64
```

Linux ARM64:

```bash
dotnet publish -c Release -r linux-arm64 --self-contained true -o dist/linux-arm64
```

Windows x64:

```bash
dotnet publish -c Release -r win-x64 --self-contained true -o dist/win-x64
```

Windows ARM64:

```bash
dotnet publish -c Release -r win-arm64 --self-contained true -o dist/win-arm64
```

## Important limitation

This remains a Linux runner.

It can cross-compile many Windows applications, but it does not replace a real
Windows runner for workloads that require:

- Visual Studio
- MSVC
- Windows containers
- Windows-only SDK components
- Windows GUI build tools
- some Windows NativeAOT workflows

Use a real Windows self-hosted runner for those cases.

## Security note

Mounting:

```text
/var/run/docker.sock
```

gives workflows powerful access to the Docker host. Only allow trusted
repositories and trusted workflows to use this runner.

The dashboard intentionally does not mount the Docker socket. It receives
runner status and workflow information from GitHub's API and has read-only
access to the shared runner diagnostic log volume.
