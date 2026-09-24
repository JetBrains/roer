; Put the roer command on the user's PATH, so `roer shell` works in any new
; terminal. The installer ships it as $INSTDIR\roer (see
; tauri.windows-cli.conf.json). PowerShell rather than an NSIS plugin: it
; edits the user PATH as a list, never truncating it, and SetEnvironmentVariable
; tells running programs, Explorer included, that it changed.
;
; The folder reaches PowerShell as the environment variable ROER_CLI_DIR, set
; with NSIS's own System plugin, rather than pasted into the command: any
; character a folder name may hold, an apostrophe included, then arrives as
; data and never as PowerShell syntax. $$ is a literal $ for PowerShell;
; backticks delimit the NSIS strings so PowerShell's quotes can sit inside.

!macro NSIS_HOOK_POSTINSTALL
  System::Call 'Kernel32::SetEnvironmentVariable(t "ROER_CLI_DIR", t "$INSTDIR\roer")i'
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$d = $$env:ROER_CLI_DIR; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @($$p -split ';' | Where-Object { $$_ }); if ($$parts -notcontains $$d) { [Environment]::SetEnvironmentVariable('Path', (@($$d) + $$parts) -join ';', 'User') }"`
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'Kernel32::SetEnvironmentVariable(t "ROER_CLI_DIR", t "$INSTDIR\roer")i'
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$d = $$env:ROER_CLI_DIR; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$d }); [Environment]::SetEnvironmentVariable('Path', $$parts -join ';', 'User')"`
!macroend
