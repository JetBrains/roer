#!/usr/bin/env bash
# Runs every tmux command roer depends on, exactly as roer runs it, against
# psmux, and reports what works. Spike tooling: it answers "which of these
# does psmux handle" before any of roer is changed for it.
set -u
MUX=${MUX:-psmux}
CONF=${CONF:-scripts/roer-tmux.conf}
SOCK=probe
DIR=$(pwd -W 2>/dev/null || pwd)
PASS=0 FAIL=0

m() { "$MUX" -L "$SOCK" -f "$CONF" "$@"; }
check() {  # check <label> <expected-substring|-> <command...>
    label=$1 want=$2; shift 2
    out=$("$@" 2>&1); code=$?
    if [ "$want" = - ]; then ok=$([ $code -eq 0 ] && echo y); else ok=$(printf '%s' "$out" | grep -qF -- "$want" && echo y); fi
    if [ -n "$ok" ]; then PASS=$((PASS+1)); printf 'PASS  %s\n' "$label"
    else FAIL=$((FAIL+1)); printf 'FAIL  %s (exit %s)\n      %s\n' "$label" "$code" "$(printf '%s' "$out" | head -5 | tr '\n' '|')"; fi
}
expect_fail() {  # the command must fail
    label=$1; shift
    if "$@" >/dev/null 2>&1; then FAIL=$((FAIL+1)); printf 'FAIL  %s (succeeded)\n' "$label"
    else PASS=$((PASS+1)); printf 'PASS  %s\n' "$label"; fi
}

