# syntax=docker/dockerfile:1.7

FROM ubuntu:24.04

ARG TARGETARCH
ARG DEBIAN_FRONTEND=noninteractive

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Lean runtime for GitHub Actions + Docker image builds.
# Heavy language SDKs, compilers and cross-toolchains are intentionally omitted.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    git-lfs \
    jq \
    tar \
    gzip \
    unzip \
    zip \
    sudo \
    gnupg \
    rsync \
    openssh-client \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI + Buildx + Compose only. The Docker daemon remains on the host and
# is reached through the mounted /var/run/docker.sock.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
       -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo \
       "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
       $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       docker-ce-cli \
       docker-buildx-plugin \
       docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Non-root GitHub Actions runner user. start.sh temporarily starts as root only
# to map the host Docker socket GID, then drops back to this account.
RUN useradd \
        --create-home \
        --shell /bin/bash \
        runner \
    && usermod -aG sudo runner \
    && echo "runner ALL=(ALL) NOPASSWD:ALL" \
       > /etc/sudoers.d/runner \
    && chmod 0440 /etc/sudoers.d/runner \
    && mkdir -p /actions-runner /work /github/workspace \
    && chown -R runner:runner /actions-runner /work /github

USER runner
WORKDIR /actions-runner

# Install the newest stable GitHub Actions runner for the image architecture.
# The runner package carries the Node runtime needed by JavaScript actions, so
# a separate system Node.js installation is not required.
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) RUNNER_ARCH="x64" ;; \
        arm64) RUNNER_ARCH="arm64" ;; \
        *) echo "Unsupported architecture: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    RUNNER_VERSION="$(curl -fsSL --retry 3 \
        https://api.github.com/repos/actions/runner/releases/latest \
        | jq -r '.tag_name' \
        | sed 's/^v//')"; \
    echo "Installing GitHub Actions Runner ${RUNNER_VERSION} (${RUNNER_ARCH})"; \
    curl -fsSL --retry 3 \
        "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz" \
        -o /tmp/actions-runner.tar.gz; \
    tar xzf /tmp/actions-runner.tar.gz; \
    rm /tmp/actions-runner.tar.gz; \
    sudo ./bin/installdependencies.sh; \
    sudo rm -rf /var/lib/apt/lists/*

COPY --chown=runner:runner start.sh /actions-runner/start.sh
COPY --chown=root:root runner-dashboard-entrypoint.sh /runner-dashboard-entrypoint.sh
RUN chmod +x /actions-runner/start.sh \
    && sudo chmod +x /runner-dashboard-entrypoint.sh

WORKDIR /actions-runner

# Startup begins as root so the image can register host binfmt/QEMU support and
# match the mounted Docker socket group. start.sh then drops privileges to the
# non-root runner user before GitHub Actions starts.
USER root

CMD ["/runner-dashboard-entrypoint.sh"]
