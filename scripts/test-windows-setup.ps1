#requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-setup.ps1')
$script:passed = 0
function Assert-DubTest($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Test-DubCase([string]$Name, [scriptblock]$Test) {
    & $Test
    $script:passed++
    Write-Host "PASS: $Name"
}
function Assert-DubThrows([scriptblock]$Action, [string]$Pattern) {
    $caught = $false
    try { & $Action } catch {
        $caught = $true
        Assert-DubTest ($_.Exception.Message -match $Pattern) "Unexpected error: $($_.Exception.Message)"
    }
    Assert-DubTest $caught 'Expected an error, but the action succeeded.'
}
$fixture = Join-Path $env:TEMP ('dub-installer-tests-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixture
Write-Host "Owned fixtures (retained): $fixture"

Test-DubCase 'All installer PowerShell files parse under Windows PowerShell 5.1' {
    foreach ($name in @('windows-setup.ps1', 'install-windows.ps1', 'test-windows-setup.ps1')) {
        $tokens = $null; $problems = $null
        $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name), [ref]$tokens, [ref]$problems)
        Assert-DubTest ($problems.Count -eq 0) "Parser errors in $name"
    }
}
Test-DubCase 'GPU choice uses free memory after Gemma; CPU and forced CUDA work explicitly' {
    Assert-DubTest ((Get-DubSttChoice Auto 0).Device -eq 'cpu') 'No CUDA must use CPU'
    Assert-DubTest ((Get-DubSttChoice Auto 3071).Device -eq 'cpu') 'Low free memory must use CPU'
    Assert-DubTest ((Get-DubSttChoice Auto 3072).Device -eq 'cuda') 'Enough memory should probe CUDA'
    Assert-DubTest ((Get-DubSttChoice Cpu 24000).Model -eq 'small') 'Explicit CPU ignored'
    Assert-DubTest ((Get-DubSttChoice Cuda 0).Device -eq 'cuda') 'Forced CUDA must fail honestly in the probe'
}
Test-DubCase 'Environment update preserves unrelated secrets and removes conflicting duplicates' {
    $old = "# preserved`nOPENAI_API_KEY=dummy-test-only`nTTS_PROVIDER=supertone`nTTS_PROVIDER=mock-wav`n# YLD_STT_DEVICE=cuda`n"
    $values = [ordered]@{ TTS_PROVIDER = 'supertonic3'; YLD_STT_DEVICE = 'cpu' }
    $new = Set-DubEnvText $old $values
    Assert-DubTest ($new.Contains('OPENAI_API_KEY=dummy-test-only')) 'Unrelated value lost'
    Assert-DubTest (([regex]::Matches($new, '(?m)^TTS_PROVIDER=')).Count -eq 1) 'Duplicate provider survived'
    Assert-DubTest ((Get-DubEnvValue $new 'TTS_PROVIDER') -eq 'supertonic3') 'Provider not updated'
    Assert-DubTest ((Set-DubEnvText $new $values) -ceq $new) 'Repeated update is not idempotent'
}
Test-DubCase 'Existing environment is backed up exactly once and written as UTF-8 without BOM' {
    $root = Join-Path $fixture 'settings'
    $null = New-Item -ItemType Directory -Path (Join-Path $root 'backend\.cache') -Force
    $path = Join-Path $root 'backend\.env'
    [IO.File]::WriteAllText($path, 'TTS_PROVIDER=supertone', (New-Object Text.UTF8Encoding($false)))
    $values = [ordered]@{ TTS_PROVIDER = 'supertonic3' }
    Save-DubEnvironment $root $values
    Save-DubEnvironment $root $values
    $backups = @(Get-ChildItem -LiteralPath (Join-Path $root 'backend\.cache') -Filter 'env-backup-*.txt')
    Assert-DubTest ($backups.Count -eq 1) 'Backup duplicated on unchanged rerun'
    Assert-DubTest ([IO.File]::ReadAllText($backups[0].FullName) -ceq 'TTS_PROVIDER=supertone') 'Backup changed original data'
    Assert-DubTest ([IO.File]::ReadAllBytes($path)[0] -eq [byte][char]'T') 'UTF-8 BOM unexpectedly added'
}
Test-DubCase 'Failed child commands cannot be treated as success' {
    Assert-DubThrows { Invoke-DubCommand $env:ComSpec @('/c', 'exit', '7') } 'exit 7'
}
Test-DubCase 'HTTP OK alone, wrong instance, wrong device and unready models cannot pass readiness' {
    $choice = Get-DubSttChoice Cpu 0
    Assert-DubTest (-not (Test-DubReady @{ ok = $true } 'fixture' $choice)) 'HTTP-only response passed'
    $health = @{ ok = $true; installationId = 'fixture'; provider = @{ translation = 'ollama'; tts = 'supertonic3' }
        localTranslation = @{ ready = $true; model = 'gemma4:e4b-it-q4_K_M' }; supertonic = @{ ready = $true }
        stt = @{ ready = $true; model = 'small'; engine = 'faster-whisper-cpu-int8' } }
    Assert-DubTest (Test-DubReady $health 'fixture' $choice) 'Correct health rejected'
    Assert-DubTest (-not (Test-DubReady $health 'other' $choice)) 'Wrong server passed'
    Assert-DubTest (-not (Test-DubReady $health 'fixture' (Get-DubSttChoice Cuda 8192))) 'Wrong STT passed'
    $health.supertonic.ready = $false
    Assert-DubTest (-not (Test-DubReady $health 'fixture' $choice)) 'Unready TTS passed'
}

