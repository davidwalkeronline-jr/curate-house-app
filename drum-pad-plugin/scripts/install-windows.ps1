# Installs Curate Drum Pad on Windows.
# Right click this file and choose "Run with PowerShell". It asks for administrator
# rights because the Pro Tools plugin folder is under Program Files.

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

Set-Location $PSScriptRoot

$aaxDir  = Join-Path $env:CommonProgramFiles "Avid\Audio\Plug-Ins"
$vst3Dir = Join-Path $env:CommonProgramFiles "VST3"

function Install-Bundle($name, $dest) {
    if (-not (Test-Path $name)) { return }
    Write-Host "Installing $name to $dest"
    New-Item -ItemType Directory -Force $dest | Out-Null
    $target = Join-Path $dest $name
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Copy-Item -Recurse $name $dest
}

Install-Bundle "Curate Drum Pad.aaxplugin" $aaxDir
Install-Bundle "Curate Drum Pad.vst3" $vst3Dir

Write-Host ""
Write-Host "Done. Restart Pro Tools, then insert Curate Drum Pad on an Instrument track."
Read-Host "Press Enter to close"
