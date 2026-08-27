#!/usr/bin/env bash

set -Eeuo pipefail

# The dashboard reads GitHub runner diagnostic logs from a shared Docker volume.
# Named volumes normally start root-owned, so prepare the directory while the
# container is still root, then let the existing start.sh handle Docker socket
# auto-detection and privilege dropping.
mkdir -p /actions-runner/_diag
chown -R runner:runner /actions-runner/_diag
chmod 0755 /actions-runner/_diag

exec /actions-runner/start.sh "$@"
