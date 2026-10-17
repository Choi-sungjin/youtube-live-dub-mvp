$ErrorActionPreference = 'Stop'
$dubRoot = Split-Path -Parent $PSScriptRoot
$dubOrigin = 'http://127.0.0.1:18789'
try {
    $health = Invoke-RestMethod "$dubOrigin/api/health" -TimeoutSec 2
    if ($health.ok -and $health.version) {
        Write-Output "Live Dub v$($health.version) is already running: $dubOrigin/diagnostics"
        exit 0
    }
} catch {}
$dubCache = Join-Path $dubRoot 'backend\.cache'
New-Item -ItemType Directory -Path $dubCache -Force | Out-Null
$env:PORT = '18789'
$env:HOST = '127.0.0.1'
$dubProcess = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList 'backend/server.js' -WorkingDirectory $dubRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dubCache 'local.stdout.log') -RedirectStandardError (Join-Path $dubCache 'local.stderr.log') -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 200
    if ($dubProcess.HasExited) { throw "Backend exited. Check $dubCache\local.stderr.log" }
    try {
        $health = Invoke-RestMethod "$dubOrigin/api/health" -TimeoutSec 1
        if ($health.ok -and $health.version) {
            Write-Output "Live Dub v$($health.version) started: $dubOrigin/diagnostics"
            exit 0
        }
    } catch {}
}
throw "Backend did not become ready. Check $dubCache\local.stderr.log"
