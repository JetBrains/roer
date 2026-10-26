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

; Sessions keep running through an update: their psmux server, and a
; `roer mcp` an agent holds open, run out of $INSTDIR\roer, and Windows will
; not write over a running exe. It will rename one, though, and the process
; runs on from the renamed file, as a replaced binary does on macOS and
; Linux. So each is moved aside before the files are copied, and deleted
; when nothing runs from it: now, or by a later install, as a server that was
; running exits. A tick count keeps the names apart while an earlier update's
; file is still in use.
!macro ROER_MOVE_ASIDE NAME
  ${If} ${FileExists} "$INSTDIR\roer\${NAME}.exe"
    Push $0
    System::Call 'Kernel32::GetTickCount()i.r0'
    ClearErrors
    Rename "$INSTDIR\roer\${NAME}.exe" "$INSTDIR\roer\${NAME}-$0.old"
    Delete "$INSTDIR\roer\${NAME}-$0.old"
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\roer\*.old"
  !insertmacro ROER_MOVE_ASIDE psmux
  !insertmacro ROER_MOVE_ASIDE roer
!macroend

; What the updates left that nothing runs from any more, so the folder can go.
!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\roer\*.old"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  System::Call 'Kernel32::SetEnvironmentVariable(t "ROER_CLI_DIR", t "$INSTDIR\roer")i'
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$d = $$env:ROER_CLI_DIR; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @($$p -split ';' | Where-Object { $$_ }); if ($$parts -notcontains $$d) { [Environment]::SetEnvironmentVariable('Path', (@($$d) + $$parts) -join ';', 'User') }"`
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'Kernel32::SetEnvironmentVariable(t "ROER_CLI_DIR", t "$INSTDIR\roer")i'
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$d = $$env:ROER_CLI_DIR; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$d }); [Environment]::SetEnvironmentVariable('Path', $$parts -join ';', 'User')"`
!macroend
