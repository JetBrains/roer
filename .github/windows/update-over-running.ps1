# What "Update and restart" does on Windows: an installed Roer $From, a real
# release, is running, with a psmux server out of its folder (as sessions
# keep one), when $To's setup runs as the updater runs it, `/P /UPDATE /R`.
# The setup must finish on its own, leave every file it ships as it ships
# it, the running psmux.exe included, start the app again, and leave the
# session alive. Then once more, while the first update's moved-aside
# psmux.exe still runs that session.
#
# Here the setup is started beside the running app; the updater starts it and
# quits. Either way the setup finds the app running and closes it.
#
# usage: update-over-running.ps1 -From 0.9.11 -To 0.9.15 [-Setup <setup.exe>] -Out <folder>
# with GH_TOKEN set, for `gh release download`. -Setup is $To's setup built
# from the checkout; without it, release $To's.
param(
    [Parameter(Mandatory)] [string] $From,
    [Parameter(Mandatory)] [string] $To,
    [string] $Setup,
    [Parameter(Mandatory)] [string] $Out
)
$ErrorActionPreference = 'Stop'
$script:failed = 0
function Pass($what) { Write-Host "PASS  $what" }
function Fail($what, $detail) {
    $script:failed++
    Write-Host "FAIL  $what"
    if ($detail) { Write-Host "      $detail" }
}
function Check($what, [bool] $ok, $detail) { if ($ok) { Pass $what } else { Fail $what $detail } }

New-Item -ItemType Directory -Force $Out | Out-Null
$work = Join-Path $env:RUNNER_TEMP 'roer-update'
New-Item -ItemType Directory -Force $work | Out-Null

# What is on screen, for the artifact: a dialog the setup is stuck on is
# only seen there.
function Shot($name) {
    try {
        Add-Type -AssemblyName System.Windows.Forms, System.Drawing
        $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $Out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose(); $bitmap.Dispose()
    } catch {
        Write-Host "      (no screenshot: $_)"
    }
}

