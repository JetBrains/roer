//! `roer-server`: runs the same backend the desktop app embeds, over plain
//! HTTP + WebSocket, so a browser tab can act as the frontend instead of a
//! native Tauri window.
//!
//! - `ROER_SERVER_HOST` (default `127.0.0.1`), `ROER_SERVER_PORT` (default
//!   4317): set the host to `0.0.0.0` or an interface to reach this from a
//!   container's published port or another machine.
//! - `ROER_SERVER_PUBLIC_URL`: the address browsers use, if not the bind
//!   address — e.g. `https://roer.example` behind a TLS proxy.
//!
//! The server speaks plain HTTP only, and its token grants full terminal,
//! file, Git and GitHub access. Beyond loopback, put a TLS-terminating proxy
//! in front (forwarding `X-Forwarded-Proto: https`, which marks the session
//! cookie `Secure`, and preserving `Host`, which the Origin check compares
//! against) unless every hop is trusted.

#[tokio::main]
async fn main() {
    roer_lib::server::serve(roer_lib::server::default_addr()).await;
}
