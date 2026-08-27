#!/bin/sh
set -eu

DATA_DIR="${DASHBOARD_DATA_DIR:-/data}"

# Bind mounts such as ./data:/data replace the ownership baked into the image.
# Start as root only long enough to make the persistent dashboard data writable,
# then immediately drop to the unprivileged node user.
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
    echo "Preparing dashboard data directory: $DATA_DIR"

    # Fix existing SQLite/legacy state files too, including nodes.json from
    # earlier dashboard versions.
    chown -R node:node "$DATA_DIR"
    chmod 0750 "$DATA_DIR"

    echo "Dashboard data directory ownership: $(stat -c '%u:%g %a' "$DATA_DIR" 2>/dev/null || true)"
    echo "Starting dashboard as node user..."

    exec su-exec node "$@"
fi

exec "$@"