# From here all external work is intercepted. No package installs, network, models or real processes.
$originalStop = ${function:Stop-DubExistingBackend}
function Test-DubPort { return $true }
function Get-DubHealth { return @{ ok = $true; installationId = 'someone-else' } }
function Invoke-RestMethod { throw 'Unexpected network call in ownership test' }
Test-DubCase 'An occupied port owned by another installation is never shut down' {
    Assert-DubThrows { & $originalStop 'ours' } 'unrecognized server'
    Assert-DubThrows { & $originalStop '' } 'unrecognized server'
}

function New-DubFixtureRoot([string]$Name) {
    $root = Join-Path $fixture $Name
    foreach ($dir in @('backend', 'extension', 'scripts')) { $null = New-Item -ItemType Directory -Path (Join-Path $root $dir) -Force }
    foreach ($file in @('backend\server.js', 'extension\manifest.json', 'requirements-stt-fast.txt')) { [IO.File]::WriteAllText((Join-Path $root $file), '') }
    [IO.File]::WriteAllText((Join-Path $root 'backend\.env.example'), "TTS_PROVIDER=supertone`nOPENAI_API_KEY=`n")
    return $root
}
function Stop-DubExistingBackend { param($InstallationId) }
function Install-DubTool { param($Name, $PackageId); return "fixture-$Name.exe" }
function Start-DubOllama { param($Executable, $Cache) }
function Get-DubNvidiaMemory { return $script:freeMiB }
function Invoke-RestMethod { param($Uri, $Method, $ContentType, $Body, $TimeoutSec); return @{ done = $true } }
function Invoke-DubCommand {
    param($Executable, $Arguments)
    $script:commands.Add(($Arguments -join ' '))
    if ($script:failPip -and $Arguments -contains 'pip') { throw 'Fixture package install failure' }
    if ($script:failCuda -and $Arguments -contains 'cuda') { throw 'Fixture CUDA inference failure' }
}
function Start-DubConfiguredBackend {
    param($Root, $Node, $Values, $Choice)
    $script:started = $Choice
    if ($script:failReady) { throw 'Fixture models did not become ready' }
}
function Reset-DubFixture {
    $script:commands = New-Object 'System.Collections.Generic.List[string]'
    $script:started = $null; $script:failCuda = $false; $script:failPip = $false; $script:failReady = $false
    $script:freeMiB = 4096
}
Test-DubCase 'Full CPU installation prepares models and writes local settings before starting server' {
    Reset-DubFixture
    $script:freeMiB = 0
    $root = New-DubFixtureRoot 'CPU path with spaces'
    Install-DubWindows $root -NoBrowser
    $result = Get-Content -Raw -LiteralPath (Join-Path $root 'backend\.cache\install-result.json') | ConvertFrom-Json
    Assert-DubTest ($result.modelsReady -and $result.speechSpeed -eq 1.15 -and $result.sttDevice -eq 'cpu') 'CPU result incorrect'
    Assert-DubTest ($script:started.Model -eq 'small') 'CPU model incorrect'
    Assert-DubTest (@($script:commands | Where-Object { $_ -match 'requirements-stt-gpu' }).Count -eq 0) 'CPU installed GPU dependencies'
    Assert-DubTest (@($script:commands | Where-Object { $_ -match 'pull gemma4:' }).Count -eq 1) 'Gemma not downloaded'
}
Test-DubCase 'Successful CUDA probe keeps the GPU path' {
    Reset-DubFixture
    Install-DubWindows (New-DubFixtureRoot 'CUDA') -NoBrowser
    Assert-DubTest ($script:started.Device -eq 'cuda') 'CUDA not selected'
}
Test-DubCase 'Auto recovers from CUDA inference failure using CPU and preserves downloaded files' {
    Reset-DubFixture
    $script:failCuda = $true
    Install-DubWindows (New-DubFixtureRoot 'GPU fallback') -NoBrowser
    Assert-DubTest ($script:started.Device -eq 'cpu') 'No CPU fallback'
    Assert-DubTest (@($script:commands | Where-Object { $_ -match 'stt --device cpu' }).Count -eq 1) 'CPU smoke not run'
}
Test-DubCase 'Forced CUDA fails instead of silently switching or marking setup complete' {
    Reset-DubFixture
    $script:failCuda = $true
    $root = New-DubFixtureRoot 'Forced GPU failure'
    Assert-DubThrows { Install-DubWindows $root -Device Cuda -NoBrowser } 'CUDA inference failure'
    Assert-DubTest (-not (Test-Path -LiteralPath (Join-Path $root 'backend\.env'))) 'Settings written after failed forced CUDA'
    Assert-DubTest (-not $script:started) 'Server started after failure'
}
Test-DubCase 'Package failure prevents model downloads and server start' {
    Reset-DubFixture
    $script:failPip = $true
    $root = New-DubFixtureRoot 'Package failure'
    Assert-DubThrows { Install-DubWindows $root -NoBrowser } 'package install failure'
    Assert-DubTest (-not $script:started) 'Server started after failed dependency installation'
    Assert-DubTest (@($script:commands | Where-Object { $_ -match 'pull gemma4:' }).Count -eq 0) 'Models downloaded after dependency failure'
}
Test-DubCase 'Unready backend cannot write a successful install result' {
    Reset-DubFixture
    $script:failReady = $true
    $root = New-DubFixtureRoot 'Not ready'
    Assert-DubThrows { Install-DubWindows $root -NoBrowser } 'not become ready'
    Assert-DubTest (-not (Test-Path -LiteralPath (Join-Path $root 'backend\.cache\install-result.json'))) 'False success record'
}
Write-Host "PASS: $script:passed installer tests. External actions were mocked; no second-PC installation was performed."
