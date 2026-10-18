#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Auto', 'Cpu', 'Cuda')][string]$Device = 'Auto',
    [switch]$Plan,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-setup.ps1')
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    Install-DubWindows -Root (Split-Path -Parent $PSScriptRoot) -Device $Device -Plan:$Plan -NoBrowser:$NoBrowser
} catch {
    Write-Host "SETUP FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'No files or models were deleted. Fix the reported issue and run install-windows.cmd again.'
    exit 1
} finally { Pop-Location }
