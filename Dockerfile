# syntax=docker/dockerfile:1.7

FROM ubuntu:24.04

ARG TARGETARCH
ARG DEBIAN_FRONTEND=noninteractive

ENV DEBIAN_FRONTEND=noninteractive
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1
ENV CARGO_HOME=/home/runner/.cargo
ENV RUSTUP_HOME=/home/runner/.rustup
ENV PATH="/home/runner/.cargo/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Base packages + build toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    git \
    git-lfs \
    jq \
    unzip \
    zip \
    xz-utils \
    p7zip-full \
    tar \
    gzip \
    bzip2 \
    sudo \
    gnupg \
    lsb-release \
    apt-transport-https \
    software-properties-common \
    file \
    rsync \
    openssh-client \
    locales \
    tzdata \
    procps \
    iproute2 \
    iputils-ping \
    dnsutils \
    net-tools \
    build-essential \
    gcc \
    g++ \
    clang \
    clang-format \
    clang-tidy \
    llvm \
    lld \
    cmake \
    ninja-build \
    make \
    meson \
    autoconf \
    automake \
    libtool \
    pkg-config \
    ccache \
    nasm \
    yasm \
    patchelf \
    binutils \
    gdb \
    lcov \
    libssl-dev \
    libffi-dev \
    zlib1g-dev \
    libbz2-dev \
    liblzma-dev \
    libreadline-dev \
    libsqlite3-dev \
    uuid-dev \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    pipx \
    openjdk-17-jdk \
    openjdk-21-jdk \
    maven \
    gradle \
    ruby \
    ruby-dev \
    perl \
    php-cli \
    composer \
    protobuf-compiler \
    gettext \
    fakeroot \
    dpkg-dev \
    rpm \
    qemu-user-static \
    binfmt-support \
    && rm -rf /var/lib/apt/lists/*

# Linux cross-compilers: AMD64 + ARM64
RUN apt-get update && apt-get install -y --no-install-recommends \
    crossbuild-essential-amd64 \
    crossbuild-essential-arm64 \
    gcc-x86-64-linux-gnu \
    g++-x86-64-linux-gnu \
    binutils-x86-64-linux-gnu \
    gcc-aarch64-linux-gnu \
    g++-aarch64-linux-gnu \
    binutils-aarch64-linux-gnu \
    && rm -rf /var/lib/apt/lists/*

# Windows x64 cross-compilation with MinGW-w64
RUN apt-get update && apt-get install -y --no-install-recommends \
    mingw-w64 \
    gcc-mingw-w64-x86-64 \
    g++-mingw-w64-x86-64 \
    binutils-mingw-w64-x86-64 \
    mingw-w64-tools \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI + Buildx + Compose
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

# Node.js 24
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g npm yarn pnpm typescript ts-node \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

# Microsoft .NET SDK 8 + 10
RUN wget -q \
    https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb \
    -O /tmp/packages-microsoft-prod.deb \
    && dpkg -i /tmp/packages-microsoft-prod.deb \
    && rm /tmp/packages-microsoft-prod.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       dotnet-sdk-8.0 \
       dotnet-sdk-10.0 \
    && rm -rf /var/lib/apt/lists/*

# Go stable, architecture-aware
RUN set -eux; \
    GO_VERSION="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -n1)"; \
    case "${TARGETARCH}" in \
        amd64) GO_ARCH="amd64" ;; \
        arm64) GO_ARCH="arm64" ;; \
        *) echo "Unsupported architecture: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    echo "Installing ${GO_VERSION} for ${GO_ARCH}"; \
    curl -fsSL \
        "https://go.dev/dl/${GO_VERSION}.linux-${GO_ARCH}.tar.gz" \
        -o /tmp/go.tar.gz; \
    rm -rf /usr/local/go; \
    tar -C /usr/local -xzf /tmp/go.tar.gz; \
    rm /tmp/go.tar.gz

# Runner user
RUN useradd \
        --create-home \
        --shell /bin/bash \
        runner \
    && usermod -aG sudo runner \
    && echo "runner ALL=(ALL) NOPASSWD:ALL" \
       > /etc/sudoers.d/runner \
    && chmod 0440 /etc/sudoers.d/runner

RUN mkdir -p \
        /actions-runner \
        /work \
        /github/workspace \
    && chown -R runner:runner \
        /actions-runner \
        /work \
        /github

# Rust
USER runner

RUN curl --proto '=https' --tlsv1.2 -sSf \
    https://sh.rustup.rs \
    | sh -s -- -y --profile default \
    && rustup component add rustfmt clippy \
    && rustup target add \
       x86_64-unknown-linux-gnu \
       aarch64-unknown-linux-gnu \
       x86_64-pc-windows-gnu

# GitHub Actions runner
WORKDIR /actions-runner

RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) RUNNER_ARCH="x64" ;; \
        arm64) RUNNER_ARCH="arm64" ;; \
        *) echo "Unsupported architecture: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    RUNNER_VERSION="$(curl -fsSL \
        https://api.github.com/repos/actions/runner/releases/latest \
        | jq -r '.tag_name' \
        | sed 's/^v//')"; \
    echo "Installing GitHub Actions Runner ${RUNNER_VERSION} (${RUNNER_ARCH})"; \
    curl -fsSL \
        "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz" \
        -o /tmp/actions-runner.tar.gz; \
    tar xzf /tmp/actions-runner.tar.gz; \
    rm /tmp/actions-runner.tar.gz; \
    sudo ./bin/installdependencies.sh

# Rust Windows linker configuration
RUN mkdir -p /home/runner/.cargo \
    && printf '%s\n' \
       '[target.x86_64-pc-windows-gnu]' \
       'linker = "x86_64-w64-mingw32-gcc"' \
       'ar = "x86_64-w64-mingw32-ar"' \
       > /home/runner/.cargo/config.toml

COPY --chown=runner:runner start.sh /actions-runner/start.sh
RUN chmod +x /actions-runner/start.sh

WORKDIR /actions-runner

# Startup begins as root only long enough to match the mounted Docker socket
# group. start.sh then drops privileges to the non-root runner user before
# configuring or running GitHub Actions.
USER root

CMD ["/actions-runner/start.sh"]