echo "== $("$MUX" -V 2>&1)"
check "new-session -d -s -c (with -f)"          -      m new-session -d -s s1 -c "$DIR"
check "has-session =exact"                      -      m has-session -t =s1
expect_fail "has-session =prefix does not match"       m has-session -t =s
check "set-option @roer_id on =name:"           -      m set-option -t =s1: @roer_id abc
check "show-options -v -q @roer_id"             abc    m show-options -t =s1: -v -q @roer_id
check "set-option -g @roer_bin"                 -      m set-option -g @roer_bin 'C:\x\roer.exe'
check "show-options -gv @roer_bin"              'roer.exe' m show-options -gv @roer_bin
PANE=$(m list-panes -s -t =s1 -F '#{pane_id}' -f '#{&&:#{pane_active},#{window_active}}' 2>&1 | head -1)
check "list-panes -s -f active pane is %N"      %      echo "$PANE"
check "list-sessions -F"                        s1     m list-sessions -F '#{session_name}'
check "list-panes -a roer format" "abc	s1	$PANE	detached" m list-panes -a -F '#{@roer_id}	#{session_name}	#{pane_id}	#{?session_attached,attached,detached}	#{pane_current_path}	#{pane_current_command}	#{?#{||:#{==:#{pane_title},#{host}},#{==:#{pane_title},#{host_short}}},,#{pane_title}}'
check "display-message -p -t pane session"      s1     m display-message -p -t "$PANE" '#{session_name}'
check "display-message -p -t pane path"         -      m display-message -p -t "$PANE" '#{pane_current_path}'
echo "      path=$(m display-message -p -t "$PANE" '#{pane_current_path}' 2>&1) cmd=$(m display-message -p -t "$PANE" '#{pane_current_command}' 2>&1)"
check "load-buffer -b name -"                   -      bash -c "printf 'echo roer-probe-paste' | \"$MUX\" -L $SOCK -f $CONF load-buffer -b rb -"
check "paste-buffer -p -d -b -t"                -      m paste-buffer -p -d -b rb -t "$PANE"
check "send-keys Enter"                         -      m send-keys -t "$PANE" Enter
sleep 2
check "the paste ran in the pane"               roer-probe-paste m capture-pane -p -t "$PANE"
check "list-clients -t =s1 -F client_tty"       -      m list-clients -t =s1 -F '#{client_tty}'
# tmux itself fails this with "no current client" when nobody is attached,
# so it is only reported, not checked.
echo "      detach-client -s with no clients: $(m detach-client -s s1 2>&1; echo "exit $?")"
check "new-session with a command string"       -      m new-session -d -s s2 -c "$DIR" 'pwsh -NoLogo -NoProfile -Command Start-Sleep 30'
check "';' chaining a set-option"               -      m new-session -d -s s3 -c "$DIR" ';' set-option -g @chained yes
check "  ...and it applied"                     yes    m show-options -gv @chained
check "config: M-h bound to run-shell"          'M-h'  m list-keys
check "config: M-d detach"                      'M-d'  m list-keys
check "config: status off"                      off    m show-options -g status
check "config: history-limit 100000"            100000 m show-options -g history-limit
check "config: prefix None"                     None   m show-options -g prefix
# In a pane's context, as M-h's run-shell expands them.
check "socket_path (-t pane)"                   probe  m display-message -p -t "$PANE" '#{socket_path}'
echo "      socket_path -t pane=$(m display-message -p -t "$PANE" '#{socket_path}' 2>&1)  no target=$(m display-message -p '#{socket_path}' 2>&1)"
check "config_files (-t pane)"                  roer-tmux m display-message -p -t "$PANE" '#{config_files}'
check "M-h format expands @roer_bin (-t pane)"  'roer.exe' m display-message -p -t "$PANE" '#{?@roer_bin,#{@roer_bin},fallback}'
echo "      M-h: $(m list-keys 2>&1 | grep M-h)"
check "the chained session exists"              s3     m list-sessions -F '#{session_name}'
echo "      @chained=[$(m show-options -gv @chained 2>&1)] sessions=[$(m list-sessions -F '#{session_name}' 2>&1 | tr '\n' ' ')]"
# Which shell run-shell hands M-h's command to: roer's binding quotes a path
# in double quotes and passes %N, which cmd, pwsh and sh all take differently.
check "run-shell runs a quoted exe with args"   hello  m run-shell -t "$PANE" '"C:\Windows\System32\cmd.exe" /c echo hello'
echo "      run-shell 'echo %COMSPEC% \$PSVersionTable \$0': $(m run-shell -t "$PANE" 'echo %COMSPEC% $PSVersionTable $0' 2>&1 | head -2 | tr '\n' '|')"
# TMUX and TMUX_PANE, as roer inside a pane would see them.
m send-keys -t "$PANE" 'Write-Output "T=[$env:TMUX] P=[$env:TMUX_PANE]"' Enter; sleep 3
check "pane sees TMUX"                          'T=[' m capture-pane -p -t "$PANE"
echo "      pane shows: $(m capture-pane -p -t "$PANE" 2>&1 | grep -v '^\s*$' | tail -4 | tr '\n' '|')"
# Pane titles: roer lists what the program set with OSC 2.
m set-option -g allow-set-title on >/dev/null 2>&1
m send-keys -t "$PANE" 'Write-Host -NoNewline "$([char]27)]2;roer-title$([char]7)"' Enter; sleep 2
check "pane_title from OSC 2 (allow-set-title)"  roer-title m display-message -p -t "$PANE" '#{pane_title}'
echo "      pane_title=[$(m display-message -p -t "$PANE" '#{pane_title}' 2>&1)] host=[$(m display-message -p -t "$PANE" '#{host}' 2>&1)]"
# A prefix that is effectively none, if None itself is not accepted.
m set-option -g prefix None >/dev/null 2>&1; echo "      set prefix None: $(m show-options -g prefix 2>&1)"
m set-option -g prefix F24 >/dev/null 2>&1;  echo "      set prefix F24: $(m show-options -g prefix 2>&1)"
m unbind-key C-b >/dev/null 2>&1;            echo "      after unbind C-b: $(m list-keys 2>&1 | grep -c 'C-b') bindings mention C-b"
check "kill-server"                             -      m kill-server

