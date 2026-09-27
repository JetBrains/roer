//! `roer-server`: runs the same backend the desktop app embeds, over plain
//! HTTP + WebSocket, so a browser tab can act as the frontend instead of a
//! native Tauri window.

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("ROER_SERVER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4317);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    roer_lib::server::serve(addr).await;
}
