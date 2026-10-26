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
; not write over a running exe. It will move one, though, and the process
; runs on from where it went, as a replaced binary does on macOS and Linux.
; So each is moved aside before the files are copied, into a folder of its
; own under the same name: psmux takes a server whose exe is called anything
; but psmux for a dead one and forgets it, session and all. What is aside goes
; when nothing runs from it: now, or by a later install once that server has
; exited. A tick count keeps one update's folder from another's, whose
; server may still be running.
!macro ROER_MOVE_ASIDE NAME
  ${If} ${FileExists} "$INSTDIR\roer\${NAME}.exe"
    Push $0
    System::Call 'Kernel32::GetTickCount()i.r0'
    CreateDirectory "$INSTDIR\roer\aside\$0-${NAME}"
    ClearErrors
    Rename "$INSTDIR\roer\${NAME}.exe" "$INSTDIR\roer\aside\$0-${NAME}\${NAME}.exe"
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ROER_MOVE_ASIDE psmux
  !insertmacro ROER_MOVE_ASIDE roer
  ; Whatever nothing runs from: this update's own, and earlier ones'. A file
  ; in use, and the folder holding it, stay.
  RMDir /r "$INSTDIR\roer\aside"
!macroend

; What the updates left that nothing runs from any more, so the folder can go.
!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$INSTDIR\roer\aside"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  System::Call 'Kernel32::SetEnvironmentVariable(t "ROER_CLI_DIR", t "$INSTDIR\roer")i'
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$d = $$env:ROER_CLI_DIR; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @($$p -split ';' | Where-Object { $$_ }); if ($$parts -notcontains $$d) { [Environment]::SetEnvironmentVariable('Path', (@($$d) + $$parts) -join ';', 'User') }"`
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'Kernel32::SetEnvironmentVariable(t "ROER_CLI_DIR", t "$INSTDIR\roer")i'
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$d = $$env:ROER_CLI_DIR; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$d }); [Environment]::SetEnvironmentVariable('Path', $$parts -join ';', 'User')"`
!macroend