echo "== round 3"
m new-session -d -s r3 -c "$DIR" >/dev/null 2>&1
P3=$(m list-panes -t =r3 -F '#{pane_id}' 2>&1 | head -1)
# Does -L really give a separate server?
check "-L isolates: probe sees r3"             r3     m list-sessions -F '#{session_name}'
echo "      other server lists: [$("$MUX" -L probe-other list-sessions -F '#{session_name}' 2>&1 | tr '\n' ' ')]"
"$MUX" -L probe-other kill-server >/dev/null 2>&1
# @roer_bin per session rather than global: formats may only see those.
m set-option -t =r3: @roer_bin 'C:\x\roer.exe' >/dev/null 2>&1
check "per-session @roer_bin expands in -t pane" 'roer.exe' m display-message -p -t "$P3" '#{?@roer_bin,#{@roer_bin},fallback}'
echo "      direct #{@roer_bin}=[$(m display-message -p -t "$P3" '#{@roer_bin}' 2>&1)]"
# Chaining with the other spellings tmux accepts.
m new-session -d -s c1 -c "$DIR" '\;' set-option -g @c1 yes >/dev/null 2>&1
echo "      chain '\\;': sessions=[$(m list-sessions -F '#{session_name}' 2>&1 | tr '\n' ' ')] @c1=[$(m show-options -gv @c1 2>&1)]"
m set-option -g @c2 a ';' set-option -g @c3 b >/dev/null 2>&1
echo "      chain two set-options: @c2=[$(m show-options -gv @c2 2>&1)] @c3=[$(m show-options -gv @c3 2>&1)]"
# The environment of a pane, written to a file rather than read off screen.
ENVF="$DIR\\probe-env.txt"
m new-session -d -s envs -c "$DIR" "pwsh -NoLogo -NoProfile -Command \"Set-Content -Path '$ENVF' -Value ('T=[' + \$env:TMUX + '] P=[' + \$env:TMUX_PANE + '] PS=[' + \$env:PSMUX + ']'); Start-Sleep 20\"" >/dev/null 2>&1
sleep 4
echo "      pane env: $(cat probe-env.txt 2>&1)"
check "pane has TMUX_PANE"                      'P=[%' cat probe-env.txt
# Titles, with allow-set-title on before the pane starts.
m set-option -g allow-set-title on >/dev/null 2>&1
m new-session -d -s titled -c "$DIR" "pwsh -NoLogo -NoProfile -Command \"\$Host.UI.RawUI.WindowTitle = 'roer-rawui'; Start-Sleep 20\"" >/dev/null 2>&1
m new-session -d -s osc -c "$DIR" "pwsh -NoLogo -NoProfile -Command \"Write-Host -NoNewline ([char]27 + ']2;roer-osc' + [char]7); Start-Sleep 20\"" >/dev/null 2>&1
sleep 4
echo "      titles: rawui=[$(m display-message -p -t =titled: '#{pane_title}' 2>&1)] osc=[$(m display-message -p -t =osc: '#{pane_title}' 2>&1)]"
check "OSC 2 title reaches pane_title"          roer-osc m display-message -p -t =osc: '#{pane_title}'
# Which prefixes psmux accepts.
for key in C-Space M-F12 F12 'C-]' 'C-\\'; do
    m set-option -g prefix "$key" >/dev/null 2>&1
    echo "      set prefix $key -> $(m show-options -g prefix 2>&1)"
done
m kill-server >/dev/null 2>&1

# Without -f, for comparison: does psmux need it, or read ~/.tmux.conf?
"$MUX" -L probe2 new-session -d -s x >/dev/null 2>&1
echo "      without -f, prefix=$("$MUX" -L probe2 show-options -g prefix 2>&1)"
"$MUX" -L probe2 kill-server >/dev/null 2>&1
echo "== $PASS passed, $FAIL failed"
