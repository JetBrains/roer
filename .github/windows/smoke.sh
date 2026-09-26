#!/usr/bin/env bash
# Drives the real roer.exe against psmux on Windows, as the app and a terminal
# would, with a stand-in for the app that claims handoffs. The Unix
# counterpart is cli/tests/cli.rs; this is shell because half of what it
# checks happens in PowerShell inside a pane.
#
# usage: smoke.sh <directory holding roer.exe and psmux.exe>
set -u
BIN_DIR=$(cd "${1:?directory with roer.exe and psmux.exe}" && pwd)
ROER=$(cygpath -w "$BIN_DIR/roer.exe")
PSMUX="$BIN_DIR/psmux.exe"
export ROER_SOCKET=smoke ROER_HOME="$RUNNER_TEMP\\roer-home" ROER_APP='C:\nonexistent\roer-app.exe'
HOME_U=$(cygpath -u "$ROER_HOME")
PROJECT="$RUNNER_TEMP/project"; mkdir -p "$PROJECT"; cd "$PROJECT"
m() { "$PSMUX" -L smoke "$@"; }
PASS=0 FAIL=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$(printf '%s' "${2:-}" | head -8 | tr '\n' '|')"; }
has()  { printf '%s' "$2" | grep -qF -- "$3" && ok "$1" || bad "$1" "$2"; }

