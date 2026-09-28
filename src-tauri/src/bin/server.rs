//! `roer-server`: runs the same backend the desktop app embeds, over plain
//! HTTP + WebSocket, so a browser tab can act as the frontend instead of a
//! native Tauri window.

#[tokio::main]
async fn main() {
    // `ROER_SERVER_HOST` (default `127.0.0.1`) and `ROER_SERVER_PORT`
    // (default 4317) — set the host to `0.0.0.0` or a specific interface to
    // reach this from a container's published address or another machine.
    roer_lib::server::serve(roer_lib::server::default_addr()).await;
}
