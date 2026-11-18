# Per-user Nightgrass install. Silent unless -InstallDir is passed.
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Nightgrass")
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture

$payloadName = if ($arch -eq [System.Runtime.InteropServices.Architecture]::Arm64) {
    "Nightgrass-arm64.exe"
} else {
    "Nightgrass-x64.exe"
}

$payload = Join-Path $here $payloadName
if (-not (Test-Path -LiteralPath $payload)) {
    throw "Nightgrass has no $payloadName payload for OS architecture $arch."
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$dest = Join-Path $InstallDir "Nightgrass.exe"
Copy-Item -LiteralPath $payload -Destination $dest -Force

$programs = [Environment]::GetFolderPath("Programs")
$shortcut = Join-Path $programs "Nightgrass.lnk"
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = $dest
$link.WorkingDirectory = $InstallDir
$link.WindowStyle = 1
$link.Description = "Nightgrass"
$link.Save()

Write-Output "architecture=$arch"
Write-Output "payload=$payloadName"
Write-Output "installed=$dest"
Write-Output "shortcut=$shortcut"
