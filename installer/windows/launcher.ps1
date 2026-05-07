# Daemora launcher (Windows)
#
# What it does:
#   default mode -> ensure daemon is running, then open the web UI
#   -OpenOnly    -> just open the web UI (no start)
#   -Stop        -> kill the running daemon
#
# Invoked by Start Menu / Desktop shortcuts via:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File launcher.ps1 [-OpenOnly|-Stop]
#
# Daemon process model: started detached and hidden, PID written to
# %APPDATA%\Daemora\daemora.pid. Stays alive when the launcher exits,
# the browser closes, or the user signs out (until reboot or Stop).

[CmdletBinding()]
param(
    [switch]$Stop,
    [switch]$OpenOnly
)

$ErrorActionPreference = 'Stop'

$Port      = 8081
$Url       = "http://localhost:$Port"
$DataDir   = Join-Path $env:APPDATA 'Daemora'
$PidFile   = Join-Path $DataDir 'daemora.pid'
# Start-Process refuses to redirect stdout and stderr to the same file
# in PS 5.1, so we keep them separate. Both go to the data dir.
$LogOut    = Join-Path $DataDir 'daemora.log'
$LogErr    = Join-Path $DataDir 'daemora.err.log'

if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}

function Show-Error([string]$msg) {
    Add-Type -AssemblyName PresentationFramework -ErrorAction SilentlyContinue
    [System.Windows.MessageBox]::Show($msg, 'Daemora', 'OK', 'Error') | Out-Null
}

# Resolve daemora.cmd via PATH. Returns the full path or $null if not found.
function Find-DaemoraCmd {
    $c = Get-Command daemora.cmd -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $c = Get-Command daemora -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    # Fall back to npm's standard global prefix on Windows.
    $candidate = Join-Path $env:APPDATA 'npm\daemora.cmd'
    if (Test-Path $candidate) { return $candidate }
    return $null
}

function Test-HealthEndpoint {
    try {
        $r = Invoke-WebRequest -Uri "$Url/health" -UseBasicParsing -TimeoutSec 2
        return $r.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Test-DaemonRunning {
    if (Test-HealthEndpoint) { return $true }
    if (-not (Test-Path $PidFile)) { return $false }
    $daemonPid = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $daemonPid) { return $false }
    return $null -ne (Get-Process -Id $daemonPid -ErrorAction SilentlyContinue)
}

function Stop-Daemon {
    # Kill recorded PID and its child process tree
    if (Test-Path $PidFile) {
        $daemonPid = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($daemonPid) {
            & taskkill /PID $daemonPid /T /F 2>$null | Out-Null
        }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
    # Belt-and-braces: kill anything still bound to the port (handles stale pidfiles)
    try {
        Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique |
            ForEach-Object {
                Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
            }
    } catch { }
}

function Start-Daemon {
    # daemora itself auto-opens the browser when it detects a TTY; we
    # spawn it without one so we can poll /health first and avoid the
    # connection-refused flash on first paint.
    $env:DAEMORA_NO_OPEN = '1'

    $daemoraCmd = Find-DaemoraCmd
    if (-not $daemoraCmd) {
        Show-Error "daemora is not on PATH. Re-run the Daemora installer to fix this."
        return $false
    }

    # Truncate previous logs so each launch is a clean record.
    Set-Content -Path $LogOut -Value '' -Force
    Set-Content -Path $LogErr -Value '' -Force

    # Start-Process invokes daemora.cmd directly (no cmd.exe wrapping)
    # and redirects stdout/stderr to separate log files. Hidden window
    # = no terminal flash. Daemon survives this script exiting because
    # we don't -Wait and we don't propagate the parent shell's lifecycle.
    $proc = Start-Process -FilePath $daemoraCmd `
        -ArgumentList @('start') `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $LogOut `
        -RedirectStandardError $LogErr `
        -WorkingDirectory $env:USERPROFILE

    if (-not $proc) {
        Show-Error "Failed to spawn daemora process. Check $LogErr."
        return $false
    }

    $proc.Id | Out-File -FilePath $PidFile -Encoding ASCII -Force

    # Poll /health for up to 120s. First boot has to load skills, embeddings,
    # MCP, etc. — observed up to ~60s on a fresh install with cold disk.
    # Subsequent boots are much faster (caches warm).
    for ($i = 0; $i -lt 120; $i++) {
        if (Test-HealthEndpoint) { return $true }
        # If the process died, surface the error log instead of waiting
        # the full timeout.
        if ($proc.HasExited) {
            $err = ''
            try { $err = (Get-Content $LogErr -Raw -ErrorAction SilentlyContinue) } catch { }
            if (-not $err) {
                try { $err = (Get-Content $LogOut -Raw -ErrorAction SilentlyContinue) } catch { }
            }
            if (-not $err) { $err = '(no output captured)' }
            Show-Error "Daemora exited immediately (code $($proc.ExitCode)). Output:`n`n$err"
            return $false
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Open-Browser {
    Start-Process $Url | Out-Null
}

# --- main ---

if ($Stop) {
    Stop-Daemon
    exit 0
}

if ($OpenOnly) {
    Open-Browser
    exit 0
}

if (-not (Test-DaemonRunning)) {
    if (-not (Start-Daemon)) {
        Show-Error "Daemora failed to start within 120s. See logs:`n$LogOut`n$LogErr"
        exit 1
    }
}

Open-Browser
exit 0
