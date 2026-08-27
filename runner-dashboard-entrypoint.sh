#!/usr/bin/env bash

set -Eeuo pipefail

# The dashboard reads GitHub runner diagnostic logs from a shared Docker volume.
# Named volumes normally start root-owned, so prepare the directory while the
# container is still root, then let start.sh handle Docker socket group mapping
# and privilege dropping.
mkdir -p /actions-runner/_diag
chown -R runner:runner /actions-runner/_diag
chmod 0755 /actions-runner/_diag

# ======================================================
# Host-wide Docker multi-architecture support
# ======================================================
# The runner uses the host Docker daemon through /var/run/docker.sock. Register
# binfmt/QEMU on that host at startup so an AMD64 machine can execute ARM64
# build stages whenever Docker Buildx needs them. No compiler SDKs are required
# in the runner image for this.
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
        echo "ARM64 emulation cannot be registered automatically."
    elif ! docker info >/dev/null 2>&1; then
        echo "WARNING: Docker daemon is not reachable during startup."
        echo "The runner will still start, but multi-arch registration was skipped."
    elif docker run \
        --privileged \
        --rm \
        tonistiigi/binfmt \
        --install "${MULTIARCH_PLATFORMS}"
    then
        echo "✓ Docker binfmt/QEMU registration complete"
        echo "AMD64 hosts can build linux/arm64 images with Docker Buildx."
    else
        echo "WARNING: Automatic binfmt/QEMU registration failed."
        echo "The runner will continue. Workflows may still use docker/setup-qemu-action."
    fi

    echo "============================================"
    echo
else
    echo "Docker multi-architecture startup setup disabled."
fi

exec /actions-runner/start.sh "$@"
