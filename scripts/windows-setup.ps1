# Shared Windows PowerShell 5.1 installer functions. Dot-sourcing has no side effects.
function Invoke-DubCommand {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE): $Executable" }
}

function Update-DubProcessPath {
    $extra = @("$env:LOCALAPPDATA\Programs\Ollama", "$env:LOCALAPPDATA\Programs\Python\Python312",
        "$env:LOCALAPPDATA\Programs\Python\Launcher", "$env:ProgramFiles\nodejs",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links")
    $env:PATH = (($env:PATH, [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User')) + $extra) -join ';'
}

function Get-DubTool {
    param([ValidateSet('Node', 'Python', 'FFmpeg', 'Ollama', 'Chrome')][string]$Name)
    switch ($Name) {
        'Node' {
            $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
            if ($cmd) {
                $version = & $cmd.Source --version
                if ($LASTEXITCODE -eq 0 -and "$version" -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { return $cmd.Source }
            }
        }
        'Python' {
            $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
            if ($launcher) {
                $previousPreference = $ErrorActionPreference
                try {
                    $ErrorActionPreference = 'Continue'
                    $found = & $launcher.Source -3.12 -c 'import sys; assert sys.maxsize > 2**32; print(sys.executable)' 2>$null
                } finally { $ErrorActionPreference = $previousPreference }
                if ($LASTEXITCODE -eq 0 -and $found -and (Test-Path -LiteralPath "$found")) { return "$found" }
            }
            $direct = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
            if (Test-Path -LiteralPath $direct) { return $direct }
        }
        'Chrome' {
            foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
                if ($base) {
                    $candidate = Join-Path $base 'Google\Chrome\Application\chrome.exe'
                    if (Test-Path -LiteralPath $candidate) { return $candidate }
                }
            }
        }
        default {
            $exe = if ($Name -eq 'FFmpeg') { 'ffmpeg.exe' } else { 'ollama.exe' }
            $cmd = Get-Command $exe -ErrorAction SilentlyContinue
            if ($cmd) { return $cmd.Source }
        }
    }
    return $null
}

function Install-DubTool {
    param([string]$Name, [string]$PackageId)
    $found = Get-DubTool $Name
    if ($found) { Write-Host "$Name already available."; return $found }
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw 'WinGet is missing. Install/update Microsoft App Installer from the Microsoft Store, then rerun setup: https://aka.ms/getwinget'
    }
    Write-Host "Installing $Name with WinGet ($PackageId). A Windows UAC prompt may appear."
    Invoke-DubCommand $winget.Source @('install', '--id', $PackageId, '--exact', '--source', 'winget',
        '--architecture', 'x64', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
    Update-DubProcessPath
    $found = Get-DubTool $Name
    if (-not $found) { throw "$Name was not found after installation. Restart this installer; check WinGet output if it still fails." }
    return $found
}

function Get-DubNvidiaMemory {
    $cmd = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if (-not $cmd) { return 0 }
    # The current worker uses CUDA device 0. Do not select a different GPU here.
    $free = & $cmd.Source --id=0 --query-gpu=memory.free --format=csv,noheader,nounits 2>$null
    $number = 0
    if ($LASTEXITCODE -eq 0 -and [int]::TryParse(("$free").Trim(), [ref]$number)) { return $number }
    return 0
}

function Get-DubSttChoice {
    param([string]$Device, [int]$FreeMiB)
    if ($Device -eq 'Cuda' -or ($Device -eq 'Auto' -and $FreeMiB -ge 3072)) {
        return @{ Device = 'cuda'; Model = 'large-v3-turbo'; Compute = 'int8_float16' }
    }
    return @{ Device = 'cpu'; Model = 'small'; Compute = 'int8' }
}

function Get-DubEnvValue {
    param([string]$Text, [string]$Key)
    foreach ($line in ($Text -split '\r?\n')) {
        if ($line -match ('^\s*' + [regex]::Escape($Key) + '\s*=(.*)$')) {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return $null
}

function Set-DubEnvText {
    param([string]$Text, [System.Collections.IDictionary]$Values)
    $seen = @{}
    $lines = New-Object 'System.Collections.Generic.List[string]'
    foreach ($line in ($Text -split '\r?\n')) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
            $key = $Matches[1]
            if ($Values.Contains($key)) {
                if (-not $seen.ContainsKey($key)) { $lines.Add("$key=$($Values[$key])"); $seen[$key] = $true }
                continue
            }
        }
        $lines.Add($line)
    }
    foreach ($key in $Values.Keys) {
        if (-not $seen.ContainsKey($key)) { $lines.Add("$key=$($Values[$key])") }
    }
    return (($lines -join "`r`n").TrimEnd("`r", "`n") + "`r`n")
}

function Save-DubEnvironment {
    param([string]$Root, [System.Collections.IDictionary]$Values)
    $path = Join-Path $Root 'backend\.env'
    $exists = Test-Path -LiteralPath $path
    $text = if ($exists) { [IO.File]::ReadAllText($path) } else { [IO.File]::ReadAllText((Join-Path $Root 'backend\.env.example')) }
    $updated = Set-DubEnvText $text $Values
    if ($exists -and $text -eq $updated) { return }
    if ($exists) {
        $backup = Join-Path $Root ('backend\.cache\env-backup-' + [guid]::NewGuid().ToString('N') + '.txt')
        [IO.File]::Copy($path, $backup, $false)
        Write-Host 'Existing settings backed up under backend/.cache. Unrelated settings and keys are preserved.'
    }
    [IO.File]::WriteAllText($path, $updated, (New-Object Text.UTF8Encoding($false)))
}

function Get-DubHealth {
    try { return Invoke-RestMethod 'http://127.0.0.1:18789/api/health' -TimeoutSec 2 } catch { return $null }
}

function Test-DubPort {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync('127.0.0.1', 18789)
        return ($task.Wait(500) -and $client.Connected)
    } catch { return $false } finally { $client.Dispose() }
}

function Stop-DubExistingBackend {
    param([string]$InstallationId)
    if (-not (Test-DubPort)) { return }
    $health = Get-DubHealth
    if (-not $InstallationId -or -not $health -or $health.installationId -ne $InstallationId) {
        throw 'Port 18789 is already in use by an unrecognized server. Stop that server yourself before setup. No process was terminated.'
    }
    Write-Host 'Restarting the backend previously configured by this installer.'
    $null = Invoke-RestMethod 'http://127.0.0.1:18789/api/server/shutdown' -Method Post -TimeoutSec 5
    for ($i = 0; $i -lt 30; $i++) {
        if (-not (Test-DubPort)) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'The existing backend did not stop. Close it before rerunning setup.'
}

function Test-DubReady {
    param($Health, [string]$InstallationId, $Choice)
    return ($Health -and $Health.ok -and $Health.installationId -eq $InstallationId -and
        $Health.provider.translation -eq 'ollama' -and $Health.provider.tts -eq 'supertonic3' -and
        $Health.localTranslation.ready -and $Health.localTranslation.model -eq 'gemma4:e4b-it-q4_K_M' -and
        $Health.supertonic.ready -and $Health.stt.ready -and $Health.stt.model -eq $Choice.Model -and
        $Health.stt.engine -eq "faster-whisper-$($Choice.Device)-$($Choice.Compute)")
}

function Start-DubOllama {
    param([string]$Executable, [string]$Cache)
    $env:OLLAMA_HOST = '127.0.0.1:11434'
    try { $null = Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2; return } catch {}
    $stamp = [guid]::NewGuid().ToString('N')
    $process = Start-Process -FilePath $Executable -ArgumentList 'serve' -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Cache "ollama-$stamp.out.log") -RedirectStandardError (Join-Path $Cache "ollama-$stamp.err.log")
    for ($i = 0; $i -lt 60; $i++) {
        try { $null = Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2; return } catch {}
        if ($process.HasExited) { throw 'Ollama exited before becoming ready. Check backend/.cache/ollama-*.err.log.' }
        Start-Sleep -Seconds 1
    }
    throw 'Ollama did not become ready on 127.0.0.1:11434.'
}

function Start-DubConfiguredBackend {
    param([string]$Root, [string]$Node, [System.Collections.IDictionary]$Values, $Choice)
    if (Test-DubPort) { throw 'Port 18789 became busy during setup. No existing process was terminated.' }
    # Set only this installer process environment; the child receives the exact settings.
    foreach ($key in $Values.Keys) { [Environment]::SetEnvironmentVariable($key, [string]$Values[$key], 'Process') }
    $stamp = [guid]::NewGuid().ToString('N')
    $stdout = Join-Path $Root "backend\.cache\setup-server-$stamp.out.log"
    $stderr = Join-Path $Root "backend\.cache\setup-server-$stamp.err.log"
    $process = Start-Process -FilePath $Node -ArgumentList 'backend/server.js' -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $deadline = [DateTime]::UtcNow.AddMinutes(10)
    $poll = 0
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($process.HasExited) { throw "Backend exited. Inspect $stderr" }
        $health = Get-DubHealth
        if (Test-DubReady $health $Values.YLD_INSTALLATION_ID $Choice) { return }
        if (($poll++ % 5) -eq 0) { Write-Host 'Waiting for Gemma, Supertonic and Whisper to become ready...' }
        Start-Sleep -Seconds 2
    }
    throw "Backend models did not become ready. The server was left running for diagnosis: $stderr"
}

function Install-DubWindows {
    param([string]$Root, [ValidateSet('Auto', 'Cpu', 'Cuda')][string]$Device = 'Auto', [switch]$Plan, [switch]$NoBrowser)
    if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
        throw 'This installer supports Windows x64. ARM64 and other operating systems need separate setup.'
    }
    $Root = [IO.Path]::GetFullPath($Root)
    foreach ($file in @('backend\.env.example', 'backend\server.js', 'extension\manifest.json', 'requirements-stt-fast.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $file))) { throw 'Extract the complete repository ZIP before running the installer.' }
    }
    Update-DubProcessPath
    $packages = [ordered]@{ Node = 'OpenJS.NodeJS.22'; Python = 'Python.Python.3.12'; FFmpeg = 'Gyan.FFmpeg'; Ollama = 'Ollama.Ollama'; Chrome = 'Google.Chrome' }
    if ($Plan) {
        Write-Host 'PLAN ONLY: no installations, downloads, settings writes, or server changes.'
        foreach ($name in $packages.Keys) {
            $found = Get-DubTool $name
            Write-Host ("{0}: {1}" -f $name, $(if ($found) { 'available' } else { "install $($packages[$name])" }))
        }
        Write-Host "Requested STT: $Device. GPU 0 free memory now: $(Get-DubNvidiaMemory) MiB. Auto checks again after warming Gemma."
        Write-Host 'Models: Gemma 4 E4B, Supertonic 3 (1.15x), Whisper large-v3-turbo CUDA or small CPU.'
        Write-Host 'Final manual step: Chrome developer mode -> Load unpacked -> extension folder.'
        return
    }
    $cache = Join-Path $Root 'backend\.cache'
    $null = New-Item -ItemType Directory -Path $cache -Force
    $lock = [IO.File]::Open((Join-Path $cache 'install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $envPath = Join-Path $Root 'backend\.env'
        $existing = if (Test-Path -LiteralPath $envPath) { [IO.File]::ReadAllText($envPath) } else { '' }
        $installationId = Get-DubEnvValue $existing 'YLD_INSTALLATION_ID'
        Stop-DubExistingBackend $installationId
        if (-not $installationId) { $installationId = [guid]::NewGuid().ToString() }
        $resolved = @{}
        foreach ($name in $packages.Keys) { $resolved[$name] = Install-DubTool $name $packages[$name] }
        Invoke-DubCommand $resolved.Node @('scripts/check.js')
        Invoke-DubCommand $resolved.FFmpeg @('-version')
        $python = Join-Path $Root '.venv-win\Scripts\python.exe'
        if (-not (Test-Path -LiteralPath $python)) { Invoke-DubCommand $resolved.Python @('-m', 'venv', (Join-Path $Root '.venv-win')) }
        # Avoid embedded quotes: Windows PowerShell 5.1 strips them in native arguments.
        Invoke-DubCommand $python @('-c', 'import sys; assert sys.version_info[:2] == (3,12) and sys.maxsize > 2**32')
        Invoke-DubCommand $python @('-m', 'pip', 'install', '--upgrade', 'pip')
        Invoke-DubCommand $python @('-m', 'pip', 'install', '-r', (Join-Path $Root 'requirements-tools.txt'), '-r', (Join-Path $Root 'requirements-supertonic.txt'), '-r', (Join-Path $Root 'requirements-stt-fast.txt'))
        Start-DubOllama $resolved.Ollama $cache
        Invoke-DubCommand $resolved.Ollama @('pull', 'gemma4:e4b-it-q4_K_M')
        Write-Host 'Warming Gemma before selecting a Whisper device...'
        $body = @{ model = 'gemma4:e4b-it-q4_K_M'; prompt = 'Ready'; stream = $false; think = $false; keep_alive = '30m'; options = @{ num_ctx = 4096; num_predict = 1 } } | ConvertTo-Json -Depth 3
        $warm = Invoke-RestMethod 'http://127.0.0.1:11434/api/generate' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 600
        if (-not $warm.done -or $warm.error) { throw 'Ollama did not finish loading Gemma. Check Ollama before rerunning setup.' }
        $helper = Join-Path $Root 'scripts\setup-models.py'
        Invoke-DubCommand $python @($helper, 'supertonic')
        $choice = Get-DubSttChoice $Device (Get-DubNvidiaMemory)
        if ($choice.Device -eq 'cuda') {
            try {
                Invoke-DubCommand $python @('-m', 'pip', 'install', '-r', (Join-Path $Root 'requirements-stt-gpu.txt'))
                Invoke-DubCommand $python @($helper, 'stt', '--device', 'cuda')
            } catch {
                if ($Device -eq 'Cuda') { throw }
                Write-Warning 'CUDA installation/inference failed. Auto mode is selecting Whisper small on CPU; downloaded files are kept.'
                $choice = Get-DubSttChoice 'Cpu' 0
                Invoke-DubCommand $python @($helper, 'stt', '--device', 'cpu')
            }
        } else { Invoke-DubCommand $python @($helper, 'stt', '--device', 'cpu') }
        $values = [ordered]@{
            HOST = '127.0.0.1'; PORT = '18789'; TRANSLATION_PROVIDER = 'ollama'; OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
            OLLAMA_MODEL = 'gemma4:e4b-it-q4_K_M'; TTS_PROVIDER = 'supertonic3'; YLD_FAST_STT = '1'
            YLD_STT_MODEL = $choice.Model; YLD_STT_DEVICE = $choice.Device; YLD_STT_COMPUTE = $choice.Compute
            YLD_STT_PYTHON = $python; SUPERTONIC_PYTHON = $python; YLD_INSTALLATION_ID = $installationId
        }
        Save-DubEnvironment $Root $values
        Start-DubConfiguredBackend $Root $resolved.Node $values $choice
        $report = [ordered]@{ completedAt = [DateTime]::UtcNow.ToString('o'); sttDevice = $choice.Device; sttModel = $choice.Model; speechSpeed = 1.15; modelsReady = $true; chromeExtensionLoaded = $false }
        [IO.File]::WriteAllText((Join-Path $cache 'install-result.json'), ($report | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        Write-Host "SETUP COMPLETE: Whisper $($choice.Device), Supertonic 3 at 1.15x. All three models are ready." -ForegroundColor Green
        Write-Host "Chrome: chrome://extensions -> Developer mode -> Load unpacked -> $Root\extension"
        Write-Host 'MP4/web video: http://127.0.0.1:18789/player. Next time, run start-player.cmd.'
        Write-Host 'YouTube: open a video and check Test -> Start -> Stop -> seek.'
        if (-not $NoBrowser) {
            Start-Process -FilePath $resolved.Chrome -ArgumentList 'http://127.0.0.1:18789/player', 'chrome://extensions'
            Start-Process -FilePath explorer.exe -ArgumentList ('"' + (Join-Path $Root 'extension') + '"')
        }
    } finally { $lock.Dispose() }
}
