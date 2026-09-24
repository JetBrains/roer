; Put the roer command on the user's PATH, so `roer shell` works in any new
; terminal. The installer ships it as $INSTDIR\roer (see
; tauri.windows-cli.conf.json). PowerShell rather than an NSIS plugin: it
; edits the user PATH as a list, never truncating it, and SetEnvironmentVariable
; tells running programs, Explorer included, that it changed.
;
; Backticks delimit the NSIS strings so PowerShell's own quotes can sit inside
; them; $$ is a literal $ for PowerShell, $INSTDIR is NSIS's.

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\roer'; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @($$p -split ';' | Where-Object { $$_ }); if ($$parts -notcontains $$d) { [Environment]::SetEnvironmentVariable('Path', (@($$d) + $$parts) -join ';', 'User') }"`
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\roer'; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$d }); [Environment]::SetEnvironmentVariable('Path', $$parts -join ';', 'User')"`
!macroend
