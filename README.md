# Neko GitHub Docker Runners

This `main` branch is documentation-only.

Runtime code and image builds are intentionally separated into dedicated component branches:

| Branch | Purpose | Published image |
| --- | --- | --- |
| [`runner`](https://github.com/NekoSuneProjects/docker-github-runners/tree/runner) | GitHub Actions runner container | `ghcr.io/nekosuneprojects/docker-github-runners:latest` |
| [`dashboard`](https://github.com/NekoSuneProjects/docker-github-runners/tree/dashboard) | Dashboard, GitHub credential broker, control plane | `ghcr.io/nekosuneprojects/docker-github-runners-dashboard:latest` |
| [`agent`](https://github.com/NekoSuneProjects/docker-github-runners/tree/agent) | Worker/node agent, fleet routing, remote-node deployment | `ghcr.io/nekosuneprojects/docker-github-runners-node-agent:latest` |

## Architecture

```text
GitHub App private key / PAT
            │
            ▼
       dashboard branch
   Central control plane
   - owns GitHub credentials
   - discovers allowed orgs/repos
   - creates App installation tokens
   - manages GitHub runner registrations
   - synchronizes runner labels
   - issues short-lived runner registration tokens
            │
            │ HTTPS + node shared secret
            ▼
         agent branch
   Worker / node controller
   - no GitHub PAT
   - no App private key
   - detects small/medium/large/GPU capacity
   - creates local runner containers
            │
            ▼
        runner branch
   GitHub Actions worker
   - receives short-lived registration token
   - executes workflow jobs
```

## Workload routing

Worker nodes automatically expose routing labels:

```text
small  -> neko-any, neko-size-small, neko-lite
medium -> neko-any, neko-size-medium, neko-build
large  -> neko-any, neko-size-large, neko-build, neko-heavy
GPU    -> neko-gpu
```

Workflow examples:

```yaml
# Light API/curl work
runs-on: [self-hosted, neko-lite]

# Normal builds
runs-on: [self-hosted, neko-build]

# Heavy builds
runs-on: [self-hosted, neko-heavy]

# GPU workloads
runs-on: [self-hosted, neko-gpu]

# Large GPU workloads
runs-on: [self-hosted, neko-heavy, neko-gpu]
```

## Documentation

- [Branch layout](BRANCHES.md)
- [GitHub App setup](GITHUB-APP.md)
- [Remote node architecture](REMOTE-NODES.md)

Configuration examples live on the branch that owns the component:

- Dashboard/control-plane env: [dashboard/.env.example](https://github.com/NekoSuneProjects/docker-github-runners/blob/dashboard/.env.example)
- Agent/worker env: [agent/.env.example](https://github.com/NekoSuneProjects/docker-github-runners/blob/agent/.env.example)
- Runner env: [runner/.env.example](https://github.com/NekoSuneProjects/docker-github-runners/blob/runner/.env.example)

## Builds

`main` does **not** build or publish Docker images.

Each component branch owns its own GitHub Actions workflow and publishes only its own image.