# Each release's setup, checked against its SHA256SUMS.txt.
function Setup($version) {
    $dir = Join-Path $work $version
    gh release download "v$version" --repo $env:GITHUB_REPOSITORY --dir $dir --clobber `
        --pattern "Roer_${version}_x64-setup.exe" --pattern SHA256SUMS.txt
    if ($LASTEXITCODE) { throw "could not download Roer $version" }
    $file = Join-Path $dir "Roer_${version}_x64-setup.exe"
    $line = Get-Content (Join-Path $dir SHA256SUMS.txt) | Where-Object { $_ -match "\*?Roer_${version}_x64-setup\.exe$" }
    $expected = ($line -split '\s+')[0]
    if ((Get-FileHash $file -Algorithm SHA256).Hash -ne $expected) { throw "Roer $version's setup does not match its checksum" }
    $file
}

# The per-user install the setup made, as Windows lists it.
function Installed {
    Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall |
        Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Roer' } | Select-Object -First 1
}

$old = Setup $From
$new = if ($Setup) { $Setup } else { Setup $To }

# The new setup's files, to hold the install to afterwards. 7-Zip reads NSIS.
$shipped = Join-Path $work 'shipped'
& "$env:ProgramFiles\7-Zip\7z.exe" x $new "-o$shipped" -y | Out-Null
if ($LASTEXITCODE) { throw "could not unpack Roer $To's setup" }

Write-Host "== Roer $From, installed and running"
Start-Process $old -ArgumentList '/S' -Wait
$entry = Installed
if (-not $entry) { throw "Roer $From's setup installed nothing Windows lists" }
Check "Roer $From is installed" ($entry.DisplayVersion -eq $From) "DisplayVersion $($entry.DisplayVersion)"
# DisplayIcon is the app, possibly quoted and with an icon index.
$app = ($entry.DisplayIcon -replace '"', '') -replace ',\d+$', ''
$dir = Split-Path $app
Write-Host "      app: $app"
$psmux = Join-Path $dir 'roer\psmux.exe'
$roer = Join-Path $dir 'roer\roer.exe'
Check "psmux and roer are beside the app" ((Test-Path $psmux) -and (Test-Path $roer))

# A session, as one keeps its psmux server running out of the install.
& $psmux -L roer-update-check new-session -d -s held
Start-Sleep 2
$server = Get-Process psmux -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $psmux }
Check "a psmux server runs from the install" ([bool] $server)
Start-Process $app
Start-Sleep 10
Check "Roer $From is running" ([bool] (Get-Process | Where-Object { $_.Path -eq $app }))
Shot 'before'

# $To's setup, as the updater runs it, and what it must leave.
function Update($pass) {
    Write-Host "== Roer $To's setup, as the updater runs it ($pass)"
    $started = Get-Date
    $run = Start-Process $new -ArgumentList '/P', '/UPDATE', '/R' -PassThru
    if (-not $run.WaitForExit(300000)) {
        Shot "stuck-$pass"
        Fail "the setup finishes on its own" "still running after 5 minutes: see stuck-$pass.png, likely a dialog"
        Stop-Process -Id $run.Id -Force
    } else {
        Check "the setup finishes on its own" ($run.ExitCode -eq 0) "exit code $($run.ExitCode)"
    }

    $entry = Installed
    Check "Windows lists Roer $To" ($entry.DisplayVersion -eq $To) "DisplayVersion $($entry.DisplayVersion)"
    $version = (Get-Item $app).VersionInfo.ProductVersion
    Check "the app is $To" ($version -like "$To*") "ProductVersion $version"

    # Every file the setup ships, as it ships it: one left as it was because
    # it was in use fails here, unless both releases have it the same.
    foreach ($name in 'roer.exe', 'psmux.exe', (Split-Path $app -Leaf)) {
        $installed = if ($name -eq (Split-Path $app -Leaf)) { $app } else { Join-Path $dir "roer\$name" }
        $hash = (Get-FileHash $installed).Hash
        $candidates = Get-ChildItem $shipped -Recurse -File -Filter $name | ForEach-Object { (Get-FileHash $_.FullName).Hash }
        Check "$name is the new setup's" ($candidates -contains $hash) "installed $hash; setup has $($candidates -join ', ')"
    }

    # The server runs on from the file moved aside, which stays until it exits.
    Write-Host "      psmux runs from: $((Get-Process psmux -ErrorAction SilentlyContinue).Path -join ', ')"
    Write-Host "      left aside: $((Get-ChildItem (Join-Path $dir 'roer') -Filter *.old).Name -join ', ')"

    # /R: the app again, started by the setup.
    $deadline = (Get-Date).AddSeconds(60)
    do {
        $again = Get-Process | Where-Object { $_.Path -eq $app -and $_.StartTime -gt $started }
        if ($again) { break }
        Start-Sleep 2
    } while ((Get-Date) -lt $deadline)
    Check "the setup started the app again" ([bool] $again)
    & $psmux -L roer-update-check has-session -t held 2>$null
    Check "the session outlived the update" ($LASTEXITCODE -eq 0)
    Shot "after-$pass"
}

Update 'first'
# The first update's psmux.exe, moved aside, still runs the session: the
# next setup cannot delete it, and must not trip over it either.
Update 'again'

# Once that server is gone, the next install clears what it ran from.
& $psmux -L roer-update-check kill-server 2>$null
Start-Sleep 2
Start-Process $new -ArgumentList '/S' -Wait
$left = Get-ChildItem (Join-Path $dir 'roer') -Filter *.old
Check "nothing is left aside once nothing runs from it" (-not $left) ($left.Name -join ', ')

& $psmux -L roer-update-check kill-server 2>$null
Get-Process | Where-Object { $_.Path -eq $app } | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "== $script:failed failed"
exit [int] ($script:failed -gt 0)
