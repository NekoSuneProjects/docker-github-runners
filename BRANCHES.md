# Component branches

This repository is split so slow self-hosted VPS runners do not rebuild every image for unrelated changes.

| Branch | Component | Published image | Automatic trigger |
| --- | --- | --- | --- |
| `runner` | GitHub Actions runner | `ghcr.io/nekosuneprojects/docker-github-runners:latest` | Changes to `Dockerfile`, `start.sh`, runner entrypoint, or its workflow |
| `dashboard` | Central web dashboard + SQLite history | `ghcr.io/nekosuneprojects/docker-github-runners-dashboard:latest` | Changes under `dashboard/` |
| `agent` | Remote node telemetry/cleanup agent | `ghcr.io/nekosuneprojects/docker-github-runners-node-agent:latest` | Changes under `node-agent/` |
| `main` | Integration Compose/examples/docs | all three only when manually dispatched | No automatic image build |

All component images are still published for both `linux/amd64` and `linux/arm64`.

## Recommended development flow

Make runner-only changes on `runner`, dashboard-only changes on `dashboard`, and agent-only changes on `agent`. Use `main` for Compose files, environment examples, and coordinated releases.

The `main` workflow is intentionally `workflow_dispatch` only. This prevents documentation/Compose changes from consuming hours rebuilding three images.

## Storage cleanup design

The node agent reports Docker reclaimable space and local runner diagnostic size to the central dashboard. The dashboard stores log snapshots and cleanup history in `/data/dashboard.sqlite` before cleanup commands are sent back to a node.

Per-node dashboard controls include:

- Auto-clean after a GitHub runner changes from busy to idle.
- Manual cleanup.
- Optional removal of unused Docker volumes (off by default).
- Reported reclaimable bytes.
- SQLite-backed runner log history.
- Cleanup history and reclaimed-byte totals.

Default cleanup removes Buildx cache when available, stopped containers, unused images, unused networks, and archived local runner diagnostics. Running containers and active images are not removed. Docker volumes are not pruned unless the per-node volume option is explicitly enabled.