# The app: claim each handoff, keep a copy, and say it is on screen.
mkdir -p "$HOME_U/handoffs" "$RUNNER_TEMP/seen"
( while :; do
    for f in "$HOME_U"/handoffs/*.json; do
        [ -e "$f" ] || continue
        mv "$f" "$f.claimed" 2>/dev/null || continue
        cp "$f.claimed" "$RUNNER_TEMP/seen/$(basename "$f")"; rm -f "$f.claimed"
    done; sleep 0.1
  done ) & APP=$!
seen() { cat "$RUNNER_TEMP"/seen/*.json 2>/dev/null; }

out=$("$ROER" app 2>&1); code=$?
[ $code -eq 0 ] && ok "roer app exits 0" || bad "roer app exits 0 (got $code)" "$out"
has "roer app says it is open in Roer" "$out" "is open in Roer"
has "the app got an attach record" "$(seen)" '"attach"'
PANE=$(seen | grep -o '%[0-9]*' | head -1); echo "      pane=$PANE"

list=$("$ROER" list 2>&1)
has "roer list shows the session detached" "$list" "detached"
echo "      list: $(printf '%s' "$list" | tr '\t' '|')"
has "roer list has the project path" "$list" "project"
has "M-h is bound to this roer.exe" "$(m list-keys 2>&1 | grep 'M-h')" "roer.exe"
has "prefix moved off C-b" "$(m show-options -g prefix)" "M-F12"

rm -f "$RUNNER_TEMP"/seen/*.json
out=$("$ROER" handoff --pane "$PANE" 2>&1); code=$?
[ $code -eq 0 ] && ok "roer handoff --pane exits 0" || bad "roer handoff --pane (got $code)" "$out"
has "  ...its record names the pane" "$(seen)" "\"$PANE\""

# What M-h runs: the binding roer set, with the pane filled in, via run-shell.
rm -f "$RUNNER_TEMP"/seen/*.json
MH=$(m list-keys 2>&1 | grep 'M-h'); echo "      M-h: $MH"
has "roer bound M-h for PowerShell" "$MH" "run-shell -b &"
CMD=$(printf '%s' "$MH" | sed -e "s/.*run-shell -b //" -e "s/^[\"']//" -e "s/[\"']\$//" -e "s/#{pane_id}/$PANE/")
echo "      runs: $CMD"
rs=$(m run-shell -t "$PANE" "$CMD" 2>&1); echo "      run-shell exit=$? out=[$(printf '%s' "$rs" | tr '\n' '|')]"
echo "      run-shell env: [$(m run-shell -t "$PANE" 'cmd /c echo ROER_SOCKET=%ROER_SOCKET% ROER_HOME=%ROER_HOME%' 2>&1 | tr '\n' '|')]"
sleep 3
has "M-h's command hands the pane over" "$(seen)" "\"$PANE\""

printf 'echo roer-smoke-send' | "$ROER" send --pane "$PANE" >/dev/null 2>&1 && ok "roer send exits 0" || bad "roer send" ""
sleep 2
has "  ...the text ran in the pane" "$(m capture-pane -p -t "$PANE")" "roer-smoke-send"

printf '{"version":"v1.0","deleteSurface":{"surfaceId":"smoke"}}' | "$ROER" plugin-ui --pane "$PANE" && ok "plugin-ui --pane" || bad "plugin-ui --pane" ""
has "  ...record tagged with the pane" "$(cat "$HOME_U"/plugin-ui/*.json 2>/dev/null)" "\"$PANE\""

# From inside the pane, with no --pane: TMUX/TMUX_PANE and the inside check.
# What a pane inherits, before anything else.
m send-keys -t "$PANE" "\"TMUX=[\$env:TMUX] PANE=[\$env:TMUX_PANE] SOCK=[\$env:ROER_SOCKET] HOME=[\$env:ROER_HOME]\" | Set-Content -Path '$RUNNER_TEMP\\env.txt'" Enter
sleep 3
echo "      pane env: $(cat "$RUNNER_TEMP/env.txt" 2>&1)"
has "a pane has TMUX_PANE" "$(cat "$RUNNER_TEMP/env.txt" 2>&1)" "PANE=[%"
# The test's own variables, set in the pane explicitly: real use needs none.
m send-keys -t "$PANE" "\$env:ROER_SOCKET='smoke'; \$env:ROER_HOME='$ROER_HOME'; '{\"kind\":\"inside\"}' | & '$ROER' plugin-ui; \"exit=\$LASTEXITCODE\" | Set-Content -Path '$RUNNER_TEMP\\inside.txt'" Enter
sleep 5
T=$(cygpath -w "$RUNNER_TEMP")
inside=$(cat "$RUNNER_TEMP/inside.txt" 2>&1)
echo "      inside: $(printf '%s' "$inside" | tr '\n' '|')"
has "roer inside a pane finds its own pane" "$inside" "exit=0"
has "  ...and tags the record with it" "$(cat "$HOME_U"/plugin-ui/*.json 2>/dev/null)" '"inside"'

# shell: roer attaches in a terminal, here a pane of a second psmux server.
cat > "$RUNNER_TEMP/shell.ps1" <<PS1
# A terminal of its own, not a pane: psmux refuses to nest while any of
# these say otherwise.
\$env:TMUX = \$null; \$env:TMUX_PANE = \$null; \$env:PSMUX_SESSION = \$null
\$env:ROER_SOCKET = 'smoke'; \$env:ROER_HOME = '$ROER_HOME'
Set-Location '$(cygpath -w "$PROJECT")'
& '$ROER' shell 2> '$T\\shell.txt'
"exit=\$LASTEXITCODE" | Add-Content '$T\\shell.txt'
Start-Sleep 30
PS1
"$PSMUX" -L smoke-outer new-session -d "pwsh -NoLogo -NoProfile -File $T\\shell.ps1" >/dev/null 2>&1
sleep 6
has "roer shell attached a client" "$(m list-sessions -F '#{session_name} #{session_attached}')" " 1"
echo "      sessions: $(m list-sessions -F '#{session_name} #{session_attached}' 2>&1 | tr '\n' '|')"
echo "      roer shell wrote: $(cat "$RUNNER_TEMP/shell.txt" 2>&1 | tr '\n' '|')"
echo "      outer pane: $("$PSMUX" -L smoke-outer capture-pane -p 2>&1 | grep -v '^\s*$' | tail -6 | tr '\n' '|')"

kill $APP 2>/dev/null
"$PSMUX" -L smoke-outer kill-server >/dev/null 2>&1; m kill-server >/dev/null 2>&1
echo "== $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
