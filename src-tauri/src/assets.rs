//! The built frontend (`npm run build`'s `dist/`), embedded into `roer_lib`
//! at compile time so `roer-server` — standalone or spawned in-process by
//! the desktop app — is a self-contained browser experience with no Vite
//! dev server to depend on. Run `npm run build` before `cargo build` if
//! `dist/` is stale or missing.
//!
//! A missing `dist/` still compiles: behind the Vite dev server (the
//! "Browser Experience" run configuration) the frontend comes from Vite, not
//! from here, and `server::static_asset` says what to run otherwise.

use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../dist"]
#[allow_missing = true]
pub struct Frontend;
