//! What lets a change reach the frontend, whichever host it is running
//! under: a native window's own event bus (Tauri) or a broadcast channel fed
//! to a WebSocket (`roer-server`, for a browser tab).
//!
//! Every place that used to take a bare `AppHandle` just to call `.emit` on
//! it now takes `impl Sink` instead, so the same watcher/notifier code runs
//! unchanged under either host.

use serde::Serialize;

/// Something a watcher can tell the frontend about, by name.
pub trait Sink: Clone + Send + 'static {
    fn emit<T: Serialize>(&self, event: &str, payload: &T);
}

impl Sink for tauri::AppHandle {
    fn emit<T: Serialize>(&self, event: &str, payload: &T) {
        let _ = tauri::Emitter::emit(self, event, payload);
    }
}

/// One message pushed down the server's WebSocket. `Event` is the browser's
/// `listen()`; `Channel` is the browser's `Channel.onmessage`, tagged with
/// the id the frontend made up when it created the channel.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ServerMsg {
    Event { event: String, payload: serde_json::Value },
    Channel { id: String, payload: serde_json::Value },
}

/// The server's event bus: cheap to clone, one per process, subscribed to by
/// every open WebSocket connection.
#[derive(Clone)]
pub struct Bus(pub tokio::sync::broadcast::Sender<ServerMsg>);

impl Bus {
    pub fn new() -> Self {
        let (tx, _rx) = tokio::sync::broadcast::channel(1024);
        Self(tx)
    }

    /// Pushed to a specific `Channel`, by the id the frontend minted for it.
    pub fn push_channel<T: Serialize>(&self, id: &str, payload: &T) {
        if let Ok(payload) = serde_json::to_value(payload) {
            let _ = self.0.send(ServerMsg::Channel { id: id.to_string(), payload });
        }
    }
}

impl Sink for Bus {
    fn emit<T: Serialize>(&self, event: &str, payload: &T) {
        if let Ok(payload) = serde_json::to_value(payload) {
            let _ = self.0.send(ServerMsg::Event { event: event.to_string(), payload });
        }
    }
}
