mod agents;
mod assets;
mod browse;
mod bun_fetch;
mod claude;
mod claude_setup;
mod codex;
mod junie;
mod keybindings;
mod live;
mod cli_link;
pub mod events;
mod extension_servers;
mod extension_tools;
mod extensions;
mod files;
mod gh;
mod git;
mod handoff;
mod history;
mod logfile;
mod other_apps;
mod pi;
mod plugin_ui;
mod pr_draft;
mod process;
mod projects;
pub mod pty;
mod roer;
pub mod server;
mod watch;
mod update_install;
mod updates;
mod workspaces;
mod worktrees;

#[cfg(test)]
mod testing;

pub fn run() {
    logfile::init();
    tauri::Builder::default()
        // Registered first, as the plugin requires. The handoff shim runs
        // `open -a Roer` to make sure the app is up; without this that would
        // start a rival instance with its own watcher racing for records.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch is someone asking for the app they already have.
            handoff::focus(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
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
            git::git_checked_out,
            keybindings::keybindings_get,
            keybindings::keybindings_set,
            git::git_repos_in,
            git::git_repo,
            git::git_branches,
            git::git_current_branch,
            git::git_branch_commits,
            git::git_commit_files,
            git::git_commit_diff,
            git::git_blob,
            git::git_branch_diff,
            git::git_commit_all,
            git::git_upstream_status,
            gh::gh_status,
            gh::gh_pr_for_branch,
            gh::gh_pr_create,
            gh::gh_request_copilot_review,
            gh::gh_pr_review,
            gh::gh_pr_diff,
            gh::gh_merge_methods,
            gh::gh_pr_merge,
            gh::gh_pr_can_bypass,
            gh::open_url,
            updates::update_check,
            updates::update_skip,
            update_install::update_install,
            files::files_search,
            files::file_read,
            roer::roer_sessions,
            roer::roer_past_sessions,
            roer::roer_status,
            roer::roer_send,
            roer::roer_kill,
            claude::roer_claude_threads,
            claude::roer_claude_search,
            claude::roer_claude_transcript,
            agents::agents_list,
            agents::agent_save,
            agents::agent_remove,
            agents::agent_set_default,
            agents::agent_command,
            agents::agent_models,
            claude_setup::claude_setup_status,
            claude_setup::claude_setup_apply,
            claude_setup::claude_setup_dismiss,
            other_apps::other_apps,
            other_apps::other_app_connect,
            workspaces::workspaces_list,
            workspaces::workspace_create,
            workspaces::workspace_rename,
            workspaces::workspace_delete,
            workspaces::workspace_set_folder,
            workspaces::workspace_attach_project,
            workspaces::workspace_detach_project,
            workspaces::workspace_assignments,
            worktrees::worktree_list,
            worktrees::worktree_create,
            worktrees::worktree_restore,
            worktrees::worktree_restorable,
            worktrees::worktree_remove,
            worktrees::worktree_uncommitted,
            worktrees::worktree_delete_branch,
            workspaces::workspace_assign,
            workspaces::workspace_unassign,
            plugin_ui::report_plugin_ui_action,
            plugin_ui::report_plugin_ui_receipt,
            plugin_ui::list_plugin_ui_bundles,
            plugin_ui::read_plugin_ui_bundle,
            plugin_ui::write_plugin_ui_bundle,
            projects::projects_list,
            projects::project_create,
            projects::project_rename,
            projects::project_delete,
            server::start_browser_server,
            server::copy_browser_link,
            logfile::app_log,
            files::files_grep,
            files::files_list,
            extensions::extensions_list,
            extensions::extension_bundle,
            extensions::extension_log,
            extensions::extensions_disabled,
            extensions::extension_set_enabled,
            extension_servers::extension_rpc,
            extension_tools::extension_tools_publish,
            extension_tools::extension_call_claim,
            extension_tools::extension_call_reply,
        ])
        .setup(|app| {
            menu(app)?;
            cli_link::install();
            handoff::watch(app.handle().clone())?;
            plugin_ui::watch(server::DesktopWatchSink(app.handle().clone()))?;
            pr_draft::watch(server::DesktopWatchSink(app.handle().clone()))?;
            extension_tools::watch(server::DesktopWatchSink(app.handle().clone()))?;
            extensions::watch(server::DesktopWatchSink(app.handle().clone()))?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running roer");
}

/// The app's own entry in the standard macOS menu: "Agent Integrations…"
/// under About, where an app keeps its settings, opening the same choice the
/// first launch offers. Only on macOS, which has an app menu whether an app
/// sets one or not; elsewhere setting one would add a menu bar to the window.
fn menu(app: &mut tauri::App) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem as Predefined, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
        use tauri::{Emitter, Manager};

        let handle = app.handle();
        let info = handle.package_info();
        let about = AboutMetadata {
            name: Some(info.name.clone()),
            version: Some(info.version.to_string()),
            copyright: handle.config().bundle.copyright.clone(),
            authors: handle.config().bundle.publisher.clone().map(|publisher| vec![publisher]),
            ..Default::default()
        };
        let setup = MenuItem::with_id(handle, "claude-setup", "Agent Integrations…", true, None::<&str>)?;
        let browser = MenuItem::with_id(handle, "browser-server", "Open This Session in a Browser…", true, None::<&str>)?;
        // Where a Mac app keeps its settings, and on the key every Mac app
        // opens them with.
        // On the key the person moved the Agents action to, if they did.
        let agents_key = keybindings::agents_accelerator(keybindings::load().as_object().unwrap_or(&serde_json::Map::new()));
        let agents = MenuItem::with_id(handle, "agents", "Agents…", true, agents_key.as_deref())?;
        app.manage(keybindings::AgentsMenuItem(agents.clone()));
        let updates = MenuItem::with_id(handle, "check-updates", "Check for Updates…", true, None::<&str>)?;
        // Tauri's default menu, but with Roer's own Close Window: the default
        // one is on ⌘W, and closing the window quits the app. That key is for
        // closing something small, the way a tab closes in other Mac apps, so
        // the window moves to ⇧⌘W.
        let close = || MenuItem::with_id(handle, "close-window", "Close Window", true, Some("CmdOrCtrl+Shift+W"));
        // Where a user reporting a problem finds the log to send with it.
        let logs = MenuItem::with_id(handle, "show-logs", "Show Logs in Finder", true, None::<&str>)?;
        let menu = Menu::with_items(
            handle,
            &[
                &Submenu::with_items(
                    handle,
                    info.name.clone(),
                    true,
                    &[
                        &Predefined::about(handle, None, Some(about))?,
                        // Right under About, where Mac apps keep it.
                        &updates,
                        &agents,
                        &setup,
                        &browser,
                        &Predefined::separator(handle)?,
                        &Predefined::services(handle, None)?,
                        &Predefined::separator(handle)?,
                        &Predefined::hide(handle, None)?,
                        &Predefined::hide_others(handle, None)?,
                        &Predefined::separator(handle)?,
                        &Predefined::quit(handle, None)?,
                    ],
                )?,
                &Submenu::with_items(handle, "File", true, &[&close()?])?,
                &Submenu::with_items(
                    handle,
                    "Edit",
                    true,
                    &[
                        &Predefined::undo(handle, None)?,
                        &Predefined::redo(handle, None)?,
                        &Predefined::separator(handle)?,
                        &Predefined::cut(handle, None)?,
                        &Predefined::copy(handle, None)?,
                        &Predefined::paste(handle, None)?,
                        &Predefined::select_all(handle, None)?,
                    ],
                )?,
                &Submenu::with_items(handle, "View", true, &[&Predefined::fullscreen(handle, None)?])?,
                &Submenu::with_id_and_items(
                    handle,
                    WINDOW_SUBMENU_ID,
                    "Window",
                    true,
                    &[
                        &Predefined::minimize(handle, None)?,
                        &Predefined::maximize(handle, None)?,
                        &Predefined::separator(handle)?,
                        &close()?,
                    ],
                )?,
                &Submenu::with_id_and_items(handle, HELP_SUBMENU_ID, "Help", true, &[&logs])?,
            ],
        )?;
        app.set_menu(menu)?;
        app.on_menu_event(|app, event| {
            if event.id() == "claude-setup" {
                let _ = app.emit("roer://claude-setup", ());
            } else if event.id() == "agents" {
                let _ = app.emit("roer://agents", ());
            } else if event.id() == "check-updates" {
                let _ = app.emit("roer://check-updates", ());
            } else if event.id() == "browser-server" {
                let _ = app.emit("roer://browser-server", ());
            } else if event.id() == "close-window" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            } else if event.id() == "show-logs" {
                // Runs `roer diagnose`, which is not for the menu's thread.
                std::thread::spawn(logfile::reveal);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}
