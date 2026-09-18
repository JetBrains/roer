mod files;
mod git;
mod handoff;
mod pty;
mod roer;
mod watch;

#[cfg(test)]
mod testing;

pub fn run() {
    tauri::Builder::default()
        // Registered first, as the plugin requires. The handoff shim runs
        // `open -a Roer` to make sure the app is up; without this that would
        // start a rival instance with its own watcher racing for records.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch is someone asking for the app they already have.
            handoff::focus(app);
        }))
        .manage(pty::PtyState::default())
        .manage(files::FileIndex::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            handoff::handoff_pending,
            handoff::handoff_claim,
            handoff::handoff_ack,
            handoff::handoff_fail,
            git::git_changes,
            git::git_diff,
            files::files_search,
            files::file_read,
            roer::roer_sessions,
            roer::roer_status,
        ])
        .setup(|app| {
            handoff::watch(app.handle().clone())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running roer");
}
