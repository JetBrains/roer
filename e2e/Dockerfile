# The Linux e2e run on a Mac or anywhere else with Docker: what CI's e2e job
# installs, in one image. See e2e/docker.sh.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
# As on GitHub's runners and a desktop. Without a UTF-8 locale tmux 3.4 writes
# the tabs in roer list's rows as `_`.
ENV LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl git pkg-config \
      libwebkit2gtk-4.1-dev libxdo-dev libssl-dev librsvg2-dev \
      tmux webkit2gtk-driver xvfb xauth dbus-x11 ffmpeg \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
    && cargo install tauri-driver --locked
WORKDIR /roer
