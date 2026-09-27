mod browse;
mod claude;
mod claude_setup;
mod cli_link;
pub mod events;
mod files;
mod gh;
mod git;
mod handoff;
mod history;
mod plugin_ui;
mod pr_draft;
mod process;
mod projects;
pub mod pty;
mod roer;
pub mod server;
mod watch;
mod workspaces;

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
        .plugin(tauri_plugin_dialog::init())
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
            git::git_root,
            git::git_branches,
            git::git_current_branch,
            git::git_branch_commits,
            git::git_commit_files,
            git::git_commit_diff,
            git::git_upstream_status,
            gh::gh_status,
            gh::gh_pr_for_branch,
            gh::gh_pr_create,
            gh::gh_request_copilot_review,
            gh::gh_pr_review,
            gh::gh_merge_methods,
            gh::gh_pr_merge,
            gh::open_url,
            files::files_search,
            files::file_read,
            roer::roer_sessions,
            roer::roer_past_sessions,
            roer::roer_status,
            roer::roer_send,
            claude::roer_claude_threads,
            claude_setup::claude_setup_status,
            claude_setup::claude_setup_apply,
            claude_setup::claude_setup_dismiss,
            workspaces::workspaces_list,
            workspaces::workspace_create,
            workspaces::workspace_rename,
            workspaces::workspace_delete,
            workspaces::workspace_attach_project,
            workspaces::workspace_detach_project,
            workspaces::workspace_add_item,
            workspaces::workspace_remove_item,
            workspaces::workspace_assignments,
            workspaces::workspace_assign,
            workspaces::workspace_unassign,
            plugin_ui::report_plugin_ui_action,
            plugin_ui::list_plugin_ui_bundles,
            plugin_ui::read_plugin_ui_bundle,
            plugin_ui::write_plugin_ui_bundle,
            projects::projects_list,
            projects::project_create,
            projects::project_rename,
            projects::project_delete,
        ])
        .setup(|app| {
            menu(app)?;
            cli_link::install();
            handoff::watch(app.handle().clone())?;
            plugin_ui::watch(app.handle().clone())?;
            pr_draft::watch(app.handle().clone())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running roer");
}

/// The app's own entry in the standard macOS menu: "Claude Code Integration…"
/// under About, where an app keeps its settings, opening the same choice the
/// first launch offers. Only on macOS, which has an app menu whether an app
/// sets one or not; elsewhere setting one would add a menu bar to the window.
fn menu(app: &mut tauri::App) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{Menu, MenuItem};
        use tauri::Emitter;

        let handle = app.handle();
        let menu = Menu::default(handle)?;
        let setup = MenuItem::with_id(handle, "claude-setup", "Claude Code Integration…", true, None::<&str>)?;
        if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu().cloned()) {
            app_menu.insert(&setup, 1)?;
        }
        app.set_menu(menu)?;
        app.on_menu_event(|app, event| {
            if event.id() == "claude-setup" {
                let _ = app.emit("roer://claude-setup", ());
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}
