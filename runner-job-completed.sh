#!/usr/bin/env bash
set -Eeuo pipefail

LOCK_ROOT="${NODE_SHARED_LOCK_DIR:-/runner-lock}"
LOCK_DIR="${LOCK_ROOT}/active"
OWNER="${RUNNER_NAME:-unknown-runner}"

if [[ ! -d "$LOCK_DIR" ]]; then
    exit 0
fi

CURRENT="$(cat "$LOCK_DIR/owner" 2>/dev/null || true)"
if [[ "$CURRENT" == "$OWNER" ]]; then
    rm -rf "$LOCK_DIR"
    echo "[node-lock] ${OWNER} released the physical node job slot"
else
    echo "[node-lock] lock belongs to ${CURRENT:-unknown}; ${OWNER} will not remove it"
fi
