#!/usr/bin/env bash
set -Eeuo pipefail

LOCK_ROOT="${NODE_SHARED_LOCK_DIR:-/runner-lock}"
LOCK_DIR="${LOCK_ROOT}/active"
OWNER="${RUNNER_NAME:-unknown-runner}"
WAIT_SECONDS="${NODE_SHARED_LOCK_POLL_SECONDS:-2}"
STALE_SECONDS="${NODE_SHARED_LOCK_STALE_SECONDS:-259200}"

mkdir -p "$LOCK_ROOT"

last_notice=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    now="$(date +%s)"
    if [[ -f "$LOCK_DIR/acquired_at" ]]; then
        acquired="$(cat "$LOCK_DIR/acquired_at" 2>/dev/null || echo 0)"
        if [[ "$acquired" =~ ^[0-9]+$ ]] && (( now - acquired > STALE_SECONDS )); then
            echo "[node-lock] stale lock older than ${STALE_SECONDS}s detected; clearing"
            rm -rf "$LOCK_DIR" || true
            continue
        fi
    fi

    if (( now - last_notice >= 30 )); then
        current="$(cat "$LOCK_DIR/owner" 2>/dev/null || echo another-runner)"
        echo "[node-lock] ${OWNER} waiting; physical node is busy with ${current}"
        last_notice="$now"
    fi
    sleep "$WAIT_SECONDS"
done

date +%s > "$LOCK_DIR/acquired_at"
printf '%s\n' "$OWNER" > "$LOCK_DIR/owner"
printf '%s\n' "${GITHUB_REPOSITORY:-unknown}" > "$LOCK_DIR/repository"
printf '%s\n' "${GITHUB_RUN_ID:-unknown}" > "$LOCK_DIR/run_id"
echo "[node-lock] ${OWNER} acquired the physical node job slot"
