param(
  [ValidateSet("Chrome","Comet","Edge","Brave","Vivaldi","Opera","Arc","Chromium","All")]
  [string]$Browser = "All",
  [switch]$RemoveManifest
)

$ErrorActionPreference = "Stop"

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
$ManifestPath = Join-Path $PSScriptRoot "$HostName.json"

$targets = if ($Browser -eq "All") { $BrowserRoots.Keys } else { @($Browser) }

foreach ($name in $targets) {
  $RegPath = $BrowserRoots[$name] + "\$HostName"
  if (Test-Path $RegPath) {
    Remove-Item -Path $RegPath -Recurse -Force
    Write-Host "Removed: $RegPath"
  } else {
    Write-Host "Not present: $RegPath"
  }
}

if ($RemoveManifest -and (Test-Path $ManifestPath)) {
  Remove-Item -Path $ManifestPath -Force
  Write-Host "Removed manifest: $ManifestPath"
}

Write-Host "Done. Restart the affected browser(s)."
