# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser, vercel): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin CLI versions for reproducibility. Bump deliberately — unpinned installs
# mean every rebuild silently picks up the latest and can break in lockstep
# across all users.
ARG CLAUDE_CODE_VERSION=2.1.116
ARG OPENCODE_VERSION=1.15.10
ARG CODEX_VERSION=0.144.1
ARG AGENT_BROWSER_VERSION=0.27.2
ARG VERCEL_VERSION=latest
ARG BUN_VERSION=1.3.12

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        ffmpeg \
        file \
        git \
        jq \
        less \
        python3 \
        python-is-python3 \
        python3-jsonschema \
        python3-pip \
        ripgrep \
        tini \
        tree \
        unzip \
        zip \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - esbuild installs its runtime binary during postinstall.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
#   - opencode-ai's postinstall installs the OpenCode runtime wrapper; pnpm
#     global install leaves the placeholder shim in place unless we run it
#     explicitly in the OpenCode layer below.
ENV PNPM_HOME="/pnpm"
ENV PATH="/app/skills/.bin:${PNPM_HOME}/bin:${PNPM_HOME}:$PATH"
RUN corepack enable

RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    echo "only-built-dependencies[]=esbuild" >> /root/.npmrc && \
    echo "only-built-dependencies[]=@anthropic-ai/claude-code" >> /root/.npmrc && \
    echo "only-built-dependencies[]=opencode-ai" >> /root/.npmrc && \
    printf '%s\n' \
      'export PNPM_HOME=/pnpm' \
      'case ":$PATH:" in' \
      '  *:/pnpm:*) ;;' \
      '  *) export PATH="/pnpm:$PATH" ;;' \
      'esac' \
      'case ":$PATH:" in' \
      '  *:/pnpm/bin:*) ;;' \
      '  *) export PATH="/pnpm/bin:$PATH" ;;' \
      'esac' \
      'case ":$PATH:" in' \
      '  *:/app/skills/.bin:*) ;;' \
      '  *) export PATH="/app/skills/.bin:$PATH" ;;' \
      'esac' > /etc/profile.d/pnpm-home.sh && \
    export PATH="/pnpm/bin:/pnpm:$PATH" && \
    pnpm install -g "vercel@${VERCEL_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    export PATH="/pnpm/bin:/pnpm:$PATH" && \
    pnpm install -g "agent-browser@${AGENT_BROWSER_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    export PATH="/pnpm/bin:/pnpm:$PATH" && \
    pnpm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    export PATH="/pnpm/bin:/pnpm:$PATH" && \
    pnpm install -g "opencode-ai@${OPENCODE_VERSION}" && \
    opencode_pkg="$(find "$PNPM_HOME/global" -path '*/node_modules/opencode-ai' -print -quit)" && \
    test -n "$opencode_pkg" && \
    cd "$opencode_pkg" && \
    node postinstall.mjs && \
    opencode --version

RUN --mount=type=cache,target=/root/.cache/pnpm \
    export PATH="/pnpm/bin:/pnpm:$PATH" && \
    pnpm install -g "@openai/codex@${CODEX_VERSION}" && \
    codex --version && \
    codex app-server --help | grep -F -- '--strict-config' && \
    codex app-server --help | grep -F -- '--listen'

# ---- GWS policy proxy shim ---------------------------------------------------
# Agent containers must not include the real Google Workspace CLI or OAuth
# files. This CLI-shaped shim forwards to gws-proxy; OneCLI injects the proxy
# authorization header for the configured GWS_PROXY_URL host.
COPY shim/gws /usr/local/bin/gws
COPY shim/curl /usr/local/bin/curl
COPY shim/gws-request.mjs /usr/local/lib/nanoclaw/gws-request.mjs
COPY shim/gws-v0.18.1-write-operations.json /usr/local/share/nanoclaw/gws-v0.18.1-write-operations.json
RUN chmod +x /usr/local/bin/gws /usr/local/bin/curl

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
# Agent containers may run as the host `nanoclaw` uid/gid so bind-mounted
# session files stay writable. Chromium needs writable config and cache
# directories for crashpad and profile startup.
RUN mkdir -p \
        /workspace/agent \
        /workspace/extra \
        /home/node/.agent-browser \
        /home/node/.cache \
        /home/node/.config && \
    chown -R node:node /workspace /home/node/.agent-browser /home/node/.cache /home/node/.config && \
    chmod 777 /home/node /home/node/.agent-browser /home/node/.cache /home/node/.config

USER node
WORKDIR /workspace/agent

# tini is PID 1, reaps zombies, forwards signals cleanly. entrypoint.sh does
# `exec bun ...` so bun runs as tini's direct child.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
