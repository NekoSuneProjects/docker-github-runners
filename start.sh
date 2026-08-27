#!/usr/bin/env bash

set -Eeuo pipefail

# ======================================================
# Docker socket auto-configuration
# ======================================================
# The container starts as root only for this small setup stage. We read the
# group ID directly from the mounted host Docker socket, add the runner user to
# the matching group, then immediately restart this script as the non-root
# runner user. This removes the need to manually configure DOCKER_GID.

if [[ "$(id -u)" -eq 0 && "${1:-}" != "--runner-user" ]]; then
    echo
    echo "============================================"
    echo " Docker Socket Auto Configuration"
    echo "============================================"

    if [[ -S /var/run/docker.sock ]]; then
        DOCKER_SOCKET_GID="$(stat -c '%g' /var/run/docker.sock)"
        DOCKER_SOCKET_MODE="$(stat -c '%A' /var/run/docker.sock)"

        echo "Docker socket: /var/run/docker.sock"
        echo "Socket GID:    ${DOCKER_SOCKET_GID}"
        echo "Socket mode:   ${DOCKER_SOCKET_MODE}"

        EXISTING_GROUP="$(getent group "${DOCKER_SOCKET_GID}" | cut -d: -f1 || true)"

        if [[ -n "${EXISTING_GROUP}" ]]; then
            DOCKER_SOCKET_GROUP="${EXISTING_GROUP}"
            echo "Matching group already exists: ${DOCKER_SOCKET_GROUP}:${DOCKER_SOCKET_GID}"
        else
            DOCKER_SOCKET_GROUP="docker-socket-${DOCKER_SOCKET_GID}"
            echo "Creating matching group: ${DOCKER_SOCKET_GROUP}:${DOCKER_SOCKET_GID}"
            groupadd --gid "${DOCKER_SOCKET_GID}" "${DOCKER_SOCKET_GROUP}"
        fi

        if id -nG runner | tr ' ' '\n' | grep -Fxq "${DOCKER_SOCKET_GROUP}"; then
            echo "Runner already belongs to ${DOCKER_SOCKET_GROUP}"
        else
            echo "Adding runner to ${DOCKER_SOCKET_GROUP}"
            usermod -aG "${DOCKER_SOCKET_GROUP}" runner
        fi

        echo "Runner groups after configuration:"
        id runner
    else
        echo "WARNING: /var/run/docker.sock is not mounted."
        echo "Docker-based GitHub Actions jobs will not work until the socket is mounted."
    fi

    echo "Dropping root privileges and starting as runner..."
    echo "============================================"
    echo

    exec sudo -E -H -u runner -- /actions-runner/start.sh --runner-user
fi

API_URL="https://api.github.com"
API_VERSION="2022-11-28"

RUNNER_SCOPE="${RUNNER_SCOPE:-organization}"
RUNNER_NAME="${RUNNER_NAME:-builder-$(hostname)}"
RUNNER_UPDATE_ON_START="${RUNNER_UPDATE_ON_START:-true}"

case "$(uname -m)" in
    x86_64|amd64)
        HOST_ARCH="amd64"
        GITHUB_RUNNER_ARCH="x64"
        ;;
    aarch64|arm64)
        HOST_ARCH="arm64"
        GITHUB_RUNNER_ARCH="arm64"
        ;;
    *)
        echo "ERROR: Unsupported architecture: $(uname -m)"
        exit 1
        ;;
esac

DEFAULT_LABELS="docker,buildx,crossbuild,builder,${HOST_ARCH}"
LABELS="${LABELS:-$DEFAULT_LABELS}"

if [[ -z "${ACCESS_TOKEN:-}" ]]; then
    echo "ERROR: ACCESS_TOKEN is required"
    exit 1
fi

verify_docker_socket() {
    echo
    echo "============================================"
    echo " Docker Socket Permission Check"
    echo "============================================"

    if [[ ! -S /var/run/docker.sock ]]; then
        echo "WARNING: Docker socket is not mounted."
        echo "============================================"
        return 0
    fi

    echo "Runner identity:"
    id
    echo
    echo "Docker socket:"
    ls -ln /var/run/docker.sock

    if [[ ! -r /var/run/docker.sock || ! -w /var/run/docker.sock ]]; then
        echo
        echo "ERROR: runner still cannot read/write /var/run/docker.sock"
        echo "The container cannot run Docker-based workflow steps."
        exit 1
    fi

    echo
    echo "✓ Docker socket permissions are available to runner"
    echo "============================================"
}

github_api() {
    local method="$1"
    local endpoint="$2"

    curl -fsSL \
        -X "$method" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: ${API_VERSION}" \
        "${API_URL}${endpoint}"
}

get_installed_runner_version() {
    if [[ ! -x "./bin/Runner.Listener" ]]; then
        echo ""
        return 0
    fi

    ./bin/Runner.Listener --version 2>/dev/null \
        | tail -n1 \
        | tr -d '\r'
}

get_latest_runner_release() {
    curl -fsSL \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: ${API_VERSION}" \
        "https://api.github.com/repos/actions/runner/releases/latest"
}

