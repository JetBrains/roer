//! `roer-server`: runs the same backend the desktop app embeds, over plain
//! HTTP + WebSocket, so a browser tab can act as the frontend instead of a
//! native Tauri window.
//!
//! - `ROER_SERVER_HOST` (default `127.0.0.1`), `ROER_SERVER_PORT` (default
//!   4317): set the host to `0.0.0.0` or an interface to reach this from a
//!   container's published port or another machine.
//! - `ROER_SERVER_PUBLIC_URL`: the address browsers use, if not the bind
//!   address — e.g. `https://roer.example` behind a TLS proxy.
//! - `ROER_SERVER_TOKEN`: a fixed token (32+ of `A-Za-z0-9-_`) in place of
//!   a fresh one per start, so browsers stay authorized across restarts.
//! - `ROER_SERVER_TOKEN_SHA256`: in place of that, only the token's SHA-256
//!   (`printf %s "$token" | shasum -a 256`), so the server never holds the
//!   token itself. It then prints the login link with `<your token>` in it.
//!
//! The server speaks plain HTTP only, and its token grants full terminal,
//! file, Git and GitHub access. Beyond loopback, put a TLS-terminating proxy
//! in front (forwarding `X-Forwarded-Proto: https`, which marks the session
//! cookie `Secure`, and preserving `Host`, which the Origin check compares
//! against) unless every hop is trusted.

fn main() {
    // Out of the environment before any thread exists, so that no terminal,
    // agent or git the server starts inherits the token with it.
    let token = std::env::var("ROER_SERVER_TOKEN").ok();
    let token_sha256 = std::env::var("ROER_SERVER_TOKEN_SHA256").ok();
    std::env::remove_var("ROER_SERVER_TOKEN");
    std::env::remove_var("ROER_SERVER_TOKEN_SHA256");
    let runtime = tokio::runtime::Runtime::new().expect("could not start the async runtime");
    runtime.block_on(roer_lib::server::serve(roer_lib::server::default_addr(), token, token_sha256));
}
