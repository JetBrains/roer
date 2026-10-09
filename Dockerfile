# roer-server in a container: Roer's backend and frontend, used from a
# browser. See docs/self-hosting.md for running it on a server.
#
#   docker build -t roer-server .
#   docker run -d --name roer -p 127.0.0.1:4317:4317 -v roer-home:/home/roer roer-server
#   docker logs roer          # the URL to open once per browser
#
# Builds for whichever platform it runs on; `docker buildx build --platform
# linux/amd64,linux/arm64` makes both.

# The frontend, which the server embeds at compile time (src-tauri/src/assets.rs).
FROM node:24-trixie-slim AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts components.json ./
COPY src src
RUN npm run build

FROM rust:1-trixie AS backend
# What the `tauri` crate links against on Linux, as in CI's checks job.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev libxdo-dev libssl-dev librsvg2-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY cli cli
# `roer` finds its tmux config and skills beside itself, laid out as in the
# Linux CLI download (release.yml).
COPY scripts/roer-tmux.conf /opt/roer/roer-tmux.conf
COPY .claude/skills /opt/roer/skills
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/cli/target \
    cargo build --release --locked --manifest-path cli/Cargo.toml \
 && cp cli/target/release/roer /opt/roer/roer \
 && /opt/roer/roer help > /dev/null
COPY src-tauri src-tauri
COPY --from=frontend /src/dist dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/src-tauri/target \
    cargo build --release --locked --manifest-path src-tauri/Cargo.toml --features server-bin --bin roer-server \
 && cp src-tauri/target/release/roer-server /usr/local/bin/roer-server

FROM debian:trixie-slim
# tmux runs the sessions; git, gh and ssh are what agents and the Changes
# view use; curl fetches Bun the first time an extension is built.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gh openssh-client tmux less procps \
      libwebkit2gtk-4.1-0 libxdo3 \
 && rm -rf /var/lib/apt/lists/*

# Claude Code, installed for everyone rather than into the home volume, so a
# new image brings a new version. The image is what updates it: a new
# version is a change here, or `--build-arg CLAUDE_CODE_VERSION=…`.
ARG CLAUDE_CODE_VERSION=2.1.295
RUN curl -fsSL https://claude.ai/install.sh | HOME=/tmp/claude bash -s "$CLAUDE_CODE_VERSION" \
 && cp -L /tmp/claude/.local/bin/claude /usr/local/bin/claude \
 && rm -rf /tmp/claude
ENV DISABLE_AUTOUPDATER=1

COPY --from=backend /opt/roer /opt/roer
COPY --from=backend /usr/local/bin/roer-server /usr/local/bin/
RUN ln -s /opt/roer/roer /usr/local/bin/roer

RUN useradd --create-home --uid 1000 --shell /bin/bash roer
USER roer
WORKDIR /home/roer
# Everything worth keeping: projects, Roer's own state, and the logins for
# Claude, gh and git.
VOLUME /home/roer

# The server only speaks HTTP: publish it on 127.0.0.1 and put a TLS proxy
# in front, or reach it over an SSH tunnel or a private network.
ENV LANG=C.UTF-8 \
    SHELL=/bin/bash \
    ROER_SERVER_HOST=0.0.0.0 \
    ROER_SERVER_PORT=4317
EXPOSE 4317
CMD ["roer-server"]