update_github_runner() {
    if [[ "${RUNNER_UPDATE_ON_START,,}" != "true" ]]; then
        echo "GitHub runner startup update check disabled."
        return 0
    fi

    echo
    echo "============================================"
    echo " Checking GitHub Actions Runner Updates"
    echo "============================================"

    CURRENT_VERSION="$(get_installed_runner_version)"

    if [[ -z "$CURRENT_VERSION" ]]; then
        echo "Unable to determine installed runner version."
        echo "Keeping current runner installation."
        return 0
    fi

    echo "Installed version: ${CURRENT_VERSION}"
    echo "Checking GitHub..."

    if ! RELEASE_JSON="$(get_latest_runner_release)"; then
        echo "WARNING: Could not contact GitHub releases API."
        echo "Continuing with runner ${CURRENT_VERSION}."
        return 0
    fi

    LATEST_TAG="$(echo "$RELEASE_JSON" | jq -r '.tag_name // empty')"

    if [[ -z "$LATEST_TAG" ]]; then
        echo "WARNING: GitHub did not return a release version."
        echo "Continuing with runner ${CURRENT_VERSION}."
        return 0
    fi

    LATEST_VERSION="${LATEST_TAG#v}"

    echo "Latest version:    ${LATEST_VERSION}"

    if [[ "$CURRENT_VERSION" == "$LATEST_VERSION" ]]; then
        echo "✓ GitHub Actions runner is up to date."
        return 0
    fi

    if dpkg --compare-versions "$CURRENT_VERSION" gt "$LATEST_VERSION"; then
        echo "Installed runner is newer than latest stable release."
        echo "No downgrade will be performed."
        return 0
    fi

    RUNNER_PACKAGE="actions-runner-linux-${GITHUB_RUNNER_ARCH}-${LATEST_VERSION}.tar.gz"

    DOWNLOAD_URL="$(
        echo "$RELEASE_JSON" |
        jq -r \
            --arg PACKAGE "$RUNNER_PACKAGE" \
            '.assets[] | select(.name == $PACKAGE) | .browser_download_url' |
        head -n1
    )"

    PACKAGE_DIGEST="$(
        echo "$RELEASE_JSON" |
        jq -r \
            --arg PACKAGE "$RUNNER_PACKAGE" \
            '.assets[] | select(.name == $PACKAGE) | (.digest // empty)' |
        head -n1
    )"

    if [[ -z "$DOWNLOAD_URL" ]]; then
        echo "ERROR: Runner package not found: ${RUNNER_PACKAGE}"
        echo "Keeping existing runner ${CURRENT_VERSION}."
        return 0
    fi

    echo
    echo "New runner available: ${CURRENT_VERSION} -> ${LATEST_VERSION}"
    echo "Architecture: ${GITHUB_RUNNER_ARCH}"

    UPDATE_DIR="$(mktemp -d)"
    PACKAGE_FILE="${UPDATE_DIR}/${RUNNER_PACKAGE}"
    EXTRACT_DIR="${UPDATE_DIR}/runner"

    mkdir -p "$EXTRACT_DIR"

    echo "Downloading GitHub Actions runner ${LATEST_VERSION}..."

    if ! curl \
        --fail \
        --location \
        --retry 3 \
        --retry-delay 2 \
        "$DOWNLOAD_URL" \
        --output "$PACKAGE_FILE"
    then
        echo "ERROR: Runner update download failed."
        rm -rf "$UPDATE_DIR"
        return 0
    fi

    if [[ "$PACKAGE_DIGEST" == sha256:* ]]; then
        EXPECTED_SHA="${PACKAGE_DIGEST#sha256:}"
        ACTUAL_SHA="$(sha256sum "$PACKAGE_FILE" | awk '{print $1}')"

        if [[ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
            echo "ERROR: SHA256 verification failed."
            rm -rf "$UPDATE_DIR"
            return 0
        fi

        echo "✓ SHA256 verified"
    else
        echo "GitHub release digest unavailable; HTTPS download used."
    fi

    if ! tar tzf "$PACKAGE_FILE" >/dev/null; then
        echo "ERROR: Downloaded runner archive is invalid."
        rm -rf "$UPDATE_DIR"
        return 0
    fi

    tar xzf "$PACKAGE_FILE" -C "$EXTRACT_DIR"

    if [[ ! -x "${EXTRACT_DIR}/bin/Runner.Listener" ]]; then
        echo "ERROR: New runner package is incomplete."
        rm -rf "$UPDATE_DIR"
        return 0
    fi

    NEW_VERSION="$(
        "${EXTRACT_DIR}/bin/Runner.Listener" --version 2>/dev/null |
        tail -n1 |
        tr -d '\r'
    )"

    if [[ "$NEW_VERSION" != "$LATEST_VERSION" ]]; then
        echo "ERROR: Extracted runner version mismatch."
        rm -rf "$UPDATE_DIR"
        return 0
    fi

    echo "Installing GitHub Actions runner ${LATEST_VERSION}..."

    rsync \
        -a \
        --delete \
        --exclude='start.sh' \
        --exclude='.runner' \
        --exclude='.credentials' \
        --exclude='.credentials_rsaparams' \
        --exclude='.env' \
        --exclude='_diag/' \
        --exclude='_work/' \
        --exclude='update.finished' \
        "${EXTRACT_DIR}/" \
        /actions-runner/

    if [[ -x "/actions-runner/bin/installdependencies.sh" ]]; then
        sudo /actions-runner/bin/installdependencies.sh \
            || echo "WARNING: Dependency script reported an error."
    fi

    INSTALLED_VERSION="$(
        /actions-runner/bin/Runner.Listener --version 2>/dev/null |
        tail -n1 |
        tr -d '\r'
    )"

    echo "Runner update result: ${CURRENT_VERSION} -> ${INSTALLED_VERSION}"
    rm -rf "$UPDATE_DIR"
}

