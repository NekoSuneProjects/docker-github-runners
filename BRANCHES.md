# Component branches

The repository is intentionally split into three runtime branches plus this documentation-only `main` branch.

| Branch | Component | Published image | Build trigger |
| --- | --- | --- | --- |
| `runner` | GitHub Actions runner | `ghcr.io/nekosuneprojects/docker-github-runners:latest` | Pushes affecting runner image files on `runner` |
| `dashboard` | Dashboard + credential broker/control plane | `ghcr.io/nekosuneprojects/docker-github-runners-dashboard:latest` | Pushes affecting `dashboard/**` on `dashboard` |
| `agent` | Worker/node agent + fleet controller | `ghcr.io/nekosuneprojects/docker-github-runners-node-agent:latest` | Pushes affecting `node-agent/**` on `agent` |
| `main` | Documentation and architecture index only | none | no image workflow |

All runtime images target:

```text
linux/amd64
linux/arm64
```

## Ownership

### runner

Owns:

- runner `Dockerfile`
- `start.sh`
- runner job-start/job-complete hooks
- runner entrypoint
- runner-specific `.env.example`
- runner image workflow

### dashboard

Owns:

- dashboard application
- GitHub App / PAT credential broker
- organization and personal-repository target discovery
- GitHub runner registration/removal APIs
- runner label synchronization
- dashboard-specific `.env.example`
- dashboard image workflow

### agent

Owns:

- node heartbeat/telemetry
- fleet supervisor
- VPS capacity classification
- small/medium/large/GPU routing
- physical-node one-job lock coordination
- remote-node Compose/config
- agent-specific env examples
- agent image workflow

### main

Contains documentation only. Runtime code, Dockerfiles, Compose files, shell scripts, environment templates, and image workflows do not belong on `main`.

## Development flow

Make changes directly to the branch that owns the component.

Cross-component changes should be applied to each affected component branch rather than rebuilding all images from `main`.

The dashboard remains the only component that should hold long-lived GitHub credentials.
