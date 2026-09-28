//! The built frontend (`npm run build`'s `dist/`), embedded into `roer_lib`
//! at compile time so `roer-server` — standalone or spawned in-process by
//! the desktop app — is a self-contained browser experience with no Vite
//! dev server to depend on. Run `npm run build` before `cargo build` if
//! `dist/` is stale or missing; an empty embed just means every route below
//! 404s.

use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../dist"]
pub struct Frontend;