configure_scope() {
    case "$RUNNER_SCOPE" in
        organization|org)
            if [[ -z "${GITHUB_ORG:-}" ]]; then
                echo "ERROR: GITHUB_ORG is required"
                exit 1
            fi

            CONFIG_URL="https://github.com/${GITHUB_ORG}"
            API_SCOPE="/orgs/${GITHUB_ORG}"
            ;;

        repository|repo)
            if [[ -z "${REPO_URL:-}" ]]; then
                echo "ERROR: REPO_URL is required"
                exit 1
            fi

            REPO_PATH="${REPO_URL#https://github.com/}"
            REPO_PATH="${REPO_PATH%.git}"

            CONFIG_URL="https://github.com/${REPO_PATH}"
            API_SCOPE="/repos/${REPO_PATH}"
            ;;

        *)
            echo "ERROR: Invalid RUNNER_SCOPE: ${RUNNER_SCOPE}"
            exit 1
            ;;
    esac
}

get_registration_token() {
    echo "Getting GitHub runner registration token..."

    RESPONSE="$(github_api POST "${API_SCOPE}/actions/runners/registration-token")"
    RUNNER_TOKEN="$(echo "$RESPONSE" | jq -r '.token // empty')"

    if [[ -z "$RUNNER_TOKEN" ]]; then
        echo "ERROR: GitHub did not return a registration token."
        exit 1
    fi
}

get_remove_token() {
    RESPONSE="$(
        github_api POST "${API_SCOPE}/actions/runners/remove-token" \
        2>/dev/null || true
    )"

    REMOVE_TOKEN="$(
        echo "$RESPONSE" |
        jq -r '.token // empty' \
        2>/dev/null || true
    )"

    [[ -n "$REMOVE_TOKEN" ]]
}

remove_remote_runner() {
    echo "Checking for stale runner: ${RUNNER_NAME}"

    RESPONSE="$(
        github_api GET "${API_SCOPE}/actions/runners?per_page=100" \
        2>/dev/null || true
    )"

    RUNNER_ID="$(
        echo "$RESPONSE" |
        jq -r \
            --arg name "$RUNNER_NAME" \
            '.runners[]? | select(.name == $name) | .id' |
        head -n1
    )"

    if [[ -n "$RUNNER_ID" ]]; then
        echo "Removing stale runner ${RUNNER_ID}"
        github_api DELETE "${API_SCOPE}/actions/runners/${RUNNER_ID}" >/dev/null || true
    fi
}

remove_local_configuration() {
    if [[ -f ".runner" ]]; then
        echo "Existing local runner configuration detected."

        if get_remove_token; then
            ./config.sh remove \
                --unattended \
                --token "$REMOVE_TOKEN" \
                || true
        fi

        rm -f .runner .credentials .credentials_rsaparams || true
    fi
}

configure_runner() {
    echo
    echo "============================================"
    echo " Neko GitHub Multi-Platform Builder"
    echo "============================================"
    echo "Runner:       ${RUNNER_NAME}"
    echo "Architecture: ${HOST_ARCH}"
    echo "Runner ver:   $(./bin/Runner.Listener --version)"
    echo "GitHub:       ${CONFIG_URL}"
    echo "Labels:       ${LABELS}"
    echo "============================================"
    echo

    ./config.sh \
        --unattended \
        --url "$CONFIG_URL" \
        --token "$RUNNER_TOKEN" \
        --name "$RUNNER_NAME" \
        --work "/work" \
        --labels "$LABELS" \
        --replace
}

cleanup() {
    echo
    echo "Stopping GitHub Actions runner..."

    if [[ -n "${RUNNER_PID:-}" ]]; then
        kill -TERM "$RUNNER_PID" 2>/dev/null || true
        wait "$RUNNER_PID" 2>/dev/null || true
    fi

    if get_remove_token; then
        echo "Removing GitHub runner registration..."
        ./config.sh remove \
            --unattended \
            --token "$REMOVE_TOKEN" \
            2>/dev/null || true
    fi
}

trap cleanup SIGTERM SIGINT

echo
echo "Starting Neko GitHub Builder..."
echo

verify_docker_socket
update_github_runner
configure_scope
remove_local_configuration
remove_remote_runner
get_registration_token
configure_runner

echo
echo "Starting GitHub Actions Runner..."
echo

./run.sh &
RUNNER_PID=$!

wait "$RUNNER_PID"
