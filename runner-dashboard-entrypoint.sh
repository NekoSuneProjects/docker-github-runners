#!/usr/bin/env bash

set -Eeuo pipefail

mkdir -p /actions-runner/_diag
chown -R runner:runner /actions-runner/_diag
chmod 0755 /actions-runner/_diag

# Keep a local console copy for the node agent. The agent continuously archives
# snapshots to the central dashboard SQLite database, so this file can later be
# truncated during cleanup without losing dashboard history.
CONSOLE_LOG="/actions-runner/_diag/console.log"
touch "$CONSOLE_LOG"
chown runner:runner "$CONSOLE_LOG"
chmod 0640 "$CONSOLE_LOG"
exec > >(tee -a "$CONSOLE_LOG") 2>&1

# Host-wide Docker multi-architecture support.
ENABLE_MULTIARCH_ON_START="${ENABLE_MULTIARCH_ON_START:-true}"
MULTIARCH_PLATFORMS="${MULTIARCH_PLATFORMS:-arm64,amd64}"

if [[ "${ENABLE_MULTIARCH_ON_START,,}" == "true" ]]; then
    echo
    echo "============================================"
    echo " Docker Multi-Architecture Setup"
    echo "============================================"
    echo "Host architecture: $(uname -m)"
    echo "Registering:       ${MULTIARCH_PLATFORMS}"

    if [[ ! -S /var/run/docker.sock ]]; then
        echo "WARNING: /var/run/docker.sock is not mounted."
    elif ! docker info >/dev/null 2>&1; then
        echo "WARNING: Docker daemon is not reachable during startup."
    elif docker run --privileged --rm tonistiigi/binfmt --install "${MULTIARCH_PLATFORMS}"; then
        echo "✓ Docker binfmt/QEMU registration complete"
        echo "AMD64 hosts can build linux/arm64 images with Docker Buildx."
    else
        echo "WARNING: Automatic binfmt/QEMU registration failed."
        echo "Workflows may still use docker/setup-qemu-action."
    fi
    echo "============================================"
    echo
fi

exec /actions-runner/start.sh "$@"
