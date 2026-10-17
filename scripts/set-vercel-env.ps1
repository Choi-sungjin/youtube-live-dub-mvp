param(
  [string[]] $Targets = @('production', 'preview')
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $Root

function Read-DotEnv {
  param([string] $Path)

  $vars = @{}
  if (-not (Test-Path -LiteralPath $Path)) {
    return $vars
  }

  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#') -or -not $line.Contains('=')) {
      return
    }

    $separator = $line.IndexOf('=')
    $key = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim()
    $value = $value.Trim('"').Trim("'")
    if ($key) {
      $vars[$key] = $value
    }
  }

  return $vars
}

$fileVars = Read-DotEnv -Path (Join-Path $Root 'backend\.env')

$desired = [ordered]@{
  TRANSLATION_PROVIDER = 'zai'
  ZAI_MODEL = 'glm-4.7'
  ZAI_API_KEY = $fileVars['ZAI_API_KEY']
  TTS_PROVIDER = 'supertone'
  SUPERTONE_API_KEY = $fileVars['SUPERTONE_API_KEY']
  SUPERTONE_MODEL = 'sona_speech_2'
  SUPERTONE_OUTPUT_FORMAT = 'mp3'
  SUPERTONE_DEFAULT_VOICE_ID = '763d5f200a9f5808056733'
  SUPERTONE_PITCH_SHIFT = '0'
  SUPERTONE_PITCH_VARIANCE = '1.5'
  SUPERTONE_SPEED = '1.29'
}

$secretKeys = @('ZAI_API_KEY', 'SUPERTONE_API_KEY')

foreach ($key in $desired.Keys) {
  $value = [string] $desired[$key]
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing value for $key. Check backend\.env or edit scripts\set-vercel-env.ps1."
  }

  foreach ($target in $Targets) {
    $args = @('env', 'add', $key, $target, '--force', '--yes', '--value', $value)
    if ($secretKeys -contains $key) {
      $args += '--sensitive'
    } else {
      $args += '--no-sensitive'
    }

    Write-Host "Setting $key for $target"
    & vercel @args
  }
}

Write-Host 'Done setting Vercel environment variables.'
