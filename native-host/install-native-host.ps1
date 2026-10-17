param(
  [string]$ExtensionId,
  [ValidateSet("Chrome","Comet","Edge","Brave","Vivaldi","Opera","Arc","Chromium")]
  [string]$Browser = "Chrome"
)

$ErrorActionPreference = "Stop"

if (-not $ExtensionId) {
  Write-Host "Extension ID is required."
  Write-Host ""
  Write-Host "How to find it:"
  Write-Host "  1. Open chrome://extensions in $Browser"
  Write-Host "  2. Enable Developer mode (top right)"
  Write-Host "  3. Find 'YouTube Live Dub MVP' and copy the 32-char ID"
  Write-Host ""
  Write-Host "Then run:"
  Write-Host "  .\install-native-host.ps1 -ExtensionId `"your_extension_id`" -Browser $Browser"
  exit 1
}

if ($ExtensionId -notmatch '^[a-p]{32}$') {
  Write-Host "Extension ID '$ExtensionId' does not look valid (expected 32 lowercase letters a-p)."
  exit 1
}

# Per-browser native messaging registry root. Each Chromium-based browser uses
# its own subtree, even though the JSON manifest format is identical.
$BrowserRoots = @{
  "Chrome"   = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"
  "Comet"    = "HKCU:\Software\Perplexity\Comet\NativeMessagingHosts"
  "Edge"     = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
  "Brave"    = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts"
  "Vivaldi"  = "HKCU:\Software\Vivaldi\NativeMessagingHosts"
  "Opera"    = "HKCU:\Software\Opera Software\Opera Stable\NativeMessagingHosts"
  "Arc"      = "HKCU:\Software\ArcBrowser\Arc\NativeMessagingHosts"
  "Chromium" = "HKCU:\Software\Chromium\NativeMessagingHosts"
}

$HostName = "com.youtube_live_dub.backend"
$HostCmd = Join-Path $PSScriptRoot "yld-native-host.cmd"
$ManifestPath = Join-Path $PSScriptRoot "$HostName.json"

if (-not (Test-Path $HostCmd)) {
  Write-Host "Could not find $HostCmd."
  exit 1
}

$manifest = [ordered]@{
  name = $HostName
  description = "YouTube Live Dub local backend controller"
  path = $HostCmd
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

# Use UTF-8 without BOM. ConvertTo-Json + Set-Content -Encoding ASCII corrupts
# non-ASCII path characters (e.g. Korean usernames) into '?'.
$json = $manifest | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ManifestPath, $json, $utf8NoBom)

$RegPath = $BrowserRoots[$Browser] + "\$HostName"
New-Item -Path $RegPath -Force | Out-Null
Set-Item -Path $RegPath -Value $ManifestPath

Write-Host "Installed Native Messaging host for $Browser : $HostName"
Write-Host "  Registry:     $RegPath"
Write-Host "  Manifest:     $ManifestPath"
Write-Host "  Extension ID: $ExtensionId"
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Fully quit $Browser (close all windows)."
Write-Host "  2. Reopen $Browser and reload the extension."
Write-Host "  3. On a YouTube watch page, open the panel and click Test."